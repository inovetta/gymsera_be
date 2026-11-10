/**
 * What the device screens read and the small changes they make (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md
 * §7.5, §10.3, §10.5, owner decisions D-5, D-6).
 *
 *   accessEvents     the live feed (3-second poll): granted and denied scans, including scans stored
 *                    without a check-in (D-5 'member_checkin_grace_expired', duplicates, refused)
 *   deviceMembers    who is on the device, with the sync state of each
 *   deviceErrors     the device's errorlog uploads and what the server saw
 *   deviceCommands   the command log (never the command text: no templates)
 *   deviceAudits     the nightly audit reports (layer 3) and the device's audit trail
 *   unlinked users   PINs the device knows that are no member: list, link to a member, dismiss
 *   branchSettings   capture photos (D-6, off by default) and owner alerts (on)
 *   capture photos   ATTPHOTO stored only for a branch that opted in, 30 days, encrypted
 *
 * Member names come from the platform users table; nothing here returns a template, a photo body
 * in JSON, or a device secret. `db` = a tenant connection { sequelize, models, tenantId }.
 */
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { utc } = require('./sql-time');
const { getDeviceConfig } = require('../../config/devices.config');
const { createError } = require('../../utils/response.utils');
const protocol = require('./push-protocol');

const select = (db, sql, replacements) => db.sequelize.query(sql, { replacements: utc(replacements), type: QueryTypes.SELECT });
const exec = (db, sql, replacements) => db.sequelize.query(sql, { replacements: utc(replacements) });
const parse = (text, fallback = null) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch (_) {
    return fallback;
  }
};
const clampInt = (v, def, min, max) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : def;
};
const storage = () => require('../kyc-storage.service'); // the private store (as biometric.service)
const bioCrypto = () => require('../../utils/biometric-crypto');

async function namesOf(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const { User } = require('../../models/platform');
  return new Map((await User.findAll({ where: { id: list }, attributes: ['id', 'fullName'], raw: true })).map((u) => [u.id, u.fullName]));
}

async function deviceNames(db, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  return new Map((await select(db, 'SELECT id, name FROM access_device_details WHERE id IN (?)', [list])).map((d) => [d.id, d.name]));
}

// ── Live feed (§10.3, §10.5) ──────────────────────────────────────────────────
/** Newest first. afterId: only events after it (the 3-second poll). → { events, latestId } */
async function accessEvents(db, { branchId = null, deviceId = null, afterId = null, limit = 50 }) {
  const n = clampInt(limit, 50, 1, 200);
  const where = [];
  const rep = [];
  if (deviceId) { where.push('e.device_id = ?'); rep.push(deviceId); }
  if (branchId) { where.push('e.branch_id = ?'); rep.push(branchId); }
  if (afterId !== null && afterId !== undefined && afterId !== '') { where.push('e.id > ?'); rep.push(clampInt(afterId, 0, 0, Number.MAX_SAFE_INTEGER)); }
  const rows = await select(
    db,
    `SELECT e.*, p.id AS photo_id FROM device_access_events e LEFT JOIN device_capture_photos p ON p.event_id = e.id
      WHERE ${where.length ? where.join(' AND ') : '1=1'} ORDER BY e.id DESC LIMIT ?`,
    [...rep, n]
  );
  const names = await namesOf(rows.map((r) => r.member_id));
  const devs = await deviceNames(db, rows.map((r) => r.device_id));
  const events = rows.map((r) => ({
    id: Number(r.id),
    deviceId: r.device_id,
    deviceName: devs.get(r.device_id) || null,
    branchId: r.branch_id,
    time: r.utc_time,
    localTime: r.device_time,
    pin: r.pin,
    memberId: r.member_id,
    memberName: r.member_id ? names.get(r.member_id) || null : null,
    result: r.result,
    reason: r.reason,
    attendanceNote: r.attendance_note,
    checkedIn: Boolean(r.attendance_id) && ['check_in', 'check_out'].includes(r.attendance_note),
    photoId: r.photo_id ? Number(r.photo_id) : null,
  }));
  const [latest] = await select(db, `SELECT MAX(id) AS id FROM device_access_events e WHERE ${deviceId ? 'e.device_id = ?' : branchId ? 'e.branch_id = ?' : '1=1'}`, deviceId ? [deviceId] : branchId ? [branchId] : []);
  return { events, latestId: latest?.id ? Number(latest.id) : null };
}

