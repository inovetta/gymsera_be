/**
 * The three device backup layers, plus retention (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §8.3, §14
 * point 6; owner decision D-4). Run by Windows Task Scheduler through run-scheduled-job.js
 * (docs/runbooks/scheduled-jobs.md, docs/runbooks/devices.md), each under its own lock.
 *
 *   device-watchdog   every minute   sent commands with no answer after DEVICE_ACK_TIMEOUT_SECONDS
 *                                    go back to the queue with backoff, then fail; queued past
 *                                    expires_at expire; devices silent DEVICE_OFFLINE_MINUTES are
 *                                    marked offline and the owner is told once per incident
 *   device-sync       every 5 min    each device's full desired-state sweep when its last one is
 *                                    DEVICE_SWEEP_MINUTES old, or a local midnight of its branch has
 *                                    passed since (so expiries are removed within 5 minutes of
 *                                    midnight); failed pairs retried after 1 h, 3 times a day;
 *                                    device outbox rows a crash left behind
 *   device-audit      hourly         once a local day per device, from DEVICE_AUDIT_HOUR (02:00)
 *                                    branch time, staggered by device: DATA COUNT user and DATA
 *                                    QUERY user; the packs are compared in device-ingest. A T&A
 *                                    PUSH device: DATA QUERY USERINFO per PIN, compared by the
 *                                    watchdog once answered (requestAttAudit, finishAttAudits)
 *   device-retention  daily          biometric retention, consent-pending expiry, retired PINs,
 *                                    state history and processed device outbox rows
 *
 * Every job reads the same reconcile functions as the real-time path; only the trigger differs.
 */
const { utc } = require('../services/devices/sql-time');
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { sequelize: platformDb } = require('../database/platform');
const { getDeviceConfig } = require('../config/devices.config');
const rules = require('../services/devices/sync-rules');

const select = (db, sql, replacements) => db.sequelize.query(sql, { replacements: utc(replacements), type: QueryTypes.SELECT });
const exec = (db, sql, replacements) => db.sequelize.query(sql, { replacements: utc(replacements) });

