/**
 * Import from a device another system managed, and the cut-over (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md
 * §15 Phase 4, §3, §6.3, §7.5). Built for gyms leaving GymBioSync without a gap at the door.
 *
 * GymBioSync puts the old system's CustomerID on the device as the PIN (GymBiosyncService
 * BioMetric.cs:246), with no validity window. Those PINs are another system's numbers: one may equal a
 * GymsEra PIN of a different person. So, until the host goes live:
 *
 *   hold      access_device_details.import_hold: the device gets only DATA QUERY / COUNT / INFO / CHECK
 *             (device-registry#claimCommands); reconcile, the sweep, the audit and Push now skip it
 *             (device-sync#devicesOf); what it uploads on its own is not stored as member data, and a scan
 *             is a member only through this import's applied match. Its users keep their access as they
 *             are: no gap.
 *   query     DATA QUERY user, then biodata of each type (Type in every filter, manual 9.1.4), in packs;
 *             size caps; templates stored encrypted in staging (device_import_templates).
 *   match     CSV (pin + member_id / email / phone) or one by one. Conflicts: the PIN belongs to another
 *             GymsEra member (pin_taken), the member already has another PIN (member_has_pin). A conflict
 *             blocks apply unless the device user is marked "remove at go-live". Device admins
 *             (privilege above 0) are never imported and never removed.
 *   apply     the member takes the device PIN when they have none and nobody else has it (the PIN is kept);
 *             templates go to member_biometrics with the consent rules, held (import_hold) until go-live;
 *             a slot the member already has in GymsEra is kept as is; the PIN sequence moves past every
 *             device PIN; the staging copies are emptied. Idempotent.
 *   rollback  before go-live only: what apply stored goes (templates, PINs it gave); nothing on the device.
 *   go-live   held templates released (pending ones get their 7 days from now), only the rows marked
 *             "remove" are deleted from the device, the hold ends, every matched member is reconciled, an
 *             audit is asked (it removes matched members GymsEra does not admit, and lists the rest).
 *
 * Nothing here logs or returns a template. `db` = a tenant connection { sequelize, models, tenantId }.
 */
const { utc } = require('./sql-time');
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { getDeviceConfig } = require('../../config/devices.config');
const { createError } = require('../../utils/response.utils');
const bioCrypto = require('../../utils/biometric-crypto');
const protocol = require('./push-protocol');
const rules = require('./sync-rules');

const select = (db, sql, replacements, transaction) => db.sequelize.query(sql, { replacements: utc(replacements), type: QueryTypes.SELECT, transaction });
const exec = (db, sql, replacements, transaction) => db.sequelize.query(sql, { replacements: utc(replacements), transaction });
const affected = (meta) => (typeof meta === 'number' ? meta : meta?.affectedRows || 0);
const parse = (text, fallback = null) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch (_) {
    return fallback;
  }
};
const newImportId = () => require('./device-push.service').newRequestId();
const PIN = /^\d{1,9}$/;
const OPEN = ['querying', 'ready'];
const QUERY_KINDS = ['query_users', 'query_bio'];
const EMPTY_ANSWER_SECONDS = 60; // a query acked with no pack after this long had nothing to send
const STALE_READY_DAYS = 7;
const MAX_CSV_BYTES = 1024 * 1024;
const MAX_CSV_LINES = 20000;
const isAdmin = (row) => Number(row.privilege) > 0;

// ── Rows ──────────────────────────────────────────────────────────────────────
async function latestImport(db, deviceId) {
  const [row] = await select(db, 'SELECT * FROM device_imports WHERE device_id = ? ORDER BY started_at DESC, id DESC LIMIT 1', [deviceId]);
  return row || null;
}

async function importOf(db, deviceId, importId) {
  const [row] = await select(db, 'SELECT * FROM device_imports WHERE id = ? AND device_id = ?', [importId, deviceId]);
  if (!row) throw createError('Import not found.', 404, 'import_not_found');
  return refresh(db, row);
}

async function detailsOf(db, deviceId) {
  const [d] = await select(db, 'SELECT * FROM access_device_details WHERE id = ?', [deviceId]);
  return d || null;
}

/** The device's command id belongs to an import's query. → the import id, or null. */
async function isImportCommand(db, deviceId, cmdId) {
  const [cmd] = await select(db, 'SELECT kind, args_json FROM device_commands WHERE id = ? AND device_id = ?', [cmdId, deviceId]);
  if (!cmd || !QUERY_KINDS.includes(cmd.kind)) return null;
  return parse(cmd.args_json, {})?.importId || null;
}

// ── Start (query the device) ──────────────────────────────────────────────────
async function queueQuery(db, deviceId, kind, args, now) {
  await exec(db, `INSERT INTO device_commands (device_id, kind, args_json, priority, status, attempts, not_before, created_at, updated_at)
    VALUES (?, ?, ?, 0, 'queued', 0, ?, ?, ?)`, [deviceId, kind, JSON.stringify(args), new Date(now.getTime() - 1000), now, now]);
  const [row] = await select(db, 'SELECT id FROM device_commands WHERE device_id = ? AND kind = ? ORDER BY id DESC LIMIT 1', [deviceId, kind]);
  return Number(row.id);
}

/**
 * Starts (or returns the open) import of a device: puts it in hold, queues the queries.
 * → { import, reused }
 */
async function startImport(db, { tenantId, deviceId, byUserId = null, now = new Date(), ...opts }) {
  const registry = require('./device-registry.service');
  const platform = await registry.findById(deviceId);
  if (!platform || platform.tenant_id !== tenantId || platform.status === 'removed') throw createError('Device not found.', 404, 'device_not_found');
  if (platform.status === 'wiping') throw createError('This device is being wiped.', 409, 'device_wiping');
  if (platform.status !== 'active') {
    throw createError('The device has not connected yet. Type the server address on it first, then import.', 409, 'device_not_connected');
  }
  const det = await detailsOf(db, deviceId);
  if (!det || !Number(det.enabled)) throw createError('Turn the device on first.', 409, 'device_disabled');

  const last = await latestImport(db, deviceId);
  if (last) {
    const cur = await refresh(db, last, now);
    if (OPEN.includes(cur.status)) return { import: await viewOf(db, cur), reused: true };
    if (cur.status === 'applied') {
      throw createError('The last import is applied but not live. Go live or roll it back first.', 409, 'import_applied_not_live');
    }
  }

  // Hold: from now on the device only answers queries. Anything queued for it that would change it waits
  // for go-live, which plans the device afresh (so it is superseded here).
  await exec(db, 'UPDATE access_device_details SET import_hold = 1, import_hold_since = COALESCE(import_hold_since, ?), updated_at = ? WHERE id = ?', [now, now, deviceId]);
  await exec(db, 'UPDATE device_commands SET status = \'superseded\', updated_at = ? WHERE device_id = ? AND status = \'queued\' AND kind NOT IN (?)',
    [now, deviceId, registry.READ_ONLY_KINDS]);

  const id = newImportId();
  const caps = parse(det.capabilities_json, {}) || {};
  const reported = [...rules.bioSupport(caps).types].sort((a, b) => a - b);
  const types = reported.length ? reported : getDeviceConfig().importBioTypes;
  // Matches of the previous import of this device are carried over (a re-run keeps the work done).
  const carryFrom = last && last.status !== 'querying' ? last.id : null;
  let cmdIds;
  let result;
  if (String(det.device_type || '').toLowerCase() === 'att') {
    // Phase 5, T&A PUSH: the device uploads its users (OPERLOG USER), fingerprints (OPERLOG FP) and faces
    // (BIODATA) on its own, on first contact; DATA QUERY is not known to work on that firmware. The import is fed
    // by those uploads (stageUploads). CHECK (read-only) asks a device that already sent them to send again.
    cmdIds = [];
    if (opts.askDevice !== false) await queueQuery(db, deviceId, 'check', { importId: id }, now);
    result = { carryFrom, types, mode: 'upload', uploads: { users: 0, templates: 0, lastAt: null } };
  } else {
    cmdIds = [await queueQuery(db, deviceId, 'query_users', { importId: id }, now)];
    for (const type of types) cmdIds.push(await queueQuery(db, deviceId, 'query_bio', { importId: id, type }, now));
    result = { carryFrom, types };
  }
  await exec(db, `INSERT INTO device_imports (id, device_id, status, requested_by, query_cmd_ids_json, result_json, started_at, updated_at)
    VALUES (?, ?, 'querying', ?, ?, ?, ?, ?)`, [id, deviceId, byUserId, JSON.stringify(cmdIds), JSON.stringify(result), now, now]);
  if (carryFrom) {
    // Mark the old one superseded so only one import of the device is open.
    if (OPEN.includes(last.status)) await exec(db, 'UPDATE device_imports SET status = \'cancelled\', finished_at = ?, updated_at = ? WHERE id = ?', [now, now, last.id]);
  }
  const [row] = await select(db, 'SELECT * FROM device_imports WHERE id = ?', [id]);
  return { import: await viewOf(db, row), reused: false };
}

