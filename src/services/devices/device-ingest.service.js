/**
 * What devices send us (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §5, §7.3, §7.4 layer 4, §7.5, §8.3).
 *
 *   rtlog / ATTLOG     scans → device_access_events; granted → attendance.service#deviceScan
 *                       (the one check-in path; IN, OUT, or `inoutstatus` on a "both" device)
 *   rtstate            device_state history (+ the latest on access_device_details, Phase 1)
 *   errorlog           device_error_logs (source 'device'): codes and messages, never a body
 *   user               card numbers adopted when GymsEra has none; unknown PINs → unlinked list
 *   biodata / templatev10 / BioData   templates → member_biometrics (encrypted, consent rules)
 *   biophoto / userpic photos → private store; ATTPHOTO capture photos only for a branch that opted
 *                       in (D-6, device-screens.service#storeCapturePhotos, 30 days)
 *   querydata user     the nightly audit's user list, in packs
 *
 * Nothing here logs a body, a template or a photo. `db` = { sequelize, models }; `device` = a row
 * of device-sync.service#devicesOf (details with the branch's time zone).
 */
const { utc } = require('./sql-time');
const { QueryTypes } = require('sequelize');
const protocol = require('./push-protocol');
const rules = require('./sync-rules');
const identity = require('./device-identity.service');
const biometrics = require('./biometric.service');
const sync = require('./device-sync.service');

const select = (db, sql, replacements) => db.sequelize.query(sql, { replacements: utc(replacements), type: QueryTypes.SELECT });
const exec = (db, sql, replacements) => db.sequelize.query(sql, { replacements: utc(replacements) });
const affected = (meta) => (typeof meta === 'number' ? meta : meta?.affectedRows || 0);
const int = (v, d = null) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

// ── Time: device local (= branch local) → UTC ─────────────────────────────────
const TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