/** [{ tenantId, db }] for every tenant with a device that is not removed. */
async function tenantsWithDevices() {
  const rows = await platformDb.query('SELECT DISTINCT tenant_id FROM access_devices WHERE status <> \'removed\'', { type: QueryTypes.SELECT });
  const { Tenant } = require('../models/platform');
  const TenantDbManager = require('../database/TenantDbManager');
  const out = [];
  for (const { tenant_id: tenantId } of rows) {
    const t = await Tenant.findOne({ where: { id: tenantId, status: 'ACTIVE' }, attributes: ['id', 'connectionStringEncrypted'] });
    if (!t || !t.connectionStringEncrypted || t.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
    try {
      out.push({ tenantId, db: await TenantDbManager.getConnection(tenantId, t.connectionStringEncrypted) });
    } catch (err) {
      console.warn(`[device-jobs] tenant ${tenantId}: no connection (${err.message})`);
    }
  }
  return out;
}

async function eachTenant(name, fn) {
  const totals = {};
  for (const t of await tenantsWithDevices()) {
    try {
      const r = await fn(t);
      for (const [k, v] of Object.entries(r || {})) totals[k] = (totals[k] || 0) + (Number(v) || 0);
    } catch (err) {
      totals.tenantErrors = (totals.tenantErrors || 0) + 1;
      console.error(`[device-jobs] ${name} failed for tenant ${t.tenantId}: ${err.message}`);
    }
  }
  return totals;
}

// ── Layer 1: watchdog ─────────────────────────────────────────────────────────
async function watchdogTenant({ tenantId, db }, now = new Date()) {
  const cfg = getDeviceConfig();
  const sync = require('../services/devices/device-sync.service');
  const counts = { requeued: 0, failed: 0, expired: 0, offline: 0, online: 0 };
  const stale = await select(db, 'SELECT * FROM device_commands WHERE status = \'sent\' AND sent_at < ?', [new Date(now.getTime() - cfg.ackTimeoutSeconds * 1000)]);
  for (const cmd of stale) {
    const wait = rules.backoffSeconds(Number(cmd.attempts));
    if (wait !== null && Number(cmd.attempts) < cfg.maxAttempts) {
      await exec(db, 'UPDATE device_commands SET status = \'queued\', claim_token = NULL, merged_into = NULL, not_before = ?, updated_at = ? WHERE id = ? AND status = \'sent\'',
        [new Date(now.getTime() + wait * 1000), now, cmd.id]);
      counts.requeued += 1;
    } else {
      await exec(db, 'UPDATE device_commands SET status = \'failed\', updated_at = ? WHERE id = ? AND status = \'sent\'', [now, cmd.id]);
      await sync.logError(db, cmd.device_id, { kind: 'no_answer', data: { commandId: Number(cmd.id), kind: cmd.kind, attempts: Number(cmd.attempts) } }, now);
      if (cmd.batch_id && cmd.member_id) await sync.settleBatch(db, cmd.device_id, cmd.member_id, cmd.batch_id, now);
      counts.failed += 1;
    }
  }
  const expired = await select(db, 'SELECT id, device_id, member_id, batch_id FROM device_commands WHERE status = \'queued\' AND expires_at IS NOT NULL AND expires_at <= ?', [now]);
  for (const cmd of expired) {
    await exec(db, 'UPDATE device_commands SET status = \'expired\', updated_at = ? WHERE id = ? AND status = \'queued\'', [now, cmd.id]);
    if (cmd.batch_id && cmd.member_id) await sync.settleBatch(db, cmd.device_id, cmd.member_id, cmd.batch_id, now);
    counts.expired += 1;
  }

  // Offline: no contact for DEVICE_OFFLINE_MINUTES. One owner notification per incident.
  const devices = await platformDb.query(
    'SELECT id, last_seen_at, status FROM access_devices WHERE tenant_id = ? AND status = \'active\'',
    { replacements: utc([tenantId]), type: QueryTypes.SELECT }
  );
  const limit = now.getTime() - cfg.offlineMinutes * 60000;
  for (const d of devices) {
    const [det] = await select(db, 'SELECT id, name, enabled, offline_since, offline_notified_at FROM access_device_details WHERE id = ?', [d.id]);
    if (!det || !Number(det.enabled)) continue;
    const silent = !d.last_seen_at || new Date(d.last_seen_at).getTime() < limit;
    if (silent && !det.offline_since) {
      await exec(db, 'UPDATE access_device_details SET offline_since = ? WHERE id = ?', [d.last_seen_at || now, d.id]);
    }
    if (silent && !det.offline_notified_at) {
      // The incident is recorded either way; the owner is told only when the branch keeps alerts on.
      if (await alertsOn(db, d.id)) await notifyOwnerOffline(tenantId, det, d.last_seen_at);
      await exec(db, 'UPDATE access_device_details SET offline_notified_at = ? WHERE id = ?', [now, d.id]);
      counts.offline += 1;
    }
    if (!silent && (det.offline_since || det.offline_notified_at)) {
      await exec(db, 'UPDATE access_device_details SET offline_since = NULL, offline_notified_at = NULL WHERE id = ?', [d.id]);
      counts.online += 1;
    }
  }

  // Phase 3: manual push requests nobody polled to the end, wipes, per-device owner alerts.
  counts.pushClosed = await require('../services/devices/device-push.service').closeExpired(db, now)
    .catch((err) => { console.warn(`[device-jobs] push requests: ${err.message}`); return 0; });
  counts.wipesFinished = await finishWipes({ tenantId, db }, now);
  // T&A PUSH audits (requestAttAudit): compared once every query is answered.
  const att = await finishAttAudits(db, now).catch((err) => { console.warn(`[device-jobs] att audits: ${err.message}`); return { compared: 0, incomplete: 0 }; });
  counts.attAuditsCompared = att.compared;
  const alerted = await deviceAlerts({ tenantId, db }, now);
  counts.errorAlerts = alerted.errors;
  counts.capacityAlerts = alerted.capacity;
  return counts;
}

/** Wiping devices (§10.3): removed when the deletes are answered, or when the wait is over. */
async function finishWipes({ tenantId, db }, now = new Date()) {
  const cfg = getDeviceConfig();
  const registry = require('../services/devices/device-registry.service');
  const rows = await platformDb.query('SELECT id FROM access_devices WHERE tenant_id = ? AND status = \'wiping\'', { replacements: utc([tenantId]), type: QueryTypes.SELECT });
  let n = 0;
  for (const { id } of rows) {
    const [first] = await select(db, 'SELECT MIN(created_at) AS at FROM device_commands WHERE device_id = ? AND kind = \'wipe\'', [id]);
    const waited = !first?.at || new Date(first.at).getTime() < now.getTime() - cfg.wipeWaitDays * 86400000;
    if (await registry.finishWipe({ tenantId, tenantDb: db, deviceId: id, force: waited, now })) n += 1;
  }
  return n;
}

/** The branch's "owner alerts" switch (device_branch_settings, default on). */
async function alertsOn(db, deviceId) {
  const [row] = await select(db, `SELECT s.alerts_enabled FROM access_device_details d LEFT JOIN device_branch_settings s ON s.branch_id = d.branch_id
    WHERE d.id = ?`, [deviceId]).catch(() => []);
  return !row || row.alerts_enabled === null || Number(row.alerts_enabled) === 1;
}

const parseJson = (text) => {
  try {
    return text ? JSON.parse(text) : {};
  } catch (_) {
    return {};
  }
};

/**
 * Per-device owner alerts (spec §13), one notification per incident, only where the branch keeps
 * alerts on:
 *   error rate  DEVICE_ALERT_ERRORS_PER_HOUR failures or device errors in the last hour (again after 24 h)
 *   capacity    users or templates on it reach 90% of MaxUserCount / MaxMultiBioDataCount
 *               (again once it has dropped below 85%)
 *   serial      another device presented this device's key (Phase 4, §14 point 4), once per incident
 * When each went out is kept in access_device_details.alerts_json.
 */
async function deviceAlerts({ tenantId, db }, now = new Date()) {
  const cfg = getDeviceConfig();
  const out = { errors: 0, capacity: 0, serial: 0 };
  const active = await platformDb.query('SELECT id, serial_mismatch_at FROM access_devices WHERE tenant_id = ? AND status = \'active\'', { replacements: utc([tenantId]), type: QueryTypes.SELECT });
  for (const { id, serial_mismatch_at: mismatchAt } of active) {
    const [det] = await select(db, 'SELECT id, name, enabled, capabilities_json, counts_json, alerts_json FROM access_device_details WHERE id = ?', [id]);
    if (!det || !Number(det.enabled)) continue;
    const state = parseJson(det.alerts_json);
    const before = JSON.stringify(state);
    const on = await alertsOn(db, id);

    const [errs] = await select(db, 'SELECT COUNT(*) AS n FROM device_error_logs WHERE device_id = ? AND created_at >= ?', [id, new Date(now.getTime() - 3600000)]);
    const errorCount = Number(errs.n);
    const lastErr = state.errorRateAt ? new Date(state.errorRateAt).getTime() : 0;
    if (errorCount >= cfg.alertErrorsPerHour && now.getTime() - lastErr >= 86400000) {
      if (on) {
        await notifyOwner(tenantId, det, 'device_error_rate', 'Access device reporting errors',
          `${det.name} reported ${errorCount} errors in the last hour. Open the device's Errors tab to see what failed.`);
        out.errors += 1;
      }
      state.errorRateAt = now.toISOString();
    }

    // Phase 4 (§14 point 4): another device presented this device's key (a copied key, or the device was
    // replaced without a re-pair). One alert per incident: a newer mismatch is a new incident. The other
    // serial is on the device page, not in the notification.
    if (mismatchAt && (!state.serialMismatchAt || new Date(mismatchAt).getTime() > new Date(state.serialMismatchAt).getTime())) {
      if (on) {
        await notifyOwner(tenantId, det, 'device_serial_mismatch', 'Access device key used by another device',
          `Another device tried to connect with the key of ${det.name}. If you replaced the device, re-pair it on its page; if not, re-pair it now so the old key stops working.`);
        out.serial += 1;
      }
      state.serialMismatchAt = new Date(mismatchAt).toISOString();
    }

    const use = await capacityUse(db, id, parseJson(det.capabilities_json), parseJson(det.counts_json));
    const percent = use ? Math.round(use.ratio * 100) : null;
    if (use && use.ratio >= cfg.capacityAlertPercent / 100 && !state.capacityAt) {
      if (on) {
        await notifyOwner(tenantId, det, 'device_capacity', 'Access device almost full',
          `${det.name} is at ${percent}% of its ${use.what} capacity (${use.used} of ${use.max}). Remove old users or add a device.`);
        out.capacity += 1;
      }
      state.capacityAt = now.toISOString();
    } else if (state.capacityAt && (!use || use.ratio < (cfg.capacityAlertPercent - 5) / 100)) {
      delete state.capacityAt;
    }
    if (JSON.stringify(state) !== before) await exec(db, 'UPDATE access_device_details SET alerts_json = ? WHERE id = ?', [JSON.stringify(state), id]);
  }
  return out;
}

/**
 * The fullest of users (MaxUserCount) and each template type (MaxMultiBioDataCount). null when unknown.
 * Users: what GymsEra wants on it plus the device users it does not manage (unlinked, e.g. left by
 * GymBioSync), or the device's own UserCount when that is higher (Phase 4: it counts what is really there).
 */
async function capacityUse(db, deviceId, caps, counts = {}) {
  const candidates = [];
  const maxUsers = Number(caps.MaxUserCount);
  const [u] = await select(db, 'SELECT COUNT(*) AS n FROM device_member_sync WHERE device_id = ? AND desired = 1', [deviceId]);
  const [x] = await select(db, 'SELECT COUNT(*) AS n FROM device_unlinked_users WHERE device_id = ? AND dismissed_at IS NULL AND linked_member_id IS NULL', [deviceId]);
  const reported = Number(counts.UserCount);
  const users = Math.max(Number(u.n) + Number(x.n), Number.isFinite(reported) ? reported : 0);
  if (maxUsers > 0) candidates.push({ what: 'user', used: users, max: maxUsers });
  const maxBio = String(caps.MaxMultiBioDataCount || '').split(':').map(Number);
  if (maxBio.some((v) => v > 0)) {
    const rows = await select(db, `SELECT b.bio_type, COUNT(*) AS n FROM member_biometrics b JOIN device_member_sync s ON s.member_id = b.member_id
      WHERE s.device_id = ? AND s.desired = 1 AND b.consent_pending = 0 AND b.import_hold = 0 GROUP BY b.bio_type`, [deviceId]);
    for (const r of rows) {
      const max = maxBio[Number(r.bio_type)];
      if (max > 0) candidates.push({ what: Number(r.bio_type) === 9 || Number(r.bio_type) === 2 ? 'face' : Number(r.bio_type) === 1 ? 'fingerprint' : 'template', used: Number(r.n), max });
    }
  }
  if (!candidates.length) return null;
  return candidates.map((c) => ({ ...c, ratio: c.used / c.max })).sort((a, b) => b.ratio - a.ratio)[0];
}

async function notifyOwner(tenantId, det, type, title, message) {
  try {
    const { Tenant } = require('../models/platform');
    const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'ownerUserId'] });
    if (!tenant?.ownerUserId) return;
    await require('../services/notifications.service').createNotification({
      userId: tenant.ownerUserId, role: 'host', type, title, message, deepLink: '/host/devices', metadataJson: { deviceId: det.id },
    });
  } catch (err) {
    console.warn(`[device-jobs] ${type} notification failed: ${err.message}`);
  }
}

