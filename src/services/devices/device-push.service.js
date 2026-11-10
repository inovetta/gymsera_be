/**
 * Manual "Push now" with a 15-second answer (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §9, §7.6, §11).
 *
 *   pushMember     one member on their devices now: a forced re-send (the member may be missing on a
 *                  device although GymsEra thinks it is there) at priority 0. A device where the member
 *                  is not entitled gets nothing, and the reason (§9.2 rule 2).
 *   removeMember   "Remove from device now" for a member who is not entitled but still on a device.
 *   pushDevices    "Push to branch" / device "Sync now": every pending change of those devices, at the
 *                  top of the queue, failed rows retried now.
 *   requestEnroll  remote ENROLL_BIO with a 60-second answer.
 *   statusOf       what the UI polls every second: per device queued → delivered → applied | failed.
 *                  A device last seen more than DEVICE_PUSH_OFFLINE_SECONDS ago is "offline" at once;
 *                  after the deadline the rest are "no_answer", and the commands STAY queued (the
 *                  backup layers keep trying; a later poll shows "applied" when it lands).
 *
 * Every request is one device_push_requests row. The same person asking again for the same target
 * inside 10 s (member) or 60 s (branch / device) gets the same request back: double-click
 * protection and the §9.2 rate limit, enforced in MySQL (iisnode runs several processes). Every
 * request is written to the tenant audit log (devices.push), and its result when it ends
 * (devices.push_result), by the first poll that sees it finished or by the watchdog.
 *
 * Polling, not a held request: it works the same on web and mobile and is safe with iisnode.
 * `db` = a tenant connection { sequelize, models, tenantId }.
 */
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { utc } = require('./sql-time');
const { getDeviceConfig } = require('../../config/devices.config');
const { createError } = require('../../utils/response.utils');
const rules = require('./sync-rules');

const select = (db, sql, replacements) => db.sequelize.query(sql, { replacements: utc(replacements), type: QueryTypes.SELECT });
const exec = (db, sql, replacements) => db.sequelize.query(sql, { replacements: utc(replacements) });
const affected = (meta) => (typeof meta === 'number' ? meta : meta?.affectedRows || 0);
const parse = (text, fallback = null) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch (_) {
    return fallback;
  }
};
const isUniqueError = (err) => err && (err.name === 'SequelizeUniqueConstraintError' || err.original?.code === 'ER_DUP_ENTRY');
const sync = () => require('./device-sync.service');
const registry = () => require('./device-registry.service');
const audit = () => require('../audit.service');

/** 26 characters [0-9A-Z], time first (sorts by creation), then random. */
function newRequestId(now = new Date()) {
  const time = now.getTime().toString(36).toUpperCase().padStart(10, '0');
  let rand = '';
  while (rand.length < 16) rand += crypto.randomBytes(8).readBigUInt64BE().toString(36).toUpperCase();
  return `${time}${rand.slice(0, 16)}`;
}

/** returnAction (§8.1) → the reason code the CMS and the app turn into words. */
const REASON_OF = {
  storage_full: 'device_storage_full',
  unsupported: 'command_unsupported',
  unknown_pin: 'unknown_pin',
  empty_template: 'empty_template',
  version_mismatch: 'template_version_mismatch',
  transient: 'device_busy',
  unknown: 'device_error',
};
const reasonOfCode = (code) => (code === null || code === undefined ? 'device_error' : REASON_OF[rules.returnAction(Number(code))] || 'device_error');

const TERMINAL = new Set(['applied', 'failed', 'not_entitled', 'entitled', 'offline']);

// ── Devices ───────────────────────────────────────────────────────────────────
/**
 * The tenant's devices that take commands, in the branches the caller may act at (null = every
 * branch), as the device views (name, branch, connection, last seen) joined to the sync rows.
 */