// ── Device tabs (§10.3) ───────────────────────────────────────────────────────
const MEMBER_STATES = ['in_sync', 'pending_add', 'pending_update', 'pending_remove', 'failed', 'removed'];

/** Members on (or on their way to / off) one device. state: one of MEMBER_STATES, 'pending' or 'on_device'. */
async function deviceMembers(db, deviceId, { state = null, limit = 100, offset = 0 } = {}) {
  const where = ['device_id = ?'];
  const rep = [deviceId];
  if (state === 'pending') where.push('state IN (\'pending_add\', \'pending_update\', \'pending_remove\')');
  else if (state === 'on_device') where.push('state <> \'removed\'');
  else if (MEMBER_STATES.includes(state)) { where.push('state = ?'); rep.push(state); }
  const n = clampInt(limit, 100, 1, 500);
  const o = clampInt(offset, 0, 0, 1000000);
  const rows = await select(db, `SELECT member_id, pin, desired, state, last_return_code, last_error_at, updated_at FROM device_member_sync
    WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...rep, n, o]);
  const counts = await select(db, 'SELECT state, COUNT(*) AS n FROM device_member_sync WHERE device_id = ? GROUP BY state', [deviceId]);
  const names = await namesOf(rows.map((r) => r.member_id));
  const by = Object.fromEntries(counts.map((c) => [c.state, Number(c.n)]));
  const reasonOf = require('./device-push.service').reasonOfCode;
  return {
    counts: {
      inSync: by.in_sync || 0,
      pending: (by.pending_add || 0) + (by.pending_update || 0) + (by.pending_remove || 0),
      failed: by.failed || 0,
      removed: by.removed || 0,
    },
    members: rows.map((r) => ({
      memberId: r.member_id,
      name: names.get(r.member_id) || null,
      pin: String(r.pin),
      shouldBeOnDevice: Boolean(Number(r.desired)),
      state: r.state,
      lastReturnCode: r.last_return_code,
      failedReason: r.state === 'failed' ? (r.last_return_code === null ? 'no_answer' : reasonOf(r.last_return_code)) : null,
      lastErrorAt: r.last_error_at,
      updatedAt: r.updated_at,
    })),
  };
}

async function deviceErrors(db, deviceId, { limit = 50 } = {}) {
  const rows = await select(db, 'SELECT id, source, kind, code, message, occurred_at FROM device_error_logs WHERE device_id = ? ORDER BY id DESC LIMIT ?',
    [deviceId, clampInt(limit, 50, 1, 200)]);
  return { errors: rows.map((r) => ({ id: Number(r.id), source: r.source, kind: r.kind, code: r.code, message: r.message, occurredAt: r.occurred_at })) };
}

const COMMAND_STATUSES = ['queued', 'sent', 'acked', 'failed', 'expired', 'superseded'];

async function deviceCommands(db, deviceId, { status = null } = {}) {
  const filter = COMMAND_STATUSES.includes(status);
  const rows = await select(db, `SELECT id, kind, status, return_code, member_id, attempts, priority, push_request_id, created_at, sent_at, acked_at
    FROM device_commands WHERE device_id = ?${filter ? ' AND status = ?' : ''} ORDER BY id DESC LIMIT 200`, filter ? [deviceId, status] : [deviceId]);
  const names = await namesOf(rows.map((r) => r.member_id));
  return {
    commands: rows.map((r) => ({
      id: Number(r.id), kind: r.kind, status: r.status, returnCode: r.return_code, memberId: r.member_id, memberName: r.member_id ? names.get(r.member_id) || null : null,
      attempts: Number(r.attempts), priority: Number(r.priority), pushRequestId: r.push_request_id, createdAt: r.created_at, sentAt: r.sent_at, ackedAt: r.acked_at,
    })),
  };
}

/** Audit tab: the layer 3 reports, and who did what to this device (tenant audit log). */
async function deviceAudits(db, deviceId) {
  const reports = await select(db, `SELECT id, status, device_user_count, desired_count, extra_count, missing_count, unlinked_count, started_at, finished_at
    FROM device_audits WHERE device_id = ? ORDER BY id DESC LIMIT 30`, [deviceId]);
  let activity = [];
  try {
    const rows = await select(db, `SELECT action, actor_user_id, target_type, target_id, after_state, created_at FROM audit_logs
      WHERE (target_type = 'device' AND target_id = ?) OR (action LIKE 'devices.%' AND after_state LIKE ?) ORDER BY created_at DESC LIMIT 50`,
    [deviceId, `%${deviceId}%`]);
    const names = await namesOf(rows.map((r) => r.actor_user_id));
    activity = rows.map((r) => ({
      action: r.action, actorName: names.get(r.actor_user_id) || null, actorUserId: r.actor_user_id, targetType: r.target_type, targetId: r.target_id, at: r.created_at,
      result: (() => {
        const a = typeof r.after_state === 'string' ? parse(r.after_state, {}) : r.after_state || {};
        return a.status || null;
      })(),
    }));
  } catch (_) { /* no audit table on a very old tenant */ }
  return {
    reports: reports.map((r) => ({
      id: Number(r.id), status: r.status, deviceUserCount: r.device_user_count, desiredCount: r.desired_count, extraCount: r.extra_count,
      missingCount: r.missing_count, unlinkedCount: r.unlinked_count, startedAt: r.started_at, finishedAt: r.finished_at,
    })),
    activity,
  };
}

// ── Unlinked device users (§7.5, §10.3) ───────────────────────────────────────
async function unlinkedUsers(db, { deviceIds }) {
  if (!deviceIds.length) return { users: [] };
  const rows = await select(db, `SELECT device_id, pin, name, card_no, source, first_seen_at, last_seen_at, hits FROM device_unlinked_users
    WHERE device_id IN (?) AND dismissed_at IS NULL AND linked_member_id IS NULL ORDER BY last_seen_at DESC LIMIT 500`, [deviceIds]);
  const devs = await deviceNames(db, rows.map((r) => r.device_id));
  return {
    users: rows.map((r) => ({
      deviceId: r.device_id, deviceName: devs.get(r.device_id) || null, pin: r.pin, name: r.name, cardNo: r.card_no, source: r.source,
      firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, hits: Number(r.hits),
    })),
  };
}

async function unlinkedRow(db, deviceId, pin) {
  const [row] = await select(db, 'SELECT * FROM device_unlinked_users WHERE device_id = ? AND pin = ?', [deviceId, String(pin)]);
  if (!row || row.dismissed_at || row.linked_member_id) throw createError('That device user is not in the unlinked list.', 404, 'unlinked_user_not_found');
  return row;
}

/**
 * The device user becomes this member: the member takes the device's PIN (only when they have no
 * PIN yet, and the PIN is free), so what the device holds for that PIN is theirs. Then the member is
 * sent (entitled) or removed (not entitled), like any other member.
 */
async function linkUnlinked(db, { deviceId, pin, memberId, now = new Date() }) {
  await unlinkedRow(db, deviceId, pin);
  const pinNum = Number(pin);
  if (!/^\d{1,9}$/.test(String(pin)) || pinNum < 1) throw createError('Only a numeric device PIN can be linked.', 422, 'pin_not_numeric');
  const identity = require('./device-identity.service');
  const mine = await identity.identityOf(db, memberId);
  if (mine && String(mine.pin) !== String(pinNum)) {
    const err = createError(`This member already has device PIN ${mine.pin}. Dismiss this device user and enrol the member again.`, 409, 'member_has_pin');
    err.data = { pin: String(mine.pin) };
    throw err;
  }
  if (!mine) {
    if (await identity.ownerOfPin(db, String(pinNum))) throw createError('That PIN belongs to another member.', 409, 'pin_in_use');
    try {
      await exec(db, 'INSERT INTO member_device_identity (member_id, pin, card_no, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)', [memberId, pinNum, now, now]);
    } catch (err) {
      if (err.original?.code === 'ER_DUP_ENTRY' || err.name === 'SequelizeUniqueConstraintError') throw createError('That PIN or member is already linked.', 409, 'pin_in_use');
      throw err;
    }
    // New PINs must never reach this one.
    await exec(db, 'UPDATE device_pin_sequence SET next_pin = GREATEST(next_pin, ?) WHERE id = 1', [pinNum + 1]);
  }
  await exec(db, 'UPDATE device_unlinked_users SET linked_member_id = ?, linked_at = ? WHERE pin = ? AND linked_member_id IS NULL AND dismissed_at IS NULL',
    [memberId, now, String(pin)]);
  // The device has this user; make it what GymsEra wants (on with the window, or off).
  const sync = require('./device-sync.service');
  const [device] = await sync.devicesOf(db, { deviceId });
  if (device) {
    const want = (await sync.desiredFor(db, device, [memberId], { now })).get(memberId) || { desired: false };
    if (want.desired) await sync.forceResend(db, deviceId, memberId, { priority: 1, now });
    else await sync.forceRemove(db, deviceId, memberId, String(pinNum), { priority: 1, now });
  }
  return { memberId, pin: String(pinNum) };
}

/** Hidden from the list; with removeFromDevice the device deletes that user (and its data). */
async function dismissUnlinked(db, { deviceId, pin, removeFromDevice = false, now = new Date() }) {
  await unlinkedRow(db, deviceId, pin);
  await exec(db, 'UPDATE device_unlinked_users SET dismissed_at = ? WHERE device_id = ? AND pin = ?', [now, deviceId, String(pin)]);
  if (removeFromDevice) {
    if (!/^\d{1,9}$/.test(String(pin))) throw createError('Only a numeric device PIN can be removed.', 422, 'pin_not_numeric');
    for (const [kind, args] of [['bio_delete', { pin: String(pin) }], ['auth_delete', { pin: String(pin) }], ['user_delete', { pin: String(pin) }]]) {
      await exec(db, `INSERT INTO device_commands (device_id, kind, args_json, priority, status, attempts, not_before, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'queued', 0, ?, ?, ?)`, [deviceId, kind, JSON.stringify(args), new Date(now.getTime() - 1000), now, now]);
    }
  }
  return { pin: String(pin), removeFromDevice: Boolean(removeFromDevice) };
}

// ── Branch settings (D-6, owner alerts) ───────────────────────────────────────
const DEFAULTS = { capturePhotos: false, alertsEnabled: true };

async function branchSettings(db, branchId) {
  const [row] = await select(db, 'SELECT * FROM device_branch_settings WHERE branch_id = ?', [branchId]).catch(() => []);
  if (!row) return { branchId, ...DEFAULTS, photoRetentionDays: getDeviceConfig().capturePhotoDays };
  return { branchId, capturePhotos: Boolean(Number(row.capture_photos)), alertsEnabled: Boolean(Number(row.alerts_enabled)), photoRetentionDays: getDeviceConfig().capturePhotoDays, updatedAt: row.updated_at };
}

/** Turning capture photos off deletes the ones already stored for the branch (D-6). */
async function updateBranchSettings(db, { branchId, capturePhotos, alertsEnabled, byUserId = null, now = new Date() }) {
  const cur = await branchSettings(db, branchId);
  const next = {
    capturePhotos: capturePhotos === undefined ? cur.capturePhotos : Boolean(capturePhotos),
    alertsEnabled: alertsEnabled === undefined ? cur.alertsEnabled : Boolean(alertsEnabled),
  };
  await exec(
    db,
    `INSERT INTO device_branch_settings (branch_id, capture_photos, alerts_enabled, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE capture_photos = VALUES(capture_photos), alerts_enabled = VALUES(alerts_enabled), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
    [branchId, next.capturePhotos ? 1 : 0, next.alertsEnabled ? 1 : 0, byUserId, now, now]
  );
  let photosDeleted = 0;
  if (cur.capturePhotos && !next.capturePhotos) photosDeleted = await deleteCapturePhotos(db, { branchId });
  return { ...(await branchSettings(db, branchId)), photosDeleted, before: cur };
}

// ── Capture photos (D-6) ──────────────────────────────────────────────────────
/** ATTPHOTO upload → stored when the device's branch opted in; else counted and dropped. → stored count */
async function storeCapturePhotos(db, tenantId, device, body, now = new Date()) {
  const settings = await branchSettings(db, device.branch_id);
  if (!settings.capturePhotos) return 0;
  let stored = 0;
  for (const line of String(body || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = {};
    for (const part of line.split('\t')) {
      const i = part.indexOf('=');
      if (i > 0) f[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1);
    }
    if (!f.photo || !f.pin) continue;
    const name = String(f.pin);
    const pin = protocol.attPhotoPin(name);
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name);
    const local = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : null;
    const bytes = Buffer.from(f.photo, 'base64');
    if (!bytes.length) continue;
    const enc = bioCrypto().encrypt(bytes);
    const key = `device-captures/${tenantId}/${device.branch_id}/${crypto.randomUUID()}.bin`;
    await storage().putPrivateObject({ buffer: enc, mimetype: 'application/octet-stream', key });
    const [ev] = local
      ? await select(db, 'SELECT id FROM device_access_events WHERE device_id = ? AND pin = ? AND device_time = ? ORDER BY id DESC LIMIT 1', [device.id, pin, local])
      : [];
    await exec(db, `INSERT INTO device_capture_photos (device_id, branch_id, event_id, pin, device_time, storage_key, key_version, sha256, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [device.id, device.branch_id, ev?.id || null, pin ? String(pin).slice(0, 16) : null, local, key,
      bioCrypto().versionOf(enc), bioCrypto().sha256(bytes), bytes.length, now]);
    stored += 1;
  }
  return stored;
}

async function capturePhoto(db, photoId) {
  const [row] = await select(db, 'SELECT * FROM device_capture_photos WHERE id = ?', [photoId]);
  if (!row) throw createError('Photo not found.', 404, 'photo_not_found');
  return row;
}

/** The JPEG bytes (decrypted in memory). */
async function capturePhotoBytes(row) {
  const stream = await storage().getKycStream(row.storage_key);
  const chunks = [];
  for await (const c of stream.stream || stream.Body || stream) chunks.push(Buffer.from(c));
  return bioCrypto().decrypt(Buffer.concat(chunks));
}

/** Retention (30 days) or a branch opting out. Fixed statements only (SEC-16). → deleted count */
async function deleteCapturePhotos(db, { branchId = null, olderThan = null }) {
  const rows = branchId
    ? await select(db, 'SELECT id, storage_key FROM device_capture_photos WHERE branch_id = ?', [branchId])
    : await select(db, 'SELECT id, storage_key FROM device_capture_photos WHERE created_at < ?', [olderThan]);
  for (const r of rows) {
    await storage().deleteKycFile(r.storage_key).catch(() => {});
    await exec(db, 'DELETE FROM device_capture_photos WHERE id = ?', [r.id]);
  }
  return rows.length;
}

module.exports = {
  accessEvents,
  deviceMembers,
  deviceErrors,
  deviceCommands,
  deviceAudits,
  unlinkedUsers,
  linkUnlinked,
  dismissUnlinked,
  branchSettings,
  updateBranchSettings,
  storeCapturePhotos,
  capturePhoto,
  capturePhotoBytes,
  deleteCapturePhotos,
};