async function notifyOwnerOffline(tenantId, det, lastSeenAt) {
  try {
    const { Tenant } = require('../models/platform');
    const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'ownerUserId'] });
    if (!tenant?.ownerUserId) return;
    await require('../services/notifications.service').createNotification({
      userId: tenant.ownerUserId,
      role: 'host',
      type: 'device_offline',
      title: 'Access device offline',
      message: `${det.name} has not contacted GymsEra since ${lastSeenAt ? new Date(lastSeenAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'it was added'}. Check its power and network.`,
      deepLink: '/host/devices',
      metadataJson: { deviceId: det.id },
    });
  } catch (err) {
    console.warn(`[device-jobs] offline notification failed: ${err.message}`);
  }
}

/** Platform alerts from what the devices reported in the last hour (IDs and counts only, OBS-06). */
async function raiseAlerts(now = new Date()) {
  const alerts = require('../services/alert.service');
  const since = new Date(now.getTime() - 3600000);
  const found = { device_storage_full: new Set(), granted_not_desired: new Set() };
  for (const { db } of await tenantsWithDevices()) {
    const rows = await select(db, 'SELECT DISTINCT kind, device_id FROM device_error_logs WHERE kind IN (\'device_storage_full\', \'granted_not_desired\', \'granted_retired_pin\') AND created_at >= ?', [since]).catch(() => []);
    for (const r of rows) (found[r.kind === 'granted_retired_pin' ? 'granted_not_desired' : r.kind]).add(r.device_id);
  }
  if (found.device_storage_full.size) await alerts.raise('DEVICE_STORAGE_FULL', { deviceCount: found.device_storage_full.size, deviceIds: [...found.device_storage_full] });
  if (found.granted_not_desired.size) await alerts.raise('DEVICE_GRANTED_NOT_DESIRED', { deviceCount: found.granted_not_desired.size, deviceIds: [...found.granted_not_desired] });
}