// ── Query answers (packs) ─────────────────────────────────────────────────────
/** One querydata pack of an import's query. Replays are ignored. → { stored } */
async function ingestPack(db, device, { cmdId, table, query, body, now = new Date() }) {
  const importId = await isImportCommand(db, device.id, cmdId);
  const [imp] = await select(db, 'SELECT * FROM device_imports WHERE id = ? AND device_id = ?', [importId, device.id]);
  if (!imp || imp.status !== 'querying') return { stored: 0 };
  const int = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const packcnt = int(query.packcnt, 1);
  const packidx = int(query.packidx, 1);
  const [, meta] = await exec(db, 'INSERT IGNORE INTO device_import_packs (import_id, cmd_id, pack_idx, pack_cnt, records, received_at) VALUES (?, ?, ?, ?, 0, ?)',
    [imp.id, cmdId, packidx, packcnt, now]);
  if (affected(meta) !== 1) return { stored: 0 }; // the same pack again

  let res = { stored: 0, truncated: false };
  if (table === 'user') res = await stageUsers(db, imp, protocol.parseRecords(body, { table: 'user' }), now);
  else if (table === 'biodata') res = await stageTemplates(db, imp, rules.templatesFrom('biodata', body), now);
  await exec(db, 'UPDATE device_import_packs SET records = ? WHERE import_id = ? AND cmd_id = ? AND pack_idx = ?', [res.stored, imp.id, cmdId, packidx]);
  await refresh(db, { ...imp }, now);
  return { stored: res.stored };
}

/** Device users into an import's staging (a query pack or an att upload). rows: { pin, name, cardno, privilege } */
async function stageUsers(db, imp, rows, now) {
  const cfg = getDeviceConfig();
  const carry = parse(imp.result_json, {})?.carryFrom || null;
  const [{ n }] = await select(db, 'SELECT COUNT(*) AS n FROM device_import_users WHERE import_id = ?', [imp.id]);
  let count = Number(n);
  let stored = 0;
  let truncated = false;
  for (const r of rows) {
    const pin = String(r.pin || '').trim();
    if (!PIN.test(pin)) continue;
    if (count >= cfg.importMaxUsers) { truncated = true; break; }
    const [prev] = carry ? await select(db, 'SELECT member_id, remove_at_go_live FROM device_import_users WHERE import_id = ? AND pin = ?', [carry, pin]) : [];
    const [, m] = await exec(db, `INSERT IGNORE INTO device_import_users (import_id, pin, name, card_no, privilege, member_id, match_source, remove_at_go_live, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      imp.id, pin, r.name ? String(r.name).slice(0, 24) : null, r.cardno && r.cardno !== '0' ? String(r.cardno).replace(/\s+/g, '').slice(0, 32) : null,
      Math.min(255, Math.max(0, Number(r.privilege) || 0)), prev?.member_id || null, prev?.member_id ? 'carried' : null, prev ? Number(prev.remove_at_go_live) : 0, now, now,
    ]);
    if (affected(m) === 1) { stored += 1; count += 1; }
  }
  if (truncated) await exec(db, 'UPDATE device_imports SET truncated = 1 WHERE id = ?', [imp.id]);
  return { stored, truncated };
}

/** Templates (rules.templatesFrom / templatesFromOperlog records) into an import's staging, encrypted. */
async function stageTemplates(db, imp, records, now) {
  const cfg = getDeviceConfig();
  const [{ n }] = await select(db, 'SELECT COUNT(*) AS n FROM device_import_templates WHERE import_id = ?', [imp.id]);
  let count = Number(n);
  let stored = 0;
  let tooLarge = 0;
  let truncated = false;
  for (const t of records) {
    if (t.tmp.length > cfg.importMaxTemplateBytes) { tooLarge += 1; continue; }
    if (count >= cfg.importMaxTemplates) { truncated = true; break; }
    const enc = bioCrypto.encrypt(t.tmp);
    const [, m] = await exec(db, `INSERT IGNORE INTO device_import_templates (import_id, pin, bio_type, bio_no, bio_index, major_ver, minor_ver, format, duress, valid,
        template_enc, key_version, template_sha256, template_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      imp.id, String(t.pin), t.type, t.no || 0, t.index || 0, String(t.majorVer).slice(0, 8), String(t.minorVer).slice(0, 8), t.format || 0,
      t.duress ? 1 : 0, t.valid === 0 ? 0 : 1, enc, bioCrypto.versionOf(enc), bioCrypto.sha256(t.tmp), t.tmp.length, now,
    ]);
    if (affected(m) === 1) { stored += 1; count += 1; }
  }
  if (tooLarge) await exec(db, 'UPDATE device_imports SET templates_too_large = templates_too_large + ? WHERE id = ?', [tooLarge, imp.id]);
  if (truncated) await exec(db, 'UPDATE device_imports SET truncated = 1 WHERE id = ?', [imp.id]);
  return { stored, truncated };
}

/**
 * Phase 5: users and templates a T&A PUSH device in import hold uploaded on its own (OPERLOG / BIODATA), into
 * its open import (querying, or ready and not applied yet). No open import: dropped, as in Phase 4. Replays
 * add nothing. → { stored } or null
 */
async function stageUploads(db, deviceId, { users = [], templates = [] }, now = new Date()) {
  const [imp] = await select(db, 'SELECT * FROM device_imports WHERE device_id = ? AND status IN (?) ORDER BY started_at DESC LIMIT 1', [deviceId, OPEN]);
  if (!imp) return null;
  const u = users.length ? await stageUsers(db, imp, users, now) : { stored: 0 };
  const t = templates.length ? await stageTemplates(db, imp, templates, now) : { stored: 0 };
  const result = parse(imp.result_json, {}) || {};
  const up = result.uploads || { users: 0, templates: 0, lastAt: null };
  result.uploads = { users: up.users + u.stored, templates: up.templates + t.stored, lastAt: now.toISOString() };
  const [{ users: nu }] = await select(db, 'SELECT COUNT(*) AS users FROM device_import_users WHERE import_id = ?', [imp.id]);
  const [{ templates: nt }] = await select(db, 'SELECT COUNT(*) AS templates FROM device_import_templates WHERE import_id = ?', [imp.id]);
  await exec(db, 'UPDATE device_imports SET result_json = ?, users_count = ?, templates_count = ?, updated_at = ? WHERE id = ?', [JSON.stringify(result), nu, nt, now, imp.id]);
  return { stored: u.stored + t.stored };
}