async function usableDevices(db, { permittedBranchIds = null, branchId = null, deviceIds = null } = {}) {
  let branchIds = permittedBranchIds;
  if (branchId) {
    if (branchIds !== null && !branchIds.includes(branchId)) return [];
    branchIds = [branchId];
  }
  const views = (await registry().listDevices({ tenantId: db.tenantId, tenantDb: db, branchIds }))
    .filter((v) => v.enabled && v.status !== 'removed' && v.status !== 'wiping');
  const syncable = new Map((await sync().devicesOf(db)).map((d) => [d.id, d]));
  return views
    .filter((v) => syncable.has(v.id) && (!deviceIds || deviceIds.includes(v.id)))
    .map((v) => ({ view: v, device: syncable.get(v.id) }));
}

const offlineOf = (view, cfg = getDeviceConfig()) =>
  view.lastSeenSecondsAgo === null || view.lastSeenSecondsAgo > cfg.pushOfflineSeconds;

const deviceSummary = (view) => ({
  deviceId: view.id,
  name: view.name,
  branchId: view.branchId,
  branchName: view.branchName,
  connection: view.connection,
  lastSeenSecondsAgo: view.lastSeenSecondsAgo,
  offline: offlineOf(view),
});

async function assertMember(db, memberId) {
  const [row] = await select(
    db,
    `SELECT (SELECT COUNT(*) FROM member_subscriptions WHERE user_id = ?) + (SELECT COUNT(*) FROM member_profiles WHERE user_id = ?)
       + (SELECT COUNT(*) FROM gym_staff WHERE user_id = ?) AS n`,
    [memberId, memberId, memberId]
  );
  if (!Number(row?.n)) throw createError('Member not found.', 404, 'member_not_found');
}

// ── Requests ──────────────────────────────────────────────────────────────────
/**
 * The open request of this person for this target inside the window, or a new row. Two calls at the
 * same moment both land on the unique dedupe key: one inserts, the other gets the first one back.
 * → { request, reused }
 */