async function runWatchdog(now = new Date()) {
  const totals = await eachTenant('device-watchdog', (t) => watchdogTenant(t, now));
  await raiseAlerts(now).catch((err) => console.warn(`[device-jobs] alerts: ${err.message}`));
  return totals;
}

// ── Layer 2: desired-state sweep ──────────────────────────────────────────────
async function syncTenant({ db }, now = new Date()) {
  const cfg = getDeviceConfig();
  const sync = require('../services/devices/device-sync.service');
  const triggers = require('../services/devices/device-triggers');
  const { computeBusinessDate } = require('../services/ledger.service');
  const counts = { outbox: await triggers.sweepOutbox(db), devicesSwept: 0, queued: 0 };
  for (const device of await sync.devicesOf(db)) {
    const tz = device.branch_timezone || 'Asia/Karachi';
    const last = device.last_sweep_at ? new Date(device.last_sweep_at) : null;
    const due = !last
      || now.getTime() - last.getTime() >= cfg.sweepMinutes * 60000
      || computeBusinessDate(last, tz) !== computeBusinessDate(now, tz); // a local midnight passed
    if (!due) continue;
    const r = await sync.reconcileDevice(db, device.id, 'sweep', { now });
    counts.devicesSwept += 1;
    counts.queued += r.queued;
  }
  return counts;
}