/**
 * A querying import becomes ready when every query is answered: all its packs arrived, it failed on the
 * device (that type is skipped and noted), or it was acked and sent nothing for a minute. One whose
 * answers never come fails after DEVICE_IMPORT_QUERY_HOURS. → the fresh row
 */
async function refresh(db, row, now = new Date()) {
  if (row.status !== 'querying') return row;
  const mode = parse(row.result_json, {})?.mode;
  if (mode === 'upload') return refreshUpload(db, row, now);
  const cmdIds = parse(row.query_cmd_ids_json, []) || [];
  const cmds = cmdIds.length ? await select(db, 'SELECT id, kind, status, args_json, acked_at FROM device_commands WHERE id IN (?) AND device_id = ?', [cmdIds, row.device_id]) : [];
  const packs = await select(db, 'SELECT cmd_id, COUNT(*) AS got, MAX(pack_cnt) AS want FROM device_import_packs WHERE import_id = ? GROUP BY cmd_id', [row.id]);
  const byCmd = new Map(packs.map((p) => [Number(p.cmd_id), p]));
  const failedQueries = [];
  let done = cmds.length === cmdIds.length && cmds.length > 0;
  for (const c of cmds) {
    const p = byCmd.get(Number(c.id));
    if (p && Number(p.got) >= Number(p.want)) continue;
    if (c.status === 'failed' || c.status === 'expired' || c.status === 'superseded') {
      failedQueries.push({ kind: c.kind, type: parse(c.args_json, {})?.type ?? null });
      continue;
    }
    if (!p && c.status === 'acked' && c.acked_at && now.getTime() - new Date(c.acked_at).getTime() >= EMPTY_ANSWER_SECONDS * 1000) continue;
    done = false;
  }
  const [{ users }] = await select(db, 'SELECT COUNT(*) AS users FROM device_import_users WHERE import_id = ?', [row.id]);
  const [{ templates }] = await select(db, 'SELECT COUNT(*) AS templates FROM device_import_templates WHERE import_id = ?', [row.id]);
  const result = { ...(parse(row.result_json, {}) || {}), failedQueries };
  if (done && failedQueries.some((f) => f.kind === 'query_users')) {
    await exec(db, 'UPDATE device_imports SET status = \'failed\', users_count = ?, templates_count = ?, result_json = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = \'querying\'',
      [users, templates, JSON.stringify({ ...result, reason: 'user_query_failed' }), now, now, row.id]);
  } else if (done) {
    await exec(db, 'UPDATE device_imports SET status = \'ready\', users_count = ?, templates_count = ?, result_json = ?, ready_at = ?, updated_at = ? WHERE id = ? AND status = \'querying\'',
      [users, templates, JSON.stringify(result), now, now, row.id]);
  } else if (new Date(row.started_at).getTime() < now.getTime() - getDeviceConfig().importQueryHours * 3600000) {
    await exec(db, 'UPDATE device_imports SET status = \'failed\', result_json = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = \'querying\'',
      [JSON.stringify({ ...result, reason: 'no_answer' }), now, now, row.id]);
  } else {
    await exec(db, 'UPDATE device_imports SET users_count = ?, templates_count = ? WHERE id = ?', [users, templates, row.id]);
  }
  const [fresh] = await select(db, 'SELECT * FROM device_imports WHERE id = ?', [row.id]);
  return fresh;
}

/**
 * Phase 5, an import fed by a T&A PUSH device's uploads: ready once users arrived, nothing more came for
 * ATT_QUIET_SECONDS and the device polled since (it polls only when its upload is done: the capture showed
 * no poll during the 2.5-minute history upload). Failed when no user arrived within DEVICE_IMPORT_QUERY_HOURS.
 */
const ATT_QUIET_SECONDS = 60;
async function refreshUpload(db, row, now) {
  const result = parse(row.result_json, {}) || {};
  const lastAt = result.uploads?.lastAt ? new Date(result.uploads.lastAt) : null;
  const [{ users }] = await select(db, 'SELECT COUNT(*) AS users FROM device_import_users WHERE import_id = ?', [row.id]);
  const [{ templates }] = await select(db, 'SELECT COUNT(*) AS templates FROM device_import_templates WHERE import_id = ?', [row.id]);
  const [det] = await select(db, 'SELECT last_poll_at FROM access_device_details WHERE id = ?', [row.device_id]);
  // last_poll_at is a DATETIME (whole seconds): compare against the second of the last upload.
  const polled = det?.last_poll_at && lastAt && new Date(det.last_poll_at).getTime() >= Math.floor(lastAt.getTime() / 1000) * 1000;
  // NEW-242: after a re-read, ready only once the device has uploaded again; nothing within
  // DEVICE_IMPORT_QUERY_HOURS → ready as it was, marked no_upload (the users it already sent stay).
  const rereadAt = result.reread?.requestedAt ? new Date(result.reread.requestedAt) : null;
  const uploadedSince = !rereadAt || (lastAt && lastAt.getTime() >= rereadAt.getTime());
  if (Number(users) > 0 && lastAt && polled && uploadedSince && now.getTime() - lastAt.getTime() >= ATT_QUIET_SECONDS * 1000) {
    const [, m] = await exec(db, 'UPDATE device_imports SET status = \'ready\', users_count = ?, templates_count = ?, ready_at = ?, updated_at = ? WHERE id = ? AND status = \'querying\'',
      [users, templates, now, now, row.id]);
    if (rereadAt && affected(m) === 1) await rereadDone(db, row, now, 'uploaded');
  } else if (rereadAt && !uploadedSince && Number(users) > 0 && rereadAt.getTime() < now.getTime() - getDeviceConfig().importQueryHours * 3600000) {
    result.reread = { ...result.reread, outcome: 'no_upload' };
    const [, m] = await exec(db, 'UPDATE device_imports SET status = \'ready\', users_count = ?, templates_count = ?, result_json = ?, ready_at = ?, updated_at = ? WHERE id = ? AND status = \'querying\'',
      [users, templates, JSON.stringify(result), now, now, row.id]);
    if (affected(m) === 1) await rereadDone(db, row, now, 'no_upload');
  } else if (!Number(users) && new Date(row.started_at).getTime() < now.getTime() - getDeviceConfig().importQueryHours * 3600000) {
    await exec(db, 'UPDATE device_imports SET status = \'failed\', result_json = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = \'querying\'',
      [JSON.stringify({ ...result, reason: 'no_upload' }), now, now, row.id]);
  }
  const [fresh] = await select(db, 'SELECT * FROM device_imports WHERE id = ?', [row.id]);
  return fresh;
}

/** NEW-242: the device's re-read of this import has ended (uploaded, or no_upload); its forced 0 stops. */
async function rereadDone(db, imp, now, outcome) {
  const det = await detailsOf(db, imp.device_id);
  const all = parse(det?.att_stamps_json, {}) || {};
  if (!all._reread || all._reread.importId !== imp.id || all._reread.doneAt) return;
  all._reread = { ...all._reread, doneAt: now.toISOString(), outcome, tables: [] };
  await require('./device-registry.service').saveStamps(db, det, all);
}

/**
 * NEW-242: "Read all users again" for a T&A PUSH device in import hold (its import querying or ready). The next
 * cdata answers carry OPERLOGStamp=0 and BIODATAStamp=0 (ATTLOG echoed) until the device reports a stamp again,
 * one read-only CHECK asks it to fetch them, and the import waits for the new upload. Nothing that changes the
 * device is queued. → { import }
 */