async function openRequest(db, { kind, requestedBy, memberId = null, branchId = null, deviceIds, target, windowSeconds, timeoutSeconds, now }) {
  const prefix = `${requestedBy || 'system'}|${kind}|${target}|`;
  const since = new Date(now.getTime() - windowSeconds * 1000);
  const findRecent = async () => {
    const [row] = await select(db, 'SELECT * FROM device_push_requests WHERE dedupe_key LIKE ? AND created_at > ? ORDER BY created_at DESC LIMIT 1', [`${prefix}%`, since]);
    return row || null;
  };
  const recent = await findRecent();
  if (recent) return { request: recent, reused: true };
  const id = newRequestId(now);
  const bucket = Math.floor(now.getTime() / (windowSeconds * 1000));
  try {
    await exec(
      db,
      `INSERT INTO device_push_requests (id, kind, requested_by, member_id, branch_id, device_ids_json, dedupe_key, created_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, kind, requestedBy, memberId, branchId, JSON.stringify(deviceIds), `${prefix}${bucket}`, now, new Date(now.getTime() + timeoutSeconds * 1000)]
    );
  } catch (err) {
    if (!isUniqueError(err)) throw err;
    const other = await findRecent();
    if (other) return { request: other, reused: true };
    throw err;
  }
  const [row] = await select(db, 'SELECT * FROM device_push_requests WHERE id = ?', [id]);
  return { request: row, reused: false };
}

async function savePlan(db, requestId, plan) {
  await exec(db, 'UPDATE device_push_requests SET plan_json = ? WHERE id = ?', [JSON.stringify(plan), requestId]);
}

function answerOf(request, reused, devices) {
  return {
    requestId: request.id,
    kind: request.kind,
    reused,
    createdAt: request.created_at,
    deadlineAt: request.deadline_at,
    devices,
  };
}

/** The answer for a request someone else's click already opened (its plan may still be on its way). */
async function reusedAnswer(db, request, views) {
  const plan = parse(request.plan_json, []) || [];
  const byId = new Map(plan.map((p) => [p.deviceId, p]));
  const ids = parse(request.device_ids_json, []) || [];
  return answerOf(request, true, views.filter((v) => ids.includes(v.view.id)).map((v) => ({
    ...deviceSummary(v.view),
    outcome: byId.get(v.view.id)?.outcome || 'pushing',
    reason: byId.get(v.view.id)?.reason || null,
    onDevice: byId.get(v.view.id)?.onDevice ?? null,
  })));
}

async function auditAsked(db, ctx, request, extra) {
  await audit().record({ tenantDb: db, userId: ctx.requestedBy, roleKey: ctx.roleKey || null, req: ctx.req || null, branchId: request.branch_id || null }, {
    action: 'devices.push',
    targetType: request.member_id ? 'member' : request.branch_id ? 'branch' : 'device',
    targetId: request.member_id || request.branch_id || (parse(request.device_ids_json, []) || [])[0] || null,
    after: { requestId: request.id, kind: request.kind, deviceIds: parse(request.device_ids_json, []), ...extra },
  });
}

// ── Member push (§9.2) ────────────────────────────────────────────────────────
/** The double-click key: the member, plus the devices when the caller chose them (another set is another request). */
const targetOf = (memberId, deviceIds) => (deviceIds && deviceIds.length
  ? `${memberId}:${crypto.createHash('sha256').update([...new Set(deviceIds)].sort().join(',')).digest('hex').slice(0, 16)}`
  : memberId);
/** Devices this member is on or should be on, or the ones asked for. */
async function memberTargets(db, memberId, { permittedBranchIds, deviceIds }) {
  const all = await usableDevices(db, { permittedBranchIds, deviceIds });
  if (deviceIds) {
    if (all.length !== new Set(deviceIds).size) throw createError('Device not found.', 404, 'device_not_found');
    return all;
  }
  const out = [];
  for (const d of all) {
    const want = (await sync().desiredFor(db, d.device, [memberId])).get(memberId) || { desired: false };
    const [row] = await select(db, 'SELECT state FROM device_member_sync WHERE device_id = ? AND member_id = ?', [d.device.id, memberId]);
    if (want.desired || (row && row.state !== 'removed')) out.push(d);
  }
  return out;
}

async function pushMember(db, { memberId, requestedBy, deviceIds = null, permittedBranchIds = null, roleKey = null, req = null, now = new Date() }) {
  const cfg = getDeviceConfig();
  await assertMember(db, memberId);
  const targets = await memberTargets(db, memberId, { permittedBranchIds, deviceIds });
  if (!targets.length) throw createError('This member is not on any access device you manage, and should not be.', 409, 'no_devices');
  const { request, reused } = await openRequest(db, {
    kind: 'member', requestedBy, memberId, deviceIds: targets.map((t) => t.view.id), target: targetOf(memberId, deviceIds),
    windowSeconds: cfg.pushMemberWindowSeconds, timeoutSeconds: cfg.pushTimeoutSeconds, now,
  });
  if (reused) return reusedAnswer(db, request, targets);

  const plan = [];
  const devices = [];
  for (const { view, device } of targets) {
    const want = (await sync().desiredFor(db, device, [memberId], { now })).get(memberId) || { desired: false };
    const [row] = await select(db, 'SELECT state FROM device_member_sync WHERE device_id = ? AND member_id = ?', [device.id, memberId]);
    const onDevice = Boolean(row && row.state !== 'removed');
    let entry;
    if (!want.desired) {
      entry = { deviceId: device.id, outcome: 'not_entitled', reason: want.reason || 'no_valid_package', onDevice };
    } else {
      const res = await sync().applyOne(db, device, memberId, want, { priority: 0, force: true, pushRequestId: request.id, now });
      const [after] = await select(db, 'SELECT pending_batch_id FROM device_member_sync WHERE device_id = ? AND member_id = ?', [device.id, memberId]);
      entry = res === 'skipped'
        ? { deviceId: device.id, outcome: 'not_entitled', reason: 'branch_sync_frozen', onDevice }
        : { deviceId: device.id, outcome: 'pushing', reason: null, onDevice, batchId: after?.pending_batch_id || null };
    }
    plan.push(entry);
    devices.push({ ...deviceSummary(view), outcome: entry.outcome, reason: entry.reason, onDevice });
  }
  await savePlan(db, request.id, plan);
  await auditAsked(db, { requestedBy, roleKey, req }, request, { outcomes: plan.map((p) => ({ deviceId: p.deviceId, outcome: p.outcome, reason: p.reason })) });
  return answerOf(request, false, devices);
}

/** "Remove from device now" (§9.2 rule 2): only where the member is not entitled. */
async function removeMember(db, { memberId, requestedBy, deviceIds = null, permittedBranchIds = null, roleKey = null, req = null, now = new Date() }) {
  const cfg = getDeviceConfig();
  await assertMember(db, memberId);
  const targets = await memberTargets(db, memberId, { permittedBranchIds, deviceIds });
  const removable = [];
  for (const t of targets) {
    const want = (await sync().desiredFor(db, t.device, [memberId], { now })).get(memberId) || { desired: false };
    if (!want.desired) removable.push(t);
  }
  if (!removable.length) {
    throw createError('This member may use these devices. Push them instead, or end their package first.', 409, 'member_entitled');
  }
  const { request, reused } = await openRequest(db, {
    kind: 'remove', requestedBy, memberId, deviceIds: removable.map((t) => t.view.id), target: targetOf(memberId, deviceIds),
    windowSeconds: cfg.pushMemberWindowSeconds, timeoutSeconds: cfg.pushTimeoutSeconds, now,
  });
  if (reused) return reusedAnswer(db, request, removable);
  const identity = require('./device-identity.service');
  const pin = (await identity.identityOf(db, memberId))?.pin;
  const plan = [];
  const devices = [];
  for (const { view, device } of removable) {
    let entry;
    if (!pin) {
      entry = { deviceId: device.id, outcome: 'not_entitled', reason: 'not_on_device', onDevice: false };
    } else {
      await sync().forceRemove(db, device.id, memberId, pin, { priority: 0, pushRequestId: request.id, now });
      const [after] = await select(db, 'SELECT pending_batch_id FROM device_member_sync WHERE device_id = ? AND member_id = ?', [device.id, memberId]);
      entry = { deviceId: device.id, outcome: 'removing', reason: null, onDevice: true, batchId: after?.pending_batch_id || null };
    }
    plan.push(entry);
    devices.push({ ...deviceSummary(view), outcome: entry.outcome, reason: entry.reason, onDevice: entry.onDevice });
  }
  await savePlan(db, request.id, plan);
  await auditAsked(db, { requestedBy, roleKey, req }, request, { remove: true });
  return answerOf(request, false, devices);
}

// ── Branch / device push (§9.1) ───────────────────────────────────────────────
/**
 * Every pending change of these devices: a full reconcile at priority 1 (failed rows retried now),
 * and commands already waiting for them moved to the top of the queue. Progress per device.
 */
async function pushDevices(db, { kind, branchId = null, deviceIds = null, requestedBy, permittedBranchIds = null, roleKey = null, req = null, now = new Date() }) {
  const cfg = getDeviceConfig();
  const targets = await usableDevices(db, { permittedBranchIds, branchId, deviceIds });
  if (!targets.length) throw createError('There is no access device here to push to.', 409, 'no_devices');
  const ids = targets.map((t) => t.view.id);
  const { request, reused } = await openRequest(db, {
    kind, requestedBy, branchId, deviceIds: ids, target: branchId || targetOf('devices', ids),
    windowSeconds: cfg.pushBranchWindowSeconds, timeoutSeconds: cfg.pushTimeoutSeconds, now,
  });
  if (reused) return reusedAnswer(db, request, targets);
  for (const id of ids) {
    await sync().reconcileDevice(db, id, 'manual_push', { priority: 1, pushRequestId: request.id, retryFailed: true, now });
  }
  await exec(
    db,
    `UPDATE device_commands SET priority = LEAST(priority, 1), push_request_id = ?, updated_at = ?
     WHERE device_id IN (?) AND status = 'queued' AND push_request_id IS NULL`,
    [request.id, now, ids]
  );
  const plan = ids.map((deviceId) => ({ deviceId, outcome: 'pushing' }));
  await savePlan(db, request.id, plan);
  await auditAsked(db, { requestedBy, roleKey, req }, request, {});
  return answerOf(request, false, targets.map((t) => ({ ...deviceSummary(t.view), outcome: 'pushing', reason: null, onDevice: null })));
}

// ── Remote enrolment (§7.6) ───────────────────────────────────────────────────
async function requestEnroll(db, { memberId, deviceId, type = 9, no = 0, requestedBy, permittedBranchIds = null, roleKey = null, req = null, now = new Date() }) {
  const cfg = getDeviceConfig();
  await assertMember(db, memberId);
  const [target] = await usableDevices(db, { permittedBranchIds, deviceIds: [deviceId] });
  if (!target) throw createError('Device not found.', 404, 'device_not_found');
  const { request, reused } = await openRequest(db, {
    kind: 'enroll', requestedBy, memberId, deviceIds: [deviceId], target: `${memberId}:${deviceId}:${type}`,
    windowSeconds: cfg.pushMemberWindowSeconds, timeoutSeconds: cfg.enrollTimeoutSeconds, now,
  });
  if (reused) return { ...(await reusedAnswer(db, request, [target])), pin: parse(request.plan_json, [])?.[0]?.pin ?? null };
  let result;
  try {
    result = await require('./device-privacy.service').requestEnrollment(db, { deviceId, memberId, type, no });
  } catch (err) {
    await exec(db, 'DELETE FROM device_push_requests WHERE id = ?', [request.id]); // nothing was asked
    throw err;
  }
  await exec(db, 'UPDATE device_commands SET push_request_id = ? WHERE id = ?', [request.id, result.commandId]);
  await savePlan(db, request.id, [{ deviceId, outcome: 'enrolling', commandId: result.commandId, pin: String(result.pin), type: Number(type) }]);
  await auditAsked(db, { requestedBy, roleKey, req }, request, { enroll: { type: Number(type) } });
  return { ...answerOf(request, false, [{ ...deviceSummary(target.view), outcome: 'enrolling', reason: null, onDevice: null }]), pin: String(result.pin) };
}

// ── Status (§9.2: the 1-second poll) ──────────────────────────────────────────
async function deviceState(db, request, entry, view, { pastDeadline }) {
  const out = { deviceId: entry.deviceId, state: 'queued', returnCode: null, reason: entry.reason || null, onDevice: entry.onDevice ?? null };
  if (!['pushing', 'removing', 'enrolling'].includes(entry.outcome)) return { ...out, state: entry.outcome };
  const cmds = await select(db, 'SELECT id, status, return_code, kind FROM device_commands WHERE push_request_id = ? AND device_id = ?', [request.id, entry.deviceId]);
  const fetched = cmds.some((c) => c.status === 'sent' || c.status === 'acked' || c.status === 'failed');
  const waiting = (state) => {
    if (state !== 'queued' && state !== 'delivered') return state;
    if (state === 'queued' && view && offlineOf(view)) return 'offline';
    return pastDeadline ? 'no_answer' : state;
  };

  if (request.kind === 'device' || request.kind === 'branch') {
    const counted = cmds.filter((c) => c.status !== 'superseded');
    const progress = {
      total: counted.length,
      done: counted.filter((c) => c.status === 'acked').length,
      failed: counted.filter((c) => c.status === 'failed' || c.status === 'expired').length,
    };
    const open = counted.filter((c) => c.status === 'queued' || c.status === 'sent').length;
    let state;
    if (open) state = waiting(fetched ? 'delivered' : 'queued');
    else if (progress.failed) {
      const f = counted.find((c) => c.status === 'failed' && c.return_code !== null);
      state = 'failed';
      out.returnCode = f ? Number(f.return_code) : null;
      out.reason = f ? reasonOfCode(f.return_code) : 'no_answer';
    } else state = 'applied';
    return { ...out, state, progress };
  }

  if (request.kind === 'enroll') {
    const cmd = cmds[0];
    if (cmd?.status === 'failed') {
      const code = cmd.return_code === null ? null : Number(cmd.return_code);
      return { ...out, state: 'failed', returnCode: code, reason: code === -708 ? 'enroll_not_supported' : reasonOfCode(code), pin: entry.pin };
    }
    const [got] = await select(db, 'SELECT id FROM member_biometrics WHERE member_id = ? AND source_device_id = ? AND bio_type = ? AND updated_at >= ? LIMIT 1',
      [request.member_id, entry.deviceId, entry.type, new Date(new Date(request.created_at).getTime() - 1000)]);
    if (got) return { ...out, state: 'applied', pin: entry.pin };
    if (cmd?.status === 'acked') return { ...out, state: pastDeadline ? 'no_answer' : 'waiting_for_member', pin: entry.pin };
    return { ...out, state: waiting(fetched ? 'delivered' : 'queued'), pin: entry.pin };
  }

  // member / remove: the pair's sync row tells whether the batch landed.
  const [row] = await select(db, 'SELECT state, pending_batch_id, last_return_code FROM device_member_sync WHERE device_id = ? AND member_id = ?', [entry.deviceId, request.member_id]);
  if (row && row.pending_batch_id && row.pending_batch_id === entry.batchId) return { ...out, state: waiting(fetched ? 'delivered' : 'queued') };
  if (row && !row.pending_batch_id && row.state === 'failed' && cmds.some((c) => c.status === 'failed' || c.status === 'expired')) {
    const code = row.last_return_code === null ? null : Number(row.last_return_code);
    return { ...out, state: 'failed', returnCode: code, reason: code === null ? 'no_answer' : reasonOfCode(code) };
  }
  if (row && !row.pending_batch_id && (row.state === 'in_sync' || row.state === 'removed')) return { ...out, state: 'applied', onDevice: row.state === 'in_sync' };
  // Replaced by a newer change of the same pair (still on its way), or planned again after -30.
  return { ...out, state: waiting(fetched ? 'delivered' : 'queued') };
}

/**
 * The poll answer. `permittedBranchIds` limits the devices shown (null = all); a request with none
 * visible is a 404. The first poll that sees it finished, or past its deadline, closes it once.
 */
async function statusOf(db, requestId, { permittedBranchIds = null, now = new Date() } = {}) {
  const [request] = await select(db, 'SELECT * FROM device_push_requests WHERE id = ?', [requestId]);
  if (!request) throw createError('Push request not found.', 404, 'push_request_not_found');
  const ids = parse(request.device_ids_json, []) || [];
  const views = new Map((await registry().listDevices({ tenantId: db.tenantId, tenantDb: db, branchIds: null })).map((v) => [v.id, v]));
  const visible = ids.filter((id) => permittedBranchIds === null || (views.get(id) && permittedBranchIds.includes(views.get(id).branchId)));
  if (!visible.length) throw createError('Push request not found.', 404, 'push_request_not_found');
  const plan = new Map((parse(request.plan_json, []) || []).map((p) => [p.deviceId, p]));
  const pastDeadline = now.getTime() > new Date(request.deadline_at).getTime();

  const devices = [];
  for (const id of ids) {
    const view = views.get(id) || null;
    const entry = plan.get(id) || { deviceId: id, outcome: 'pushing' }; // plan still being written
    const st = await deviceState(db, request, entry, view, { pastDeadline });
    devices.push({
      ...(view ? deviceSummary(view) : { deviceId: id, name: null, branchId: null, branchName: null, connection: 'removed', lastSeenSecondsAgo: null, offline: true }),
      ...st,
    });
  }
  const allDone = devices.every((d) => TERMINAL.has(d.state));
  const status = allDone ? 'done' : pastDeadline ? 'timed_out' : 'running';
  const answer = {
    requestId: request.id,
    kind: request.kind,
    memberId: request.member_id,
    branchId: request.branch_id,
    status,
    createdAt: request.created_at,
    deadlineAt: request.deadline_at,
    secondsLeft: Math.max(0, Math.ceil((new Date(request.deadline_at).getTime() - now.getTime()) / 1000)),
    devices: devices.filter((d) => visible.includes(d.deviceId)),
  };
  if (!request.finished_at && (allDone || pastDeadline)) await close(db, request, { status, devices }, now);
  return answer;
}

/** Writes the result once (the first caller wins) and the audit entry. */
async function close(db, request, { status, devices }, now) {
  const result = {
    status,
    devices: devices.map((d) => ({ deviceId: d.deviceId, state: d.state, returnCode: d.returnCode ?? null, reason: d.reason ?? null, progress: d.progress })),
  };
  const [, meta] = await exec(db, 'UPDATE device_push_requests SET finished_at = ?, result_json = ? WHERE id = ? AND finished_at IS NULL', [now, JSON.stringify(result), request.id]);
  if (affected(meta) !== 1) return;
  await audit().record({ tenantDb: db, userId: request.requested_by, branchId: request.branch_id || null }, {
    action: 'devices.push_result',
    targetType: request.member_id ? 'member' : request.branch_id ? 'branch' : 'device',
    targetId: request.member_id || request.branch_id || (parse(request.device_ids_json, []) || [])[0] || null,
    after: { requestId: request.id, kind: request.kind, ...result },
  });
}

/** The watchdog: requests nobody polled to the end are closed (and audited) after their deadline. */
async function closeExpired(db, now = new Date()) {
  const rows = await select(db, 'SELECT id FROM device_push_requests WHERE finished_at IS NULL AND deadline_at < ? ORDER BY deadline_at LIMIT 200', [new Date(now.getTime() - 5000)]);
  let n = 0;
  for (const r of rows) {
    await statusOf(db, r.id, { now });
    n += 1;
  }
  return n;
}

// ── Member profile › Access devices (§9.1, §10.4) ─────────────────────────────
/**
 * One row per device of the caller's branches where the member is, should be, or has a package in
 * that organization: entitled or not (and why), on the device, sync state, last synced, last error.
 * Plus PIN, consent and enrolled biometric types (never template data).
 */
async function memberDeviceStatus(db, { memberId, permittedBranchIds = null, now = new Date() }) {
  await assertMember(db, memberId);
  const all = await usableDevices(db, { permittedBranchIds });
  const orgs = new Set((await select(
    db,
    'SELECT DISTINCT b.gym_id FROM member_subscriptions s JOIN branches b ON b.id = s.branch_id WHERE s.user_id = ?',
    [memberId]
  )).map((r) => r.gym_id));
  const rows = new Map((await select(db, 'SELECT * FROM device_member_sync WHERE member_id = ?', [memberId])).map((r) => [r.device_id, r]));
  const devices = [];
  for (const { view, device } of all) {
    const row = rows.get(device.id);
    const want = (await sync().desiredFor(db, device, [memberId], { now })).get(memberId) || { desired: false, reason: 'no_valid_package' };
    if (!want.desired && !row && !orgs.has(device.branch_gym_id)) continue;
    const pending = Boolean(row?.pending_batch_id);
    devices.push({
      ...deviceSummary(view),
      direction: view.direction,
      entitled: Boolean(want.desired),
      reason: want.desired ? null : (sync().syncFrozen(device) ? 'branch_sync_frozen' : want.reason || 'no_valid_package'),
      onDevice: Boolean(row && row.state !== 'removed'),
      state: row ? row.state : 'not_on_device',
      pending,
      lastSyncedAt: row && !pending && (row.state === 'in_sync' || row.state === 'removed') ? row.updated_at : null,
      lastReturnCode: row?.last_return_code ?? null,
      failedReason: row?.state === 'failed' ? (row.last_return_code === null ? 'no_answer' : reasonOfCode(row.last_return_code)) : null,
      lastErrorAt: row?.last_error_at || null,
    });
  }
  const identity = await require('./device-identity.service').identityOf(db, memberId);
  const biometrics = require('./biometric.service');
  const enrolled = await select(
    db,
    'SELECT bio_type, COUNT(*) AS n, MAX(enrolled_at) AS last_at, MAX(consent_pending) AS pending FROM member_biometrics WHERE member_id = ? GROUP BY bio_type ORDER BY bio_type',
    [memberId]
  );
  return {
    memberId,
    pin: identity && !identity.retired_at ? String(identity.pin) : null,
    consent: await biometrics.consentStatus(db, memberId),
    biometrics: enrolled.map((b) => ({ type: Number(b.bio_type), count: Number(b.n), lastEnrolledAt: b.last_at, waitingForConsent: Boolean(Number(b.pending)) })),
    devices,
  };
}

module.exports = {
  newRequestId,
  reasonOfCode,
  usableDevices,
  pushMember,
  removeMember,
  pushDevices,
  requestEnroll,
  statusOf,
  closeExpired,
  memberDeviceStatus,
};