const runSync = (now = new Date()) => eachTenant('device-sync', (t) => syncTenant(t, now));

// ── Layer 3: nightly audit ────────────────────────────────────────────────────
/** Minutes after DEVICE_AUDIT_HOUR this device starts (0 to 59), so devices do not all ask at once. */
const staggerOf = (deviceId) => crypto.createHash('sha256').update(String(deviceId)).digest()[0] % 60;

async function auditTenant({ tenantId, db }, now = new Date()) {
  const cfg = getDeviceConfig();
  const sync = require('../services/devices/device-sync.service');
  const { computeBusinessDate } = require('../services/ledger.service');
  const counts = { requested: 0, incomplete: 0 };
  // Audits that never got their packs.
  const [, meta] = await exec(db, 'UPDATE device_audits SET status = \'incomplete\', finished_at = ? WHERE status IN (\'requested\', \'receiving\') AND started_at < ?',
    [now, new Date(now.getTime() - 6 * 3600000)]);
  counts.incomplete = typeof meta === 'number' ? meta : meta?.affectedRows || 0;

  const active = new Set((await platformDb.query('SELECT id FROM access_devices WHERE tenant_id = ? AND status = \'active\'', { replacements: utc([tenantId]), type: QueryTypes.SELECT })).map((r) => r.id));
  for (const device of await sync.devicesOf(db)) {
    if (!active.has(device.id)) continue;
    const tz = device.branch_timezone || 'Asia/Karachi';
    const local = rules.localParts(now, tz);
    if (local.hour * 60 + local.minute < cfg.auditHour * 60 + staggerOf(device.id)) continue;
    const today = computeBusinessDate(now, tz);
    const [last] = await select(db, 'SELECT started_at FROM device_audits WHERE device_id = ? ORDER BY started_at DESC LIMIT 1', [device.id]);
    if (last && computeBusinessDate(new Date(last.started_at), tz) === today) continue;
    await requestAudit(db, device.id, now);
    counts.requested += 1;
  }
  return counts;
}