async function reread(db, { tenantId, deviceId, importId, byUserId = null, now = new Date() }) {
  const registry = require('./device-registry.service');
  const platform = await registry.findById(deviceId);
  if (!platform || platform.tenant_id !== tenantId || platform.status === 'removed') throw createError('Device not found.', 404, 'device_not_found');
  const det = await detailsOf(db, deviceId);
  if (String(det?.device_type || '').toLowerCase() !== 'att') {
    throw createError('Only a T&A PUSH device is read again this way.', 422, 'not_att_device');
  }
  const imp = await importOf(db, deviceId, importId);
  if (imp.status === 'applied') throw createError('This import is applied. Roll it back first, then read the device again.', 409, 'import_applied');
  if (imp.status === 'live') throw createError('This import is live.', 409, 'import_live');
  if (!Number(det.import_hold)) throw createError('This device is not in an import any more.', 409, 'device_not_in_import');
  if (!OPEN.includes(imp.status)) throw createError('This import is closed. Start a new one.', 409, 'import_closed');
  if (platform.status !== 'active') throw createError('The device has not connected yet.', 409, 'device_not_connected');

  // One CHECK at a time; a second press replaces the one still queued.
  await exec(db, 'UPDATE device_commands SET status = \'superseded\', updated_at = ? WHERE device_id = ? AND kind = \'check\' AND status = \'queued\'', [now, deviceId]);
  await queueQuery(db, deviceId, 'check', { importId: imp.id, reread: true }, now);
  const all = parse(det.att_stamps_json, {}) || {};
  all._reread = { importId: imp.id, requestedAt: now.toISOString(), servedAt: null, startedAt: null, doneAt: null, outcome: null, tables: ['OPERLOG', 'BIODATA'] };
  await registry.saveStamps(db, det, all);
  const result = parse(imp.result_json, {}) || {};
  result.reread = { requestedAt: now.toISOString(), count: (result.reread?.count || 0) + 1, by: byUserId, outcome: null };
  await exec(db, 'UPDATE device_imports SET status = \'querying\', ready_at = NULL, result_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(result), now, imp.id]);
  const [fresh] = await select(db, 'SELECT * FROM device_imports WHERE id = ?', [imp.id]);
  return { import: await viewOf(db, fresh) };
}

// ── Users and conflicts ───────────────────────────────────────────────────────
async function namesOf(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const { User } = require('../../models/platform');
  return new Map((await User.findAll({ where: { id: list }, attributes: ['id', 'fullName'], raw: true })).map((u) => [u.id, u.fullName]));
}

/**
 * Every user row of an import with what decides it: the member's own PIN, who owns the device PIN in
 * GymsEra, the conflict, and template counts by type. Set-based (one query per table).
 */
async function classified(db, imp) {
  const rows = await select(db, 'SELECT * FROM device_import_users WHERE import_id = ? ORDER BY CAST(pin AS UNSIGNED), pin', [imp.id]);
  if (!rows.length) return [];
  const pins = rows.map((r) => r.pin).filter((p) => PIN.test(p)).map(Number);
  const members = rows.map((r) => r.member_id).filter(Boolean);
  const ids = await select(db, `SELECT member_id, pin, retired_at FROM member_device_identity WHERE ${pins.length ? 'pin IN (?)' : '1=0'} OR ${members.length ? 'member_id IN (?)' : '1=0'}`,
    [...(pins.length ? [pins] : []), ...(members.length ? [members] : [])]);
  const ownerOfPin = new Map(ids.map((i) => [String(i.pin), i]));
  const pinOfMember = new Map(ids.map((i) => [i.member_id, i]));
  const tpl = await select(db, 'SELECT pin, bio_type, COUNT(*) AS n FROM device_import_templates WHERE import_id = ? GROUP BY pin, bio_type', [imp.id]);
  const templates = new Map();
  for (const t of tpl) {
    if (!templates.has(t.pin)) templates.set(t.pin, {});
    templates.get(t.pin)[Number(t.bio_type)] = Number(t.n);
  }
  const names = await namesOf(members);
  const live = imp.status === 'live';
  return rows.map((r) => {
    const owner = ownerOfPin.get(String(r.pin));
    const mine = r.member_id ? pinOfMember.get(r.member_id) : null;
    let conflict = null;
    // After apply the member owns the PIN through this import: that is no conflict.
    if (!live && owner && owner.member_id !== r.member_id) conflict = 'pin_taken';
    else if (!live && r.member_id && mine && String(mine.pin) !== String(r.pin)) conflict = 'member_has_pin';
    const remove = Boolean(Number(r.remove_at_go_live));
    return {
      pin: r.pin,
      name: r.name,
      cardNo: r.card_no,
      privilege: Number(r.privilege),
      isAdmin: isAdmin(r),
      memberId: r.member_id,
      memberName: r.member_id ? names.get(r.member_id) || null : null,
      memberPin: mine && !mine.retired_at ? String(mine.pin) : null,
      matchSource: r.match_source,
      removeAtGoLive: remove,
      conflict,
      blocking: Boolean(conflict) && !remove,
      templates: templates.get(r.pin) || {},
      appliedAt: r.applied_at,
    };
  });
}

const FILTERS = {
  all: () => true,
  matched: (u) => Boolean(u.memberId),
  unmatched: (u) => !u.memberId && !u.isAdmin,
  conflict: (u) => Boolean(u.conflict),
  admin: (u) => u.isAdmin,
  remove: (u) => u.removeAtGoLive,
};

async function listUsers(db, imp, { filter = 'all', limit = 100, offset = 0 } = {}) {
  const all = (await classified(db, imp)).filter(FILTERS[filter] || FILTERS.all);
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  return { users: all.slice(off, off + lim), total: all.length, limit: lim, offset: off };
}

// ── View ──────────────────────────────────────────────────────────────────────
async function viewOf(db, imp) {
  const users = await classified(db, imp);
  const res = parse(imp.result_json, {}) || {};
  let reread = null;
  if (res.reread?.requestedAt) {
    // NEW-242: the device's side (stamps) when this import is the one being re-read, else what the import kept.
    const det = await detailsOf(db, imp.device_id);
    const rr = (parse(det?.att_stamps_json, {}) || {})._reread;
    const mine = rr && rr.importId === imp.id ? rr : null;
    const state = mine
      ? require('./device-registry.service').rereadState(mine, Boolean(Number(det.import_hold)))
      : (res.reread.outcome === 'no_upload' ? 'no_upload' : 'done');
    reread = { state, requestedAt: res.reread.requestedAt, servedAt: mine?.servedAt || null, startedAt: mine?.startedAt || null, doneAt: mine?.doneAt || null, count: res.reread.count || 1 };
  }
  return {
    id: imp.id,
    deviceId: imp.device_id,
    status: imp.status,
    startedAt: imp.started_at,
    readyAt: imp.ready_at,
    appliedAt: imp.applied_at,
    liveAt: imp.live_at,
    finishedAt: imp.finished_at,
    truncated: Boolean(Number(imp.truncated)),
    types: res.types || [],
    failedQueries: res.failedQueries || [],
    failedReason: res.reason || null,
    result: res.applied || null,
    reread,
    counts: {
      users: users.length,
      templates: Number(imp.templates_count),
      templatesTooLarge: Number(imp.templates_too_large),
      admins: users.filter((u) => u.isAdmin).length,
      matched: users.filter((u) => u.memberId).length,
      unmatched: users.filter((u) => !u.memberId && !u.isAdmin).length,
      conflicts: users.filter((u) => u.blocking).length,
      removeAtGoLive: users.filter((u) => u.removeAtGoLive).length,
    },
  };
}

// ── Matching ──────────────────────────────────────────────────────────────────
function assertEditable(imp) {
  if (imp.status === 'ready') return;
  if (imp.status === 'querying') throw createError('The device is still sending its users. Try again in a minute.', 409, 'import_not_ready');
  if (imp.status === 'applied') throw createError('This import is applied. Roll it back to change the matches.', 409, 'import_applied');
  if (imp.status === 'live') throw createError('This import is live.', 409, 'import_live');
  throw createError('This import is closed. Start a new one.', 409, 'import_closed');
}

async function userRow(db, imp, pin) {
  const [row] = await select(db, 'SELECT * FROM device_import_users WHERE import_id = ? AND pin = ?', [imp.id, String(pin)]);
  return row || null;
}

/** Sets one device user's member (null = unmatched) and/or "remove at go-live". → the user row view */
async function setMatch(db, imp, pin, { memberId, removeAtGoLive }, { source = 'manual', now = new Date() } = {}) {
  const row = await userRow(db, imp, pin);
  if (!row) throw createError('That PIN is not on the device.', 404, 'pin_not_on_device');
  let member = row.member_id;
  if (memberId !== undefined) {
    if (memberId && isAdmin(row)) throw createError('This is an administrator of the device. It stays on the device as it is.', 422, 'device_admin');
    if (memberId) {
      await require('./device-push.service').assertMember(db, memberId);
      const [other] = await select(db, 'SELECT pin FROM device_import_users WHERE import_id = ? AND member_id = ? AND pin <> ?', [imp.id, memberId, String(pin)]);
      if (other) {
        const err = createError(`This member is already matched to device user ${other.pin}.`, 409, 'member_already_matched');
        err.data = { pin: other.pin };
        throw err;
      }
    }
    member = memberId || null;
  }
  let remove = removeAtGoLive === undefined ? Number(row.remove_at_go_live) : (removeAtGoLive ? 1 : 0);
  if (removeAtGoLive === undefined && memberId && memberId !== row.member_id) {
    // A member who already has another PIN is sent under that PIN; this device user goes at go-live.
    const [mine] = await select(db, 'SELECT pin FROM member_device_identity WHERE member_id = ? AND retired_at IS NULL', [memberId]);
    remove = mine && String(mine.pin) !== String(pin) ? 1 : 0;
  }
  if (remove && isAdmin(row)) throw createError('This is an administrator of the device. It stays on the device as it is.', 422, 'device_admin');
  await exec(db, 'UPDATE device_import_users SET member_id = ?, match_source = ?, remove_at_go_live = ?, updated_at = ? WHERE import_id = ? AND pin = ?',
    [member, member ? (memberId !== undefined && memberId !== row.member_id ? source : row.match_source) : null, remove, now, imp.id, String(pin)]);
  return (await classified(db, imp)).find((u) => u.pin === String(pin));
}

/** One CSV line → fields (quotes allowed, "" inside quotes). */
function csvFields(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A CSV mapping: header `pin` plus `member_id`, `email` or `phone` (first one filled on each line wins).
 * Only members of this gym are matched; a line that does not resolve to exactly one is reported, never
 * guessed. → { matched, errors: [{ line, pin, reason }] }
 */
async function mapCsv(db, imp, csv, { now = new Date() } = {}) {
  assertEditable(imp);
  const text = String(csv || '');
  if (Buffer.byteLength(text) > MAX_CSV_BYTES) throw createError('The file is over 1 MB. Split it and upload each part.', 422, 'csv_too_large');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length > MAX_CSV_LINES + 1) throw createError(`The file has more than ${MAX_CSV_LINES} lines. Split it.`, 422, 'csv_too_large');
  const header = csvFields(lines[0] || '').map((h) => h.toLowerCase().replace(/[\s-]+/g, '_'));
  const col = (name) => header.indexOf(name);
  if (col('pin') < 0 || !['member_id', 'email', 'phone'].some((c) => col(c) >= 0)) {
    throw createError('The first line must name the columns: pin, and member_id, email or phone.', 422, 'csv_header');
  }
  const { User } = require('../../models/platform');
  const push = require('./device-push.service');
  const isMember = async (id) => push.assertMember(db, id).then(() => true, () => false);
  const errors = [];
  let matched = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const f = csvFields(lines[i]);
    const lineNo = i + 1;
    const pin = String(f[col('pin')] || '').trim();
    const fail = (reason) => errors.push({ line: lineNo, pin: pin || null, reason });
    if (!PIN.test(pin)) { fail('invalid_pin'); continue; }
    const row = await userRow(db, imp, pin);
    if (!row) { fail('pin_not_on_device'); continue; }
    if (isAdmin(row)) { fail('device_admin'); continue; }
    const memberIdCell = col('member_id') >= 0 ? f[col('member_id')] : '';
    const emailCell = col('email') >= 0 ? f[col('email')] : '';
    const phoneCell = col('phone') >= 0 ? f[col('phone')] : '';
    let candidates = [];
    if (memberIdCell) candidates = UUID.test(memberIdCell) ? [memberIdCell] : [];
    else if (emailCell) candidates = (await User.findAll({ where: { email: emailCell.toLowerCase() }, attributes: ['id'], raw: true })).map((u) => u.id);
    else if (phoneCell) candidates = (await User.findAll({ where: { phone: phoneCell.replace(/[\s-]/g, '') }, attributes: ['id'], raw: true })).map((u) => u.id);
    else { fail('member_missing'); continue; }
    const inGym = [];
    for (const c of candidates) if (await isMember(c)) inGym.push(c);
    if (!inGym.length) { fail('member_not_found'); continue; }
    if (inGym.length > 1) { fail('ambiguous_member'); continue; }
    try {
      await setMatch(db, imp, pin, { memberId: inGym[0] }, { source: 'csv', now });
      matched += 1;
    } catch (err) {
      fail(err.code || 'not_matched');
    }
  }
  return { matched, errors };
}