function localToUtc(text, timezone) {
  const m = TIME.exec(String(text || '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetAt = (ms) => {
    const p = rules.localParts(new Date(ms), timezone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  let utc = guess - offsetAt(guess);
  utc = guess - offsetAt(utc);
  return { utc: new Date(utc), local: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` };
}

// ── Scans (§7.3) ──────────────────────────────────────────────────────────────
/** → { received, stored, duplicates, checkIns, checkOuts } */
async function ingestScans(db, device, body, { attlog = false, now = new Date() } = {}) {
  const tz = device.branch_timezone || 'Asia/Karachi';
  const rows = attlog
    ? protocol.parseRecords(body, { positional: ['pin', 'time', 'inoutstatus', 'verifytype', 'workcode'] })
    : protocol.parseRecords(body);
  const counts = { received: rows.length, stored: 0, duplicates: 0, checkIns: 0, checkOuts: 0 };
  for (const r of rows) {
    const t = localToUtc(r.time, tz);
    if (!t) continue;
    const pin = String(r.pin ?? '').trim();
    const event = attlog ? 0 : int(r.event, -1);
    const index = int(r.index) ?? -Math.max(1, int(pin, 1)); // no index (ATTLOG): one row per person per second
    const result = rules.classifyEvent(event);
    const [, meta] = await db.sequelize.query(
      `INSERT INTO device_access_events (device_id, branch_id, device_record_index, device_time, \`utc_time\`, pin, member_id, card_no, event_code,
         verify_type, inout_status, result, reason, attendance_id, attendance_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?) ON DUPLICATE KEY UPDATE id = id`,
      {
        replacements: utc([
          device.id, device.branch_id, index, t.local, t.utc, pin ? pin.slice(0, 16) : null,
          r.cardno && r.cardno !== '0' ? String(r.cardno).slice(0, 32) : null, event, int(r.verifytype), int(r.inoutstatus),
          result, result === 'denied' ? rules.deniedReason(event) : null, now,
        ]),
      }
    );
    if (affected(meta) !== 1) { counts.duplicates += 1; continue; }
    counts.stored += 1;
    const [{ id }] = await select(db, 'SELECT id FROM device_access_events WHERE device_id = ? AND device_record_index = ? AND device_time = ?', [device.id, index, t.local]);
    const outcome = await afterScan(db, device, { eventId: id, pin, result, inout: int(r.inoutstatus, 0), utc: t.utc, now });
    if (outcome === 'check_in') counts.checkIns += 1;
    if (outcome === 'check_out') counts.checkOuts += 1;
  }
  return counts;
}

async function afterScan(db, device, { eventId, pin, result, inout, utc, now }) {
  if (!pin || pin === '0') return null; // door and alarm events: no person
  const owner = await identity.ownerOfPin(db, pin);
  const note = (fields) => exec(db, `UPDATE device_access_events SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(fields), eventId]);
  if (!owner) {
    await sync.noteUnlinked(db, device.id, { pin, source: 'scan' }, now);
    await note({ attendance_note: 'unlinked_pin' });
    return null;
  }
  await note({ member_id: owner.memberId });
  if (owner.retired) {
    // A deleted member's PIN still opens the door: take it off now.
    if (result === 'granted') {
      await sync.logError(db, device.id, { kind: 'granted_retired_pin', data: { eventId: Number(eventId) } }, now);
      await sync.forceRemove(db, device.id, owner.memberId, pin, { priority: 0, now });
    }
    await note({ attendance_note: 'retired_pin' });
    return null;
  }

  const want = (await sync.desiredFor(db, device, [owner.memberId], { now })).get(owner.memberId) || { desired: false };
  if (result === 'denied') {
    // §7.3 point 6: the device refused someone GymsEra admits → drift; send them again.
    if (want.desired) {
      const [row] = await select(db, 'SELECT pending_batch_id FROM device_member_sync WHERE device_id = ? AND member_id = ?', [device.id, owner.memberId]);
      if (!row?.pending_batch_id) {
        await sync.logError(db, device.id, { kind: 'denied_but_desired', data: { eventId: Number(eventId) } }, now);
        await sync.forceResend(db, device.id, owner.memberId, { priority: 5, now });
      }
    }
    return null;
  }
  if (result !== 'granted') return null;

  // §7.4 layer 4: the device let in someone GymsEra does not admit → alert and remove at once.
  if (!want.desired) {
    const res = await sync.applyOne(db, device, owner.memberId, want, { priority: 0, now });
    if (res !== 'held') {
      await sync.logError(db, device.id, { kind: 'granted_not_desired', data: { eventId: Number(eventId) } }, now);
      if (res !== 'queued') await sync.forceRemove(db, device.id, owner.memberId, pin, { priority: 0, now });
    }
  }

  const direction = device.direction === 'both' ? (inout === 1 ? 'out' : 'in') : device.direction;
  try {
    const { deviceScan } = require('../attendance.service');
    const out = await deviceScan(db, { deviceId: device.id, userId: owner.memberId, branchId: device.branch_id, eventTime: utc, direction });
    await note({ attendance_id: out.log.id, attendance_note: out.duplicate ? 'duplicate' : direction === 'out' ? 'check_out' : 'check_in' });
    if (out.visitsLeft === 0) await sync.reconcileMember(db, owner.memberId, 'visits_used', { now });
    if (out.duplicate) return 'duplicate';
    return direction === 'out' ? 'check_out' : 'check_in';
  } catch (err) {
    await note({ attendance_note: String(err.code || 'attendance_refused').slice(0, 40) });
    return null;
  }
}

// ── State and error log ───────────────────────────────────────────────────────
async function ingestState(db, device, body, now = new Date()) {
  const rows = protocol.parseRecords(body);
  for (const r of rows) {
    await exec(db, 'INSERT INTO device_state (device_id, state_json, received_at) VALUES (?, ?, ?)', [device.id, JSON.stringify(r), now]);
  }
  return rows;
}

async function ingestErrorlog(db, device, body, now = new Date()) {
  const rows = protocol.parseRecords(body, { table: 'errorlog' });
  for (const r of rows) {
    await exec(
      db,
      'INSERT INTO device_error_logs (device_id, source, kind, code, message, data_json, occurred_at, created_at) VALUES (?, \'device\', \'device_errorlog\', ?, ?, ?, ?, ?)',
      [device.id, int(r.errcode), r.errmsg ? protocol.redact(String(r.errmsg)).slice(0, 255) : null,
        JSON.stringify({ dataorigin: r.dataorigin || null, cmdid: r.cmdid || null }), now, now]
    );
  }
  return rows.length;
}

// ── Users, templates, photos uploaded by the device (§7.5) ────────────────────
async function ingestUsers(db, device, body, now = new Date()) {
  const rows = protocol.parseRecords(body, { table: 'user' });
  for (const r of rows) {
    const pin = String(r.pin || '');
    if (!/^\d{1,9}$/.test(pin)) continue;
    const owner = await identity.ownerOfPin(db, pin);
    if (!owner || owner.retired) {
      if (!owner) await sync.noteUnlinked(db, device.id, { pin, name: r.name, cardNo: r.cardno, source: 'upload' }, now);
      continue;
    }
    // The name on the device is never copied over the member's name.
    if (await identity.adoptCardFromDevice(db, owner.memberId, r.cardno)) await sync.reconcileMember(db, owner.memberId, 'card_from_device', { now });
  }
  return rows.length;
}

async function ingestTemplates(db, tenantId, device, table, body, now = new Date()) {
  const byPin = new Map();
  for (const t of rules.templatesFrom(table, body)) {
    if (!byPin.has(t.pin)) byPin.set(t.pin, []);
    byPin.get(t.pin).push(t);
  }
  let count = 0;
  for (const [pin, list] of byPin) {
    count += list.length;
    const owner = await identity.ownerOfPin(db, pin);
    if (!owner || owner.retired) {
      if (!owner) await sync.noteUnlinked(db, device.id, { pin, source: 'upload' }, now);
      continue;
    }
    const res = await biometrics.storeTemplates(db, { memberId: owner.memberId, deviceId: device.id, templates: list, now });
    await sync.noteDeviceHolds(db, device.id, owner.memberId, res.typesStored, now);
    // Consented: the template goes to the member's other devices (other doors, check-out, branches).
    if (res.stored) await sync.reconcileMember(db, owner.memberId, 'template_from_device', { now });
  }
  return count;
}

async function ingestPhotos(db, tenantId, device, table, body, now = new Date()) {
  const name = String(table).toLowerCase();
  if (name === 'attphoto') {
    // D-6: stored only when the branch opted in; otherwise counted and dropped.
    await require('./device-screens.service').storeCapturePhotos(db, tenantId, device, body, now);
    return protocol.recordCount(body);
  }
  const photos = rules.photosFrom(name, body);
  for (const p of photos) {
    const owner = await identity.ownerOfPin(db, p.pin);
    if (!owner || owner.retired) {
      if (!owner) await sync.noteUnlinked(db, device.id, { pin: p.pin, source: 'upload' }, now);
      continue;
    }
    await biometrics.storePhoto(db, { tenantId, memberId: owner.memberId, deviceId: device.id, photo: p, now });
    if (await biometrics.activeConsent(db, owner.memberId)) await sync.reconcileMember(db, owner.memberId, 'photo_from_device', { now });
  }
  return photos.length;
}

// ── Audit query packs (§8.3 layer 3) ──────────────────────────────────────────
/** querydata?cmdid=&tablename=user&packcnt=&packidx= → PINs stored; the last pack runs the compare. */
async function ingestQuery(db, device, query, body, now = new Date()) {
  const table = String(query.tablename || '').toLowerCase();
  const cmdId = int(query.cmdid);
  if (table !== 'user' || !cmdId) return null;
  const [audit] = await select(db, 'SELECT id, status FROM device_audits WHERE query_cmd_id = ? AND device_id = ?', [cmdId, device.id]);
  if (!audit || audit.status === 'compared') return null;
  for (const r of protocol.parseRecords(body, { table: 'user' })) {
    const pin = String(r.pin || '');
    if (/^\d{1,9}$/.test(pin)) await exec(db, 'INSERT IGNORE INTO device_audit_pins (audit_id, pin) VALUES (?, ?)', [audit.id, pin]);
  }
  const packcnt = int(query.packcnt, 1);
  const packidx = int(query.packidx, 1);
  await exec(db, 'UPDATE device_audits SET status = \'receiving\', packs_expected = ?, packs_received = packs_received + 1 WHERE id = ?', [packcnt, audit.id]);
  if (packidx >= packcnt) return sync.compareAudit(db, device.id, audit.id, now);
  return null;
}

module.exports = {
  localToUtc,
  ingestScans,
  ingestState,
  ingestErrorlog,
  ingestUsers,
  ingestTemplates,
  ingestPhotos,
  ingestQuery,
};
