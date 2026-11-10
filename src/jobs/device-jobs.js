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
 *                                    QUERY user; the packs are compared in device-ingest
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
      await exec(db, 'UPDATE device_commands SET status = \'queued\', claim_token = NULL, not_before = ?, updated_at = ? WHERE id = ? AND status = \'sent\'',
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
      await notifyOwnerOffline(tenantId, det, d.last_seen_at);
      await exec(db, 'UPDATE access_device_details SET offline_notified_at = ? WHERE id = ?', [now, d.id]);
      counts.offline += 1;
    }
    if (!silent && (det.offline_since || det.offline_notified_at)) {
      await exec(db, 'UPDATE access_device_details SET offline_since = NULL, offline_notified_at = NULL WHERE id = ?', [d.id]);
      counts.online += 1;
    }
  }
  return counts;
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

/** Queues DATA COUNT user and DATA QUERY user for one device, and the audit row they report into. */
async function requestAudit(db, deviceId, now = new Date()) {
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
  const week = new Date(now.getTime() - 7 * 86400000);
  await exec(db, 'DELETE FROM device_state WHERE received_at < ?', [week]);
  await exec(db, 'DELETE FROM capacity_outbox WHERE event_type = \'DEVICE_RECONCILE\' AND status = \'PROCESSED\' AND processed_at < ?', [week]);
  return { pendingExpired: r.pendingExpired.length, retained: r.retained.length, pinsPurged: purged };
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
  staggerOf,
};