// ── Preview ───────────────────────────────────────────────────────────────────
async function entitlement(db, deviceId, memberIds, now) {
  if (!memberIds.length) return new Map();
  const sync = require('./device-sync.service');
  const [device] = await sync.devicesOf(db, { deviceId, includeHeld: true });
  if (!device) return new Map();
  return sync.desiredFor(db, device, memberIds, { now, noPins: true });
}

/** What apply would store and what go-live would do. Read-only. */
async function preview(db, imp, { now = new Date() } = {}) {
  if (!['ready', 'applied', 'live'].includes(imp.status)) assertEditable(imp);
  const users = await classified(db, imp);
  const matched = users.filter((u) => u.memberId && !u.isAdmin);
  const memberIds = matched.map((u) => u.memberId);
  const consented = new Set(memberIds.length
    ? (await select(db, 'SELECT DISTINCT member_id FROM member_biometric_consents WHERE member_id IN (?) AND revoked_at IS NULL', [memberIds])).map((r) => r.member_id)
    : []);
  const existing = new Set(memberIds.length
    ? (await select(db, 'SELECT member_id, bio_type, bio_no, bio_index FROM member_biometrics WHERE member_id IN (?) AND (import_id IS NULL OR import_id <> ?)', [memberIds, imp.id]))
      .map((r) => `${r.member_id}:${r.bio_type}:${r.bio_no}:${r.bio_index}`)
    : []);
  const tpl = await select(db, 'SELECT pin, bio_type, bio_no, bio_index FROM device_import_templates WHERE import_id = ?', [imp.id]);
  const byPin = new Map(matched.map((u) => [u.pin, u]));
  const will = { identities: 0, templates: 0, templatesPending: 0, alreadyEnrolled: 0, cards: 0 };
  const consentNeeded = new Map();
  let templatesOfUnmatched = 0;
  for (const t of tpl) {
    const u = byPin.get(t.pin);
    if (!u || u.blocking) { templatesOfUnmatched += 1; continue; }
    if (existing.has(`${u.memberId}:${t.bio_type}:${t.bio_no}:${t.bio_index}`)) { will.alreadyEnrolled += 1; continue; }
    if (consented.has(u.memberId)) will.templates += 1;
    else {
      will.templatesPending += 1;
      const c = consentNeeded.get(u.memberId) || { memberId: u.memberId, memberName: u.memberName, pin: u.pin, templates: 0 };
      c.templates += 1;
      consentNeeded.set(u.memberId, c);
    }
  }
  for (const u of matched) {
    if (u.blocking) continue;
    if (!u.memberPin && u.conflict === null) will.identities += 1;
    if (u.cardNo) will.cards += 1;
  }
  const wants = await entitlement(db, imp.device_id, memberIds, now);
  const entitled = matched.filter((u) => wants.get(u.memberId)?.desired);
  const kept = users.filter((u) => !u.memberId && !u.removeAtGoLive).length; // unmatched and admins stay
  const det = await detailsOf(db, imp.device_id);
  const caps = parse(det?.capabilities_json, {}) || {};
  const maxUsers = Number(caps.MaxUserCount) || null;
  const used = entitled.length + kept;
  return {
    willStore: will,
    consentNeeded: [...consentNeeded.values()],
    skipped: {
      unmatched: users.filter((u) => !u.memberId && !u.isAdmin).length,
      admins: users.filter((u) => u.isAdmin).length,
      alreadyEnrolled: will.alreadyEnrolled,
      templatesNotImported: templatesOfUnmatched,
    },
    atGoLive: {
      removePins: users.filter((u) => u.removeAtGoLive).map((u) => u.pin).sort(),
      notEntitled: matched.length - entitled.length,
      sendUnderOwnPin: matched.filter((u) => u.conflict === 'member_has_pin').map((u) => ({ pin: u.pin, memberPin: u.memberPin })),
    },
    blocking: users.filter((u) => u.blocking).map((u) => ({ pin: u.pin, conflict: u.conflict, memberId: u.memberId })),
    capacity: { users: used, maxUsers, percent: maxUsers ? Math.round((used / maxUsers) * 100) : null },
  };
}