/**
 * Queues the audit of one device and the audit row it reports into.
 *   acc   DATA COUNT user and DATA QUERY user (querydata packs, compared at the last pack).
 *   att   (T&A PUSH) checklist (i), 2026-11-14: that firmware answers DATA COUNT -1002 and DATA QUERY user -1004.
 *         One DATA QUERY USERINFO PIN=<pin> per PIN GymsEra has a sync row for on this device (answered with
 *         Return 0 and, when the device has the user, an OPERLOG USER upload: ingest#feedAudit); the device's
 *         own user count is the one in its DEVICE INFO. The row has no count / query command (that marks it as
 *         an att audit) and its queries share one batch id (report_json.batchId). finishAttAudits compares it.
 */
async function requestAudit(db, deviceId, now = new Date()) {
  const [det] = await select(db, 'SELECT device_type, counts_json FROM access_device_details WHERE id = ?', [deviceId]);
  if (String(det?.device_type || '').toLowerCase() === 'att') return requestAttAudit(db, deviceId, det, now);
  const ids = [];
  for (const [kind, args] of [['count', { table: 'user', audit: true }], ['query_users', { audit: true }]]) {
    await exec(db, `INSERT INTO device_commands (device_id, kind, args_json, priority, status, attempts, not_before, created_at, updated_at)
      VALUES (?, ?, ?, 9, 'queued', 0, ?, ?, ?)`, [deviceId, kind, JSON.stringify(args), new Date(Math.min(now.getTime(), Date.now()) - 1000), now, now]);
    const [row] = await select(db, 'SELECT MAX(id) AS id FROM device_commands WHERE device_id = ? AND kind = ?', [deviceId, kind]);
    ids.push(Number(row.id));
  }
  await exec(db, 'INSERT INTO device_audits (device_id, status, count_cmd_id, query_cmd_id, started_at) VALUES (?, \'requested\', ?, ?, ?)', [deviceId, ids[0], ids[1], now]);
  const [audit] = await select(db, 'SELECT MAX(id) AS id FROM device_audits WHERE device_id = ?', [deviceId]);
  return { auditId: Number(audit.id), countCmdId: ids[0], queryCmdId: ids[1] };
}

const ATT_AUDIT_SETTLE_SECONDS = 30; // after the last answer, before the compare (an upload may trail its result)