// ── Apply ─────────────────────────────────────────────────────────────────────
/** → { import, alreadyApplied, result } */
async function apply(db, imp, { byUserId = null, now = new Date() } = {}) {
  if (imp.status === 'applied' || imp.status === 'live') {
    return { import: await viewOf(db, imp), alreadyApplied: true, result: parse(imp.result_json, {})?.applied || null };
  }
  assertEditable(imp);
  const users = await classified(db, imp);
  const blocking = users.filter((u) => u.blocking);
  if (blocking.length) {
    const err = createError('Some device users need a decision before you apply: their PIN is used in GymsEra by someone else, or the member already has another PIN.', 409, 'import_conflicts');
    err.data = { blocking: blocking.map((u) => ({ pin: u.pin, conflict: u.conflict })) };
    throw err;
  }
  const cfg = getDeviceConfig();
  const result = { identities: 0, templates: 0, templatesPending: 0, alreadyEnrolled: 0, cards: 0 };
  await db.sequelize.transaction(async (transaction) => {
    // Claim the import inside the transaction: a second apply at the same moment does nothing.
    const [, claimed] = await exec(db, 'UPDATE device_imports SET status = \'applying\', updated_at = ? WHERE id = ? AND status = \'ready\'', [now, imp.id], transaction);
    if (affected(claimed) !== 1) throw createError('This import is being applied.', 409, 'import_not_ready');
    for (const u of users.filter((x) => x.memberId && !x.isAdmin)) {
      const [mine] = await select(db, 'SELECT pin, card_no FROM member_device_identity WHERE member_id = ?', [u.memberId], transaction);
      const [owner] = await select(db, 'SELECT member_id FROM member_device_identity WHERE pin = ?', [Number(u.pin)], transaction);
      let identityCreated = 0;
      if (!mine && !owner) {
        await exec(db, 'INSERT INTO member_device_identity (member_id, pin, card_no, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)', [u.memberId, Number(u.pin), now, now], transaction);
        identityCreated = 1;
        result.identities += 1;
      }
      let cardAdopted = 0;
      if (u.cardNo && (mine || identityCreated)) {
        const [, m] = await exec(db, 'UPDATE member_device_identity SET card_no = ?, updated_at = ? WHERE member_id = ? AND (card_no IS NULL OR card_no = \'\')',
          [u.cardNo, now, u.memberId], transaction);
        cardAdopted = affected(m) === 1 ? 1 : 0;
        result.cards += cardAdopted;
      }
      const [consent] = await select(db, 'SELECT id FROM member_biometric_consents WHERE member_id = ? AND revoked_at IS NULL LIMIT 1', [u.memberId], transaction);
      const tpl = await select(db, 'SELECT * FROM device_import_templates WHERE import_id = ? AND pin = ? AND template_enc IS NOT NULL', [imp.id, u.pin], transaction);
      for (const t of tpl) {
        const [have] = await select(db, 'SELECT id FROM member_biometrics WHERE member_id = ? AND bio_type = ? AND bio_no = ? AND bio_index = ?',
          [u.memberId, t.bio_type, t.bio_no, t.bio_index], transaction);
        if (have) {
          await exec(db, 'UPDATE device_import_templates SET outcome = \'already_enrolled\' WHERE id = ?', [t.id], transaction);
          result.alreadyEnrolled += 1;
          continue;
        }
        const id = crypto.randomUUID();
        // Held until go-live; a pending one (no consent) gets its 7 days from go-live (pending_until set then).
        await exec(db, `INSERT INTO member_biometrics (id, member_id, bio_type, bio_no, bio_index, major_ver, minor_ver, format, duress, valid,
            template_enc, key_version, template_sha256, template_size, source_device_id, consent_pending, pending_until, enrolled_at, import_id, import_hold, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)`, [
          id, u.memberId, t.bio_type, t.bio_no, t.bio_index, t.major_ver, t.minor_ver, t.format, t.duress, t.valid,
          t.template_enc, t.key_version, t.template_sha256, t.template_size, imp.device_id, consent ? 0 : 1, now, imp.id, now, now,
        ], transaction);
        await exec(db, 'UPDATE device_import_templates SET outcome = ?, biometric_id = ? WHERE id = ?', [consent ? 'stored' : 'pending', id, t.id], transaction);
        if (consent) result.templates += 1;
        else result.templatesPending += 1;
      }
      await exec(db, 'UPDATE device_import_users SET identity_created = ?, card_adopted = ?, applied_at = ?, updated_at = ? WHERE import_id = ? AND pin = ?',
        [identityCreated, cardAdopted, now, now, imp.id, u.pin], transaction);
    }
    await exec(db, 'UPDATE device_import_templates SET outcome = COALESCE(outcome, \'not_matched\'), template_enc = NULL WHERE import_id = ?', [imp.id], transaction);
    // New GymsEra PINs never reach a PIN this device uses (matched or not): §6.3, a PIN is never shared.
    const [{ maxPin }] = await select(db, 'SELECT MAX(CAST(pin AS UNSIGNED)) AS maxPin FROM device_import_users WHERE import_id = ?', [imp.id], transaction);
    await exec(db, 'INSERT IGNORE INTO device_pin_sequence (id, next_pin) VALUES (1, 1001)', [], transaction);
    if (maxPin) await exec(db, 'UPDATE device_pin_sequence SET next_pin = GREATEST(next_pin, ?) WHERE id = 1', [Number(maxPin) + 1], transaction);
    const res = { ...(parse(imp.result_json, {}) || {}), applied: result };
    await exec(db, 'UPDATE device_imports SET status = \'applied\', applied_at = ?, applied_by = ?, result_json = ?, updated_at = ? WHERE id = ?',
      [now, byUserId, JSON.stringify(res), now, imp.id], transaction);
  });
  if (cfg && process.env.LOG_DEVICES === 'true') console.log(`[device-import] ${imp.id} applied: ${JSON.stringify(result)}`);
  const [fresh] = await select(db, 'SELECT * FROM device_imports WHERE id = ?', [imp.id]);
  return { import: await viewOf(db, fresh), alreadyApplied: false, result };
}

// ── Rollback and cancel ───────────────────────────────────────────────────────
/** Before go-live only. What apply stored goes; the device is untouched; the hold stays. */
async function rollback(db, imp, { byUserId = null, now = new Date() } = {}) {
  if (imp.status === 'live') throw createError('This import is live. Its members are managed by GymsEra now: change them one by one.', 409, 'import_live');
  if (imp.status !== 'applied') throw createError('Only an applied import can be rolled back.', 409, 'import_not_applied');
  await db.sequelize.transaction(async (transaction) => {
    await exec(db, 'DELETE FROM member_biometrics WHERE import_id = ? AND import_hold = 1', [imp.id], transaction);
    const rows = await select(db, 'SELECT * FROM device_import_users WHERE import_id = ? AND applied_at IS NOT NULL', [imp.id], transaction);
    for (const r of rows) {
      if (Number(r.card_adopted) && r.card_no) {
        await exec(db, 'UPDATE member_device_identity SET card_no = NULL, updated_at = ? WHERE member_id = ? AND card_no = ?', [now, r.member_id, r.card_no], transaction);
      }
      if (Number(r.identity_created)) {
        // The PIN this import gave, unless something has used it since (a device holds the member).
        const [used] = await select(db, 'SELECT 1 AS x FROM device_member_sync WHERE member_id = ? LIMIT 1', [r.member_id], transaction);
        if (!used) await exec(db, 'DELETE FROM member_device_identity WHERE member_id = ? AND pin = ?', [r.member_id, Number(r.pin)], transaction);
      }
    }
    await exec(db, 'UPDATE device_import_users SET applied_at = NULL, identity_created = 0, card_adopted = 0, updated_at = ? WHERE import_id = ?', [now, imp.id], transaction);
    await exec(db, 'UPDATE device_imports SET status = \'rolled_back\', finished_at = ?, finished_by = ?, updated_at = ? WHERE id = ?', [now, byUserId, now, imp.id], transaction);
  });
  const [fresh] = await select(db, 'SELECT * FROM device_imports WHERE id = ?', [imp.id]);
  return { import: await viewOf(db, fresh) };
}

/** Stops an import that is not applied: staging emptied, the hold ends, the device is synced normally. */
async function cancel(db, imp, { byUserId = null, now = new Date() } = {}) {
  if (imp.status === 'applied') throw createError('This import is applied. Roll it back first.', 409, 'import_applied');
  if (imp.status === 'live') throw createError('This import is live.', 409, 'import_live');
  if (OPEN.includes(imp.status)) {
    await exec(db, 'UPDATE device_imports SET status = \'cancelled\', finished_at = ?, finished_by = ?, updated_at = ? WHERE id = ?', [now, byUserId, now, imp.id]);
  }
  await exec(db, 'UPDATE device_import_templates SET template_enc = NULL WHERE import_id = ?', [imp.id]);
  const cmdIds = parse(imp.query_cmd_ids_json, []) || [];
  if (cmdIds.length) await exec(db, 'UPDATE device_commands SET status = \'superseded\', updated_at = ? WHERE id IN (?) AND status = \'queued\'', [now, cmdIds]);
  await exec(db, 'UPDATE access_device_details SET import_hold = 0, import_hold_since = NULL, updated_at = ? WHERE id = ?', [now, imp.device_id]);
  require('./device-triggers').reconcileDeviceSoon(db, imp.device_id, 'import_cancelled');
  const [fresh] = await select(db, 'SELECT * FROM device_imports WHERE id = ?', [imp.id]);
  return { import: await viewOf(db, fresh) };
}

// ── Cut-over ──────────────────────────────────────────────────────────────────
/** A scan's PIN during the hold: the member this device's applied import gave that PIN, or null. */
async function heldOwnerOfPin(db, deviceId, pin) {
  if (!PIN.test(String(pin ?? ''))) return null;
  const [row] = await select(db, `SELECT u.member_id FROM device_import_users u
      JOIN device_imports i ON i.id = u.import_id
      JOIN member_device_identity m ON m.member_id = u.member_id AND m.pin = ? AND m.retired_at IS NULL
    WHERE i.device_id = ? AND i.status = 'applied' AND u.pin = ? AND u.applied_at IS NOT NULL LIMIT 1`, [Number(pin), deviceId, String(pin)]);
  return row ? row.member_id : null;
}

/** The per-device checklist (imported, matched, verified, unmatched PINs) for leaving GymBioSync. */
async function cutover(db, { tenantId, deviceId, now = new Date() }) {
  const registry = require('./device-registry.service');
  const found = await registry.getDevice({ tenantId, tenantDb: db, deviceId });
  if (!found) throw createError('Device not found.', 404, 'device_not_found');
  const det = found.details;
  let imp = await latestImport(db, deviceId);
  if (imp) imp = await refresh(db, imp, now);
  const users = imp ? await classified(db, imp) : [];
  const counts = parse(det.counts_json, {}) || {};
  const matched = users.filter((u) => u.memberId && !u.isAdmin);
  const memberIds = matched.map((u) => u.memberId);
  const syncRows = memberIds.length
    ? await select(db, 'SELECT member_id, desired, state FROM device_member_sync WHERE device_id = ? AND member_id IN (?)', [deviceId, memberIds])
    : [];
  const verified = syncRows.filter((r) => Number(r.desired) === 1 && r.state === 'in_sync').length;
  const desiredNow = syncRows.filter((r) => Number(r.desired) === 1).length;
  const [pending] = imp ? await select(db, 'SELECT COUNT(DISTINCT member_id) AS members, COUNT(*) AS n FROM member_biometrics WHERE import_id = ? AND consent_pending = 1', [imp.id]) : [{ members: 0, n: 0 }];
  const status = imp?.status || null;
  const isLive = status === 'live';
  const [audit] = isLive && det.live_at
    ? await select(db, 'SELECT status, finished_at FROM device_audits WHERE device_id = ? AND started_at >= ? ORDER BY id DESC LIMIT 1', [deviceId, det.live_at])
    : [];
  const blocking = users.filter((u) => u.blocking).length;
  const unmatched = users.filter((u) => !u.memberId && !u.isAdmin);
  const maxUsers = Number((parse(det.capabilities_json, {}) || {}).MaxUserCount) || null;
  const deviceUsers = counts.UserCount !== undefined && counts.UserCount !== '' ? Number(counts.UserCount) : users.length;
  const usersAfter = isLive ? desiredNow + unmatched.length + users.filter((u) => u.isAdmin).length : null;
  const percent = maxUsers ? Math.round(((usersAfter ?? deviceUsers) / maxUsers) * 100) : null;
  const step = (key, st, extra = {}) => ({ key, status: st, ...extra });
  const steps = [
    step('connected', found.view.connection === 'online' ? 'done' : 'todo', { connection: found.view.connection }),
    step('imported', !imp ? 'todo' : status === 'querying' ? 'in_progress' : status === 'failed' ? 'blocked' : ['ready', 'applied', 'live'].includes(status) ? 'done' : 'todo'),
    step('matched', !imp || status === 'querying' ? 'todo' : unmatched.length ? 'warning' : 'done', { count: unmatched.length }),
    step('conflicts', blocking ? 'blocked' : 'done', { count: blocking }),
    step('applied', ['applied', 'live'].includes(status) ? 'done' : 'todo'),
    step('consent', Number(pending.n) ? 'warning' : 'done', { count: Number(pending.members) }),
    step('capacity', percent !== null && percent >= getDeviceConfig().capacityAlertPercent ? 'warning' : 'done', { percent }),
    step('live', isLive ? 'done' : 'todo'),
    step('verified', isLive && audit?.status === 'compared' && verified === desiredNow ? 'done' : 'todo', { count: verified, of: desiredNow }),
    step('gymbiosync_stopped', det.gbs_stopped_at ? 'done' : 'todo', { at: det.gbs_stopped_at || null }),
  ];
  return {
    deviceId,
    importHold: Boolean(Number(det.import_hold)),
    importHoldSince: det.import_hold_since || null,
    liveAt: det.live_at || null,
    gbsStoppedAt: det.gbs_stopped_at || null,
    import: imp ? await viewOf(db, imp) : null,
    counts: {
      deviceUsers,
      imported: users.length,
      matched: matched.length,
      unmatched: unmatched.length,
      admins: users.filter((u) => u.isAdmin).length,
      conflicts: blocking,
      templates: imp ? Number(imp.templates_count) : 0,
      consentNeeded: Number(pending.members),
      verified,
    },
    unmatchedPins: unmatched.slice(0, 100).map((u) => u.pin),
    steps,
    canGoLive: status === 'applied' && !blocking && found.row.status === 'active',
  };
}