/** DEVICE INFO user count of an att device (access_device_details.counts_json, registry#applyInfo), or null. */
const infoUserCount = (det) => {
  const n = Number(parseJson(det?.counts_json).UserCount);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

async function requestAttAudit(db, deviceId, det, now) {
  const batchId = crypto.randomBytes(13).toString('hex').toUpperCase();
  const pins = (await select(db, 'SELECT DISTINCT pin FROM device_member_sync WHERE device_id = ? AND pin IS NOT NULL ORDER BY pin', [deviceId]))
    .map((r) => String(r.pin)).filter((p) => /^\d{1,9}$/.test(p));
  await exec(db, `INSERT INTO device_audits (device_id, status, count_cmd_id, query_cmd_id, packs_expected, device_user_count, report_json, started_at)
    VALUES (?, 'requested', NULL, NULL, ?, ?, ?, ?)`, [deviceId, pins.length, infoUserCount(det), JSON.stringify({ mode: 'userinfo', batchId }), now]);
  const [audit] = await select(db, 'SELECT MAX(id) AS id FROM device_audits WHERE device_id = ?', [deviceId]);
  const auditId = Number(audit.id);
  const due = new Date(Math.min(now.getTime(), Date.now()) - 1000);
  for (const pin of pins) {
    await exec(db, `INSERT INTO device_commands (device_id, batch_id, kind, args_json, priority, status, attempts, not_before, created_at, updated_at)
      VALUES (?, ?, 'query_userinfo', ?, 9, 'queued', 0, ?, ?, ?)`, [deviceId, batchId, JSON.stringify({ pin, audit: true, auditId }), due, now, now]);
  }
  // Nothing to ask: compared at once (nothing GymsEra placed there; uploads of unknown users still list them).
  if (!pins.length) await require('../services/devices/device-sync.service').compareAudit(db, deviceId, auditId, now);
  return { auditId, countCmdId: null, queryCmdId: null, queries: pins.length };
}

/**
 * Att audits whose queries are all answered (requestAttAudit). Compared ATT_AUDIT_SETTLE_SECONDS after the last
 * answer, with the PINs the device uploaded; any query that failed, expired or was superseded makes the audit
 * incomplete (a missing answer must never look like a missing user). The DEVICE INFO count is taken again.
 */
async function finishAttAudits(db, now = new Date()) {
  const sync = require('../services/devices/device-sync.service');
  const out = { compared: 0, incomplete: 0 };
  const open = await select(db, `SELECT a.id, a.device_id, a.report_json, d.counts_json FROM device_audits a JOIN access_device_details d ON d.id = a.device_id
    WHERE a.status IN ('requested', 'receiving') AND a.query_cmd_id IS NULL AND a.count_cmd_id IS NULL`, []);
  for (const a of open) {
    const batchId = parseJson(a.report_json).batchId;
    if (!batchId) continue;
    const cmds = await select(db, 'SELECT status, acked_at FROM device_commands WHERE device_id = ? AND batch_id = ? AND kind = \'query_userinfo\'', [a.device_id, batchId]);
    if (cmds.some((c) => c.status === 'queued' || c.status === 'sent')) continue;
    if (cmds.some((c) => c.status !== 'acked')) {
      await exec(db, 'UPDATE device_audits SET status = \'incomplete\', finished_at = ? WHERE id = ? AND status IN (\'requested\', \'receiving\')', [now, a.id]);
      out.incomplete += 1;
      continue;
    }
    const last = Math.max(0, ...cmds.map((c) => (c.acked_at ? new Date(c.acked_at).getTime() : 0)));
    if (now.getTime() - last < ATT_AUDIT_SETTLE_SECONDS * 1000) continue;
    await exec(db, 'UPDATE device_audits SET device_user_count = COALESCE(?, device_user_count), packs_received = ? WHERE id = ?', [infoUserCount(a), cmds.length, a.id]);
    await sync.compareAudit(db, a.device_id, a.id, now);
    out.compared += 1;
  }
  return out;
}

const runAudit = (now = new Date()) => eachTenant('device-audit', (t) => auditTenant(t, now));

// ── Retention (D-4, §6.3, §7.5) ───────────────────────────────────────────────
async function retentionTenant({ db }, now = new Date()) {
  const cfg = getDeviceConfig();
  const biometrics = require('../services/devices/biometric.service');
  const identity = require('../services/devices/device-identity.service');
  const sync = require('../services/devices/device-sync.service');
  const r = await biometrics.retentionSweep(db, now);
  for (const m of new Set([...r.pendingExpired, ...r.retained])) await sync.reconcileMember(db, m, 'retention', { now });
  const purged = await identity.purgeRetired(db, cfg.pinRetireDays, now);
  // D-6: capture photos are kept 30 days.
  const photos = await require('../services/devices/device-screens.service').deleteCapturePhotos(db, { olderThan: new Date(now.getTime() - cfg.capturePhotoDays * 86400000) })
    .catch((err) => { console.warn(`[device-jobs] capture photo retention: ${err.message}`); return 0; });
  // Phase 4: imports nobody finished; staging templates of finished imports emptied.
  const imports = await require('../services/devices/device-import.service').housekeeping(db, now)
    .catch((err) => { console.warn(`[device-jobs] import housekeeping: ${err.message}`); return { failed: 0, expired: 0, purged: 0 }; });
  const week = new Date(now.getTime() - 7 * 86400000);
  await exec(db, 'DELETE FROM device_state WHERE received_at < ?', [week]);
  await exec(db, 'DELETE FROM capacity_outbox WHERE event_type = \'DEVICE_RECONCILE\' AND status = \'PROCESSED\' AND processed_at < ?', [week]);
  return { pendingExpired: r.pendingExpired.length, retained: r.retained.length, pinsPurged: purged, capturePhotosDeleted: photos,
    importsFailed: imports.failed, importsExpired: imports.expired, importTemplatesPurged: imports.purged };
}

const runRetention = (now = new Date()) => eachTenant('device-retention', (t) => retentionTenant(t, now));

module.exports = {
  tenantsWithDevices,
  runWatchdog,
  runSync,
  runAudit,
  runRetention,
  watchdogTenant,
  syncTenant,
  auditTenant,
  retentionTenant,
  requestAudit,
  finishAttAudits,
  staggerOf,
  deviceAlerts,
  finishWipes,
};