/**
 * Go live: the end of the import. → the cut-over checklist.
 * removeUnmatched: also delete every unmatched device user that is not a device admin.
 */
async function goLive(db, { tenantId, deviceId, byUserId = null, removeUnmatched = false, now = new Date() }) {
  const sync = require('./device-sync.service');
  const imp0 = await latestImport(db, deviceId);
  if (!imp0) throw createError('Import the device first.', 409, 'import_not_applied');
  const imp = await refresh(db, imp0, now);
  if (imp.status === 'live') return cutover(db, { tenantId, deviceId, now });
  if (imp.status !== 'applied') throw createError('Apply the import before you go live.', 409, 'import_not_applied');
  const users = await classified(db, imp);
  // A PIN given to someone else since apply would now clash: check again.
  const clash = users.filter((u) => u.conflict === 'pin_taken' && !u.removeAtGoLive && !(u.memberId && u.appliedAt && u.memberPin === u.pin));
  if (clash.length) {
    const err = createError('Some device users need a decision before you go live.', 409, 'import_conflicts');
    err.data = { blocking: clash.map((u) => ({ pin: u.pin, conflict: u.conflict })) };
    throw err;
  }
  const det = await detailsOf(db, deviceId);
  const caps = parse(det?.capabilities_json, {}) || {};
  const reported = [...rules.bioSupport(caps).types];
  const types = reported.length ? reported : getDeviceConfig().importBioTypes;
  // Phase 5: a T&A PUSH device that is never sent userauthorize gets no DATA DELETE userauthorize.
  const opts = rules.deviceOptions(det || {}, getDeviceConfig());
  const removePins = users.filter((u) => !u.isAdmin && (u.removeAtGoLive || (removeUnmatched && !u.memberId))).map((u) => u.pin);
  const keptUnmatched = users.filter((u) => !u.isAdmin && !u.memberId && !removePins.includes(u.pin));

  await db.sequelize.transaction(async (transaction) => {
    const [, claimed] = await exec(db, 'UPDATE device_imports SET status = \'live\', live_at = ?, live_by = ?, updated_at = ? WHERE id = ? AND status = \'applied\'', [now, byUserId, now, imp.id], transaction);
    if (affected(claimed) !== 1) throw createError('This import is going live already.', 409, 'import_not_applied');
    // Held templates are released; one waiting for consent gets its 7 days from now (§7.5).
    await exec(db, 'UPDATE member_biometrics SET import_hold = 0, pending_until = IF(consent_pending = 1, ?, NULL), updated_at = ? WHERE import_id = ?',
      [new Date(now.getTime() + getDeviceConfig().consentPendingDays * 86400000), now, imp.id], transaction);
    // GymsEra plans this device from scratch: nothing it believed about the device before the import holds.
    await exec(db, 'UPDATE device_commands SET status = \'superseded\', updated_at = ? WHERE device_id = ? AND status = \'queued\'', [now, deviceId], transaction);
    await exec(db, 'DELETE FROM device_member_sync WHERE device_id = ?', [deviceId], transaction);
    // Only the device users the host marked: their templates, comparison photo, authorization, then the user.
    for (const pin of removePins) {
      const plan = [...types.map((type) => ['bio_delete', { pin, type }]), ['photo_delete', { pin }], ...(opts.sendUserAuthorize || !opts.att ? [['auth_delete', { pin }]] : []), ['user_delete', { pin }]];
      for (const [kind, args] of plan) {
        await exec(db, `INSERT INTO device_commands (device_id, kind, args_json, priority, status, attempts, not_before, created_at, updated_at)
          VALUES (?, ?, ?, 1, 'queued', 0, ?, ?, ?)`, [deviceId, kind, JSON.stringify({ ...args, importId: imp.id }), new Date(now.getTime() - 1000), now, now], transaction);
      }
    }
    await exec(db, 'UPDATE access_device_details SET import_hold = 0, import_hold_since = NULL, live_at = ?, updated_at = ? WHERE id = ?', [now, now, deviceId], transaction);
  });
  for (const u of keptUnmatched) await sync.noteUnlinked(db, deviceId, { pin: u.pin, name: u.name, cardNo: u.cardNo, source: 'import' }, now);
  // Every matched member: on this device with GymsEra's record and window, and their released templates
  // on their other devices. Then the rest of the device's members, then an audit to verify.
  const matched = [...new Set(users.filter((u) => u.memberId && !u.isAdmin).map((u) => u.memberId))];
  for (const memberId of matched) await sync.reconcileMember(db, memberId, 'import_live', { priority: 2, now });
  await sync.reconcileDevice(db, deviceId, 'import_live', { priority: 2, now });
  await require('../../jobs/device-jobs').requestAudit(db, deviceId, now);
  return cutover(db, { tenantId, deviceId, now });
}

async function markGbsStopped(db, { tenantId, deviceId, now = new Date() }) {
  await exec(db, 'UPDATE access_device_details SET gbs_stopped_at = COALESCE(gbs_stopped_at, ?), updated_at = ? WHERE id = ?', [now, now, deviceId]);
  return cutover(db, { tenantId, deviceId, now });
}

async function listImports(db, deviceId) {
  const rows = await select(db, 'SELECT * FROM device_imports WHERE device_id = ? ORDER BY started_at DESC, id DESC LIMIT 20', [deviceId]);
  const out = [];
  for (const r of rows) out.push(await viewOf(db, await refresh(db, r)));
  return { imports: out };
}

// ── Housekeeping (device-retention job) ───────────────────────────────────────
/**
 * Imports nobody finished: a querying one past DEVICE_IMPORT_QUERY_HOURS fails; a ready one untouched for
 * 7 days is cancelled (the device stays in hold: start again from its cut-over page); every staging
 * template of an import that is not querying or ready is emptied. → counts
 */
async function housekeeping(db, now = new Date()) {
  const out = { failed: 0, expired: 0, purged: 0 };
  for (const r of await select(db, 'SELECT * FROM device_imports WHERE status = \'querying\'', [])) {
    if ((await refresh(db, r, now)).status === 'failed') out.failed += 1;
  }
  const [, e] = await exec(db, 'UPDATE device_imports SET status = \'cancelled\', finished_at = ?, updated_at = ? WHERE status = \'ready\' AND updated_at < ?',
    [now, now, new Date(now.getTime() - STALE_READY_DAYS * 86400000)]);
  out.expired = affected(e);
  const [, p] = await exec(db, `UPDATE device_import_templates t JOIN device_imports i ON i.id = t.import_id SET t.template_enc = NULL
    WHERE t.template_enc IS NOT NULL AND i.status NOT IN ('querying', 'ready')`, []);
  out.purged = affected(p);
  return out;
}

module.exports = {
  stageUploads,
  latestImport,
  startImport,
  importOf,
  listImports,
  isImportCommand,
  ingestPack,
  refresh,
  listUsers,
  viewOf,
  setMatch,
  mapCsv,
  csvFields,
  preview,
  apply,
  rollback,
  cancel,
  reread,
  heldOwnerOfPin,
  cutover,
  goLive,
  markGbsStopped,
  housekeeping,
  assertEditable,
};
