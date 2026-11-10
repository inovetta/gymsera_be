/**
 * The device sync engine (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §7.1, §7.2, §8.1, §8.3).
 *
 * reconcileMember() and reconcileDevice() are the ONLY ways member commands are created. Both
 * compute who should be on each device, compare with device_member_sync (desired versus what the
 * device last confirmed), and queue the difference as one batch per (device, member), superseding
 * anything still queued for that pair. Running them twice creates nothing new.
 *
 * Who belongs on device D of branch B (§7.1), using the rules the app already uses:
 *   - a platform user who is not suspended or being deleted, with a PIN that is not retired;
 *   - a member subscription that attendance.service#isCheckinValid accepts (ACTIVE, not past its end,
 *     visits left; ACTIVE only after the payment is verified), that has started, is not in a freeze
 *     window, and covers B by the QR check-in rule (attendance.service#subscriptionCoversBranch: the
 *     subscription's branch, or another branch of the same organization);
 *   - or staff of B with gym_staff.device_access = 1 (D-8): privilege 0, no window;
 *   - OUT devices keep a member DEVICE_EXIT_GRACE_HOURS after they stop qualifying (D-7);
 *   - a branch locked for a lapsed GymsEra plan past the members' check-in grace (D-5,
 *     branch-billing-lock.service#assertBranchCheckinAllowed): no adds or updates, removals only.
 *
 * Templates are decrypted only when a command is handed to the device (renderCommands).
 * `db` = a tenant connection { sequelize, models, tenantId? }.
 */
const { utc } = require('./sql-time');
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { getDeviceConfig } = require('../../config/devices.config');
const protocol = require('./push-protocol');
const rules = require('./sync-rules');
const identity = require('./device-identity.service');
const biometrics = require('./biometric.service');

const select = (db, sql, replacements, transaction) => db.sequelize.query(sql, { replacements: utc(replacements), type: QueryTypes.SELECT, transaction });
const exec = (db, sql, replacements, transaction) => db.sequelize.query(sql, { replacements: utc(replacements), transaction });
const parse = (text, fallback = null) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch (_) {
    return fallback;
  }
};
const newBatchId = () => crypto.randomBytes(13).toString('hex').toUpperCase(); // 26 chars
const BLOCKED_USER_STATUSES = new Set(['SUSPENDED', 'PENDING_DELETION', 'DELETED']);
const REMOVED = 'REMOVED';
const SETTINGS = () => {
  const c = getDeviceConfig();
  return { endTimeFormat: c.endTimeFormat, sendUserAuthorize: c.sendUserAuthorize, photoFallback: c.photoFallback, sendUserPic: c.sendUserPic };
};

// ── Devices ───────────────────────────────────────────────────────────────────
/**
 * The tenant's devices that can take commands (enabled, not removed), with their branch.
 * Read from the tenant table, so it works from a model hook that knows only the tenant database.
 */
async function devicesOf(db, { deviceId = null, branchId = null } = {}) {
  const where = ['d.enabled = 1', 'd.removed_at IS NULL'];
  const rep = [];
  if (deviceId) { where.push('d.id = ?'); rep.push(deviceId); }
  if (branchId) { where.push('d.branch_id = ?'); rep.push(branchId); }
  const rows = await select(
    db,
    `SELECT d.*, b.gym_id AS branch_gym_id, b.timezone AS branch_timezone, b.status AS branch_status, b.billing_locked_at AS branch_billing_locked_at
       FROM access_device_details d JOIN branches b ON b.id = d.branch_id WHERE ${where.join(' AND ')}`,
    rep
  );
  return rows.map((d) => ({ ...d, caps: parse(d.capabilities_json, {}) || {} }));
}

/** True when the tenant has any device that can take commands (cheap; false when 023 is missing). */
async function hasDevices(db) {
  try {
    const [row] = await select(db, 'SELECT 1 AS x FROM access_device_details WHERE enabled = 1 AND removed_at IS NULL LIMIT 1', []);
    return Boolean(row);
  } catch (_) {
    return false;
  }
}

/** D-5: the branch is locked and the members' check-in grace is over → no adds, removals only. */
function syncFrozen(device) {
  if (!device.branch_billing_locked_at) return false;
  try {
    require('../branch-billing-lock.service').assertBranchCheckinAllowed({ id: device.branch_id, billingLockedAt: device.branch_billing_locked_at });
    return false;
  } catch (_) {
    return true;
  }
}

// ── Desired state (§7.1) ──────────────────────────────────────────────────────
const dateStr = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);

/**
 * memberIds null = every member who could be on the device (a full sweep).
 * → Map(memberId → { desired: boolean, record?, pin?, staff?, reason })
 */
async function desiredFor(db, device, memberIds, { now = new Date() } = {}) {
  const cfg = getDeviceConfig();
  const { computeBusinessDate } = require('../ledger.service');
  const { isCheckinValid } = require('../attendance.service');
  const tz = device.branch_timezone || 'Asia/Karachi';
  const today = computeBusinessDate(now, tz);
  const only = Array.isArray(memberIds) ? memberIds : null;
  if (only && !only.length) return new Map();

  const sameOrg = device.branch_gym_id
    ? (await select(db, 'SELECT id FROM branches WHERE gym_id = ?', [device.branch_gym_id])).map((b) => b.id)
    : [device.branch_id];
  const subs = await select(
    db,
    `SELECT user_id, branch_id, start_date, end_date, status, remaining_visits, freeze_from, freeze_to FROM member_subscriptions
      WHERE status = 'ACTIVE' AND branch_id IN (?)${only ? ' AND user_id IN (?)' : ''}`,
    only ? [sameOrg, only] : [sameOrg]
  );
  const best = new Map();
  for (const s of subs) {
    const sub = { status: s.status, endDate: dateStr(s.end_date), remainingVisits: s.remaining_visits };
    const start = dateStr(s.start_date);
    const inFreeze = s.freeze_from && s.freeze_to && dateStr(s.freeze_from) <= today && today <= dateStr(s.freeze_to);
    if (!isCheckinValid(sub, today) || start > today || inFreeze) continue;
    const cur = best.get(s.user_id);
    if (!cur || sub.endDate > cur.endDate) best.set(s.user_id, { startDate: start, endDate: sub.endDate });
  }
  const staff = new Set((await select(
    db,
    `SELECT DISTINCT user_id FROM gym_staff WHERE branch_id = ? AND device_access = 1 AND employment_status = 'ACTIVE' AND status = 'active'
       AND user_id IS NOT NULL${only ? ' AND user_id IN (?)' : ''}`,
    only ? [device.branch_id, only] : [device.branch_id]
  )).map((r) => r.user_id));
  const syncRows = await select(db, `SELECT member_id FROM device_member_sync WHERE device_id = ?${only ? ' AND member_id IN (?)' : ''}`, only ? [device.id, only] : [device.id]);

  const candidates = only || [...new Set([...best.keys(), ...staff, ...syncRows.map((r) => r.member_id)])];
  const out = new Map();
  if (!candidates.length) return out;

  const { User } = require('../../models/platform');
  const users = new Map((await User.findAll({ where: { id: candidates }, attributes: ['id', 'fullName', 'status'], raw: true })).map((u) => [u.id, u]));
  const ids = await identity.identitiesOf(db, candidates);

  const qualifying = [];
  for (const m of candidates) {
    const user = users.get(m);
    let reason = null;
    if (!user) reason = 'no_user';
    else if (BLOCKED_USER_STATUSES.has(user.status)) reason = 'user_blocked';
    else if (ids.get(m)?.retired_at) reason = 'pin_retired';
    else if (!staff.has(m) && !best.has(m)) reason = 'no_valid_package';
    if (reason) out.set(m, { desired: false, reason });
    else qualifying.push(m);
  }

  const newcomers = qualifying.filter((m) => !ids.get(m));
  for (const m of newcomers) await identity.ensurePin(db, m);
  const fresh = newcomers.length ? await identity.identitiesOf(db, qualifying) : ids;
  const usable = await biometrics.usableFor(db, qualifying, device.id);
  const incompat = new Map((await (qualifying.length
    ? select(db, 'SELECT member_id, incompatible_json FROM device_member_sync WHERE device_id = ? AND member_id IN (?)', [device.id, qualifying])
    : Promise.resolve([]))).map((r) => [r.member_id, parse(r.incompatible_json, [])]));

  for (const m of qualifying) {
    const isStaff = staff.has(m);
    const pkg = best.get(m);
    const window = isStaff || !cfg.sendValidity ? null : rules.packageWindow({
      startDate: pkg.startDate, endDate: pkg.endDate, timezone: tz, direction: device.direction, exitGraceHours: cfg.exitGraceHours,
    });
    const idRow = fresh.get(m) || ids.get(m);
    const record = rules.desiredRecord({
      pin: idRow.pin,
      name: users.get(m).fullName,
      cardNo: idRow.card_no || '',
      window,
      caps: device.caps,
      device,
      settings: SETTINGS(),
      biometrics: usable.biometrics.get(m) || [],
      photos: usable.photos.get(m) || [],
      incompatible: incompat.get(m) || [],
    });
    out.set(m, { desired: true, record, pin: Number(idRow.pin), staff: isStaff, reason: isStaff ? 'staff' : 'valid_package' });
  }
  return out;
}

// ── Apply one (device, member) (§7.2) ─────────────────────────────────────────
async function syncRow(db, deviceId, memberId) {
  const [row] = await select(db, 'SELECT * FROM device_member_sync WHERE device_id = ? AND member_id = ?', [deviceId, memberId]);
  return row || null;
}

async function queueBatch(db, device, memberId, plan, { priority, now }) {
  const batchId = newBatchId();
  for (const c of plan) {
    await exec(
      db,
      `INSERT INTO device_commands (device_id, member_id, batch_id, kind, args_json, priority, status, attempts, not_before, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      [device.id, memberId, batchId, c.kind, JSON.stringify(c.args), priority, new Date(Math.min(now.getTime(), Date.now()) - 1000), now, now]
    );
  }
  return batchId;
}

/**
 * Brings one (device, member) to its desired state. → 'queued' | 'unchanged' | 'held' | 'skipped'
 * opts.force: send even when the stored state says it is already there (audit drift, safety layer 4).
 * opts.noGrace: removal now, even on an OUT device (member deleted, consent withdrawn).
 * opts.retry: a failed row may be retried (the 1-hour rule is the sweep's).
 */
async function applyOne(db, device, memberId, want, { priority = 5, force = false, noGrace = false, retry = false, now = new Date() } = {}) {
  const cfg = getDeviceConfig();
  let row = await syncRow(db, device.id, memberId);
  let target = want.desired ? want.record : null;

  // D-7: an OUT device keeps someone who just stopped qualifying, for the exit grace.
  if (!target && row && Number(row.desired) === 1 && device.direction === 'out' && !noGrace && cfg.exitGraceHours > 0) {
    const since = row.undesired_since ? new Date(row.undesired_since) : now;
    if (!row.undesired_since) {
      await exec(db, 'UPDATE device_member_sync SET undesired_since = ?, updated_at = ? WHERE device_id = ? AND member_id = ?', [now, now, device.id, memberId]);
    }
    if (now.getTime() < since.getTime() + cfg.exitGraceHours * 3600000) return 'held';
  }

  const targetHash = target ? rules.hashOf(target) : REMOVED;
  const frozen = syncFrozen(device);
  const onDevice = row && row.state !== 'removed';

  if (!target && !onDevice && !force) {
    if (row && Number(row.desired) === 1) {
      await exec(db, 'UPDATE device_member_sync SET desired = 0, desired_hash = NULL, desired_json = NULL, undesired_since = NULL, updated_at = ? WHERE device_id = ? AND member_id = ?', [now, device.id, memberId]);
    }
    return 'unchanged';
  }
  if (target && frozen) return 'skipped'; // D-5: no adds and no updates while the branch is frozen

  if (!force && row) {
    if (row.pending_batch_id && row.pending_hash === targetHash) return 'unchanged';
    const settled = !row.pending_batch_id && ((target && row.applied_hash === targetHash && row.state === 'in_sync') || (!target && row.state === 'removed'));
    if (settled) {
      if (row.desired_hash !== (target ? targetHash : null)) {
        await exec(db, 'UPDATE device_member_sync SET desired = ?, desired_hash = ?, desired_json = ?, undesired_since = NULL, updated_at = ? WHERE device_id = ? AND member_id = ?',
          [target ? 1 : 0, target ? targetHash : null, target ? JSON.stringify(target) : null, now, device.id, memberId]);
      }
      return 'unchanged';
    }
    // §8.3 layer 2: a failed row is retried only after an hour, at most 3 times a day, unless the target changed.
    if (row.state === 'failed' && row.desired_hash === (target ? targetHash : null) && !retry) return 'unchanged';
  }

  const support = rules.bioSupport(device.caps);
  const applied = onDevice && !force ? parse(row.applied_json) : null;
  const pin = target ? target.pin : String(row?.pin ?? want.pin);
  const plan = rules.planCommands({
    desired: target,
    applied: target ? applied : parse(row?.applied_json),
    pin,
    supportedTypes: [...support.types],
    photoTypes: [...support.photoTypes],
  });

  // §7.2 point 3: older queued commands of this pair are superseded.
  await exec(db, 'UPDATE device_commands SET status = \'superseded\', updated_at = ? WHERE device_id = ? AND member_id = ? AND status = \'queued\'', [now, device.id, memberId]);

  if (!plan.length) {
    await upsertRow(db, device.id, memberId, {
      pin: Number(pin), desired: target ? 1 : 0, desired_hash: target ? targetHash : null, desired_json: target ? JSON.stringify(target) : null,
      applied_hash: target ? targetHash : null, applied_json: target ? JSON.stringify(target) : null,
      pending_batch_id: null, pending_hash: null, state: target ? 'in_sync' : 'removed', undesired_since: null,
    }, now);
    return 'unchanged';
  }
  const batchId = await queueBatch(db, device, memberId, plan, { priority, now });
  const state = !target ? 'pending_remove' : onDevice && applied ? 'pending_update' : 'pending_add';
  const retryCols = retry ? retryCounter(row, now) : {};
  await upsertRow(db, device.id, memberId, {
    pin: Number(pin), desired: target ? 1 : 0, desired_hash: target ? targetHash : null, desired_json: target ? JSON.stringify(target) : null,
    pending_batch_id: batchId, pending_hash: targetHash, state, undesired_since: target ? null : row?.undesired_since ?? null,
    ...(force && target ? { applied_hash: null } : {}),
    ...retryCols,
  }, now);
  return 'queued';
}

function retryCounter(row, now) {
  const day = now.toISOString().slice(0, 10);
  const same = row?.retry_day && dateStr(row.retry_day) === day;
  return { retry_day: day, retry_count: same ? Number(row.retry_count) + 1 : 1 };
}

const ROW_COLS = ['pin', 'desired', 'desired_hash', 'desired_json', 'applied_hash', 'applied_json', 'pending_batch_id', 'pending_hash', 'state',
  'attempts', 'last_return_code', 'last_error_at', 'undesired_since', 'incompatible_json', 'retry_day', 'retry_count'];

async function upsertRow(db, deviceId, memberId, values, now) {
  const cols = Object.keys(values).filter((k) => ROW_COLS.includes(k));
  const insertCols = ['device_id', 'member_id', ...cols, 'created_at', 'updated_at'];
  await exec(
    db,
    `INSERT INTO device_member_sync (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${[...cols, 'updated_at'].map((c) => `${c} = VALUES(${c})`).join(', ')}`,
    [deviceId, memberId, ...cols.map((c) => values[c]), now, now]
  );
}

// ── Entry points ──────────────────────────────────────────────────────────────
/**
 * One member on every device of the tenant (or `deviceIds`). Real-time triggers (§8.2), uploads
 * from a device (§7.5), drift (§7.3 point 6). → { [deviceId]: result }
 */
async function reconcileMember(db, memberId, reason, opts = {}) {
  const devices = (await devicesOf(db)).filter((d) => !opts.deviceIds || opts.deviceIds.includes(d.id));
  const out = {};
  for (const device of devices) {
    const want = (await desiredFor(db, device, [memberId], opts)).get(memberId) || { desired: false };
    out[device.id] = await applyOne(db, device, memberId, want, opts);
  }
  if (devices.length && process.env.LOG_DEVICES === 'true') console.log(`[device-sync] member reconcile (${reason}) on ${devices.length} device(s)`);
  return out;
}

/** Every member of one device (§8.3 layer 2, device created / re-paired / moved). → counts */
async function reconcileDevice(db, deviceId, reason, opts = {}) {
  const [device] = await devicesOf(db, { deviceId });
  if (!device) return { queued: 0, unchanged: 0, held: 0, skipped: 0, members: 0 };
  const now = opts.now || new Date();
  const wants = await desiredFor(db, device, null, { now });
  const counts = { queued: 0, unchanged: 0, held: 0, skipped: 0, members: wants.size };
  const failedDue = new Date(now.getTime() - getDeviceConfig().failedRetryAfterMinutes * 60000);
  const failed = new Map((await select(db, 'SELECT member_id, last_error_at, retry_day, retry_count FROM device_member_sync WHERE device_id = ? AND state = \'failed\'', [device.id]))
    .map((r) => [r.member_id, r]));
  for (const [memberId, want] of wants) {
    const f = failed.get(memberId);
    const day = now.toISOString().slice(0, 10);
    const retry = Boolean(f && (!f.last_error_at || new Date(f.last_error_at) <= failedDue)
      && !(f.retry_day && dateStr(f.retry_day) === day && Number(f.retry_count) >= getDeviceConfig().failedRetriesPerDay));
    counts[await applyOne(db, device, memberId, want, { priority: 9, ...opts, retry, now })] += 1;
  }
  await exec(db, 'UPDATE access_device_details SET last_sweep_at = ? WHERE id = ?', [now, device.id]);
  if (process.env.LOG_DEVICES === 'true') console.log(`[device-sync] device ${device.id} reconcile (${reason}): ${JSON.stringify(counts)}`);
  return counts;
}

/** Re-sends a member to one device from scratch (drift: the device does not have what we think). */
async function forceResend(db, deviceId, memberId, { priority = 5, now = new Date() } = {}) {
  const [device] = await devicesOf(db, { deviceId });
  if (!device) return 'skipped';
  await exec(db, 'UPDATE device_member_sync SET applied_hash = NULL, applied_json = NULL, state = \'removed\', pending_batch_id = NULL, pending_hash = NULL, updated_at = ? WHERE device_id = ? AND member_id = ?', [now, deviceId, memberId]);
  const want = (await desiredFor(db, device, [memberId], { now })).get(memberId) || { desired: false };
  return applyOne(db, device, memberId, want, { priority, now });
}

/** Removes a member from one device now, whatever the stored state says (safety layer 4, audit extras). */
async function forceRemove(db, deviceId, memberId, pin, { priority = 5, now = new Date() } = {}) {
  const [device] = await devicesOf(db, { deviceId });
  if (!device) return 'skipped';
  const want = (await desiredFor(db, device, [memberId], { now })).get(memberId) || { desired: false };
  if (want.desired) return forceResend(db, deviceId, memberId, { priority, now });
  const row = await syncRow(db, deviceId, memberId);
  if (!row) await upsertRow(db, deviceId, memberId, { pin: Number(pin), desired: 0, state: 'in_sync' }, now);
  else await exec(db, 'UPDATE device_member_sync SET state = \'in_sync\', desired = 0, undesired_since = NULL, updated_at = ? WHERE device_id = ? AND member_id = ?', [now, deviceId, memberId]);
  return applyOne(db, device, memberId, { desired: false, pin }, { priority, noGrace: true, force: true, now });
}

/**
 * Templates this device just enrolled: it holds them, so its confirmed state gets the same entries
 * the desired record has for those types (no re-send to the device that enrolled them).
 */
async function noteDeviceHolds(db, deviceId, memberId, types, now = new Date()) {
  if (!types.length) return;
  const row = await syncRow(db, deviceId, memberId);
  if (!row || !row.applied_json) return;
  const [device] = await devicesOf(db, { deviceId });
  if (!device) return;
  const want = (await desiredFor(db, device, [memberId], { now })).get(memberId);
  const applied = parse(row.applied_json);
  for (const t of types) {
    const entry = want?.record?.bio.find((b) => b.type === t) || { type: t, items: [] };
    applied.bio = applied.bio.filter((b) => b.type !== t).concat([entry]);
  }
  applied.bio.sort((a, b) => a.type - b.type);
  const hash = rules.hashOf(applied);
  await exec(db, 'UPDATE device_member_sync SET applied_json = ?, applied_hash = ?, updated_at = ? WHERE device_id = ? AND member_id = ?',
    [JSON.stringify(applied), hash, now, deviceId, memberId]);
}

// ── Delivery (§8.1 point 2) ───────────────────────────────────────────────────
const PHOTO_KINDS = new Set(['bio_photo', 'user_pic']);

/**
 * Command rows claimed for one poll → [{ id, text } | { id, superseded } | { id, failed } | { id, held }].
 * Member commands are built from the pair's current desired record; a command of an older batch
 * is superseded instead of sent. Templates and photos are decrypted here, in memory only.
 */
async function renderCommands(db, device, rows) {
  const cfg = getDeviceConfig();
  const pairs = [...new Set(rows.filter((r) => r.member_id).map((r) => r.member_id))];
  const syncByMember = new Map(pairs.length
    ? (await select(db, 'SELECT member_id, pending_batch_id, desired_json FROM device_member_sync WHERE device_id = ? AND member_id IN (?)', [device.id, pairs])).map((r) => [r.member_id, r])
    : []);
  const caps = parse((await select(db, 'SELECT capabilities_json FROM access_device_details WHERE id = ?', [device.id]))[0]?.capabilities_json, {}) || {};
  const settings = SETTINGS();
  let photos = 0;
  const out = [];
  for (const row of rows) {
    const id = Number(row.id);
    const args = parse(row.args_json, {}) || {};
    try {
      if (row.batch_id && row.member_id) {
        const s = syncByMember.get(row.member_id);
        if (!s || s.pending_batch_id !== row.batch_id) { out.push({ id, superseded: true }); continue; }
      }
      if (PHOTO_KINDS.has(row.kind) && ++photos > cfg.photosPerPoll) { out.push({ id, held: true }); continue; }
      const record = row.member_id ? parse(syncByMember.get(row.member_id)?.desired_json) : null;
      const text = await renderOne(db, row.kind, args, record, { caps, settings, cfg });
      out.push(text ? { id, text } : { id, failed: true });
    } catch (err) {
      console.warn(`[device-sync] command ${id} (${row.kind}) for device ${device.id} could not be built: ${err.message}`);
      out.push({ id, failed: true });
    }
  }
  return out;
}

async function renderOne(db, kind, args, record, { cfg }) {
  const c = protocol.cmd;
  const win = record?.window && cfg.sendValidity ? { start: record.window.start, end: record.window.end, dateFormat: record.dateFormat } : {};
  switch (kind) {
    case 'user_upsert':
      return record ? c.userUpsert({ pin: record.pin, name: record.name, cardNo: record.cardNo, ...win }) : null;
    case 'user_authorize':
      return record?.auth ? c.userAuthorize({ pin: record.pin, timezoneId: record.auth.timezoneId, doorMask: record.auth.doorMask, ...win }) : null;
    case 'bio_upsert': {
      const tmpl = await biometrics.templatesForDelivery(db, args.ids || []);
      if (!tmpl.length) return null;
      return c.bioUpsert(tmpl.map((t) => ({ ...t, pin: args.pin })));
    }
    case 'bio_photo': {
      const content = await biometrics.photoForDelivery(db, args.id);
      return content ? c.bioPhoto({ pin: args.pin, type: args.type, content }) : null;
    }
    case 'user_pic': {
      const content = await biometrics.photoForDelivery(db, args.id);
      return content ? c.userPic({ pin: args.pin, content }) : null;
    }
    case 'bio_delete': return c.bioDelete(args.pin, args.type);
    case 'photo_delete': return c.bioPhotoDelete(args.pin);
    case 'pic_delete': return c.picDelete(args.pin);
    case 'auth_delete': return c.authDelete(args.pin);
    case 'user_delete': return c.userDelete(args.pin);
    case 'enroll_bio': return c.enrollBio({ pin: args.pin, type: args.type ?? 9, no: args.no ?? 0, separator: cfg.enrollSeparator });
    case 'info': return c.info();
    case 'check': return c.check();
    case 'count': return c.count(args.table || 'user', args.type);
    case 'query_users': return c.queryUsers(args.pin);
    case 'query_bio': return c.queryBio(args.type ?? 9, args.pin);
    default: return null;
  }
}

// ── Results (§8.1 return-code table) ──────────────────────────────────────────
async function logError(db, deviceId, { kind, code = null, message = null, data = null, source = 'server' }, now = new Date()) {
  await exec(
    db,
    'INSERT INTO device_error_logs (device_id, source, kind, code, message, data_json, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [deviceId, source, kind, code, message ? String(message).slice(0, 255) : null, data ? JSON.stringify(data) : null, now, now]
  );
  await exec(db, 'UPDATE access_device_details SET last_error_code = ?, last_error_at = ? WHERE id = ?', [code, now, deviceId]);
}

async function markUnsupported(db, deviceId, kind) {
  const caps = parse((await select(db, 'SELECT capabilities_json FROM access_device_details WHERE id = ?', [deviceId]))[0]?.capabilities_json, {}) || {};
  const list = new Set(Array.isArray(caps._unsupported) ? caps._unsupported : []);
  if (list.has(kind)) return;
  list.add(kind);
  caps._unsupported = [...list];
  await exec(db, 'UPDATE access_device_details SET capabilities_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(caps), new Date(), deviceId]);
}

/** When the pair's pending batch is finished: applied = desired (in_sync / removed), or failed. */
async function settleBatch(db, deviceId, memberId, batchId, now) {
  const row = await syncRow(db, deviceId, memberId);
  if (!row || row.pending_batch_id !== batchId) return;
  const cmds = await select(db, 'SELECT status, return_code FROM device_commands WHERE batch_id = ? AND device_id = ?', [batchId, deviceId]);
  if (cmds.some((c) => c.status === 'queued' || c.status === 'sent')) return;
  const failed = cmds.find((c) => c.status === 'failed' || c.status === 'expired');
  if (failed) {
    await exec(db, `UPDATE device_member_sync SET state = 'failed', pending_batch_id = NULL, pending_hash = NULL, attempts = attempts + 1,
      last_return_code = ?, last_error_at = ?, updated_at = ? WHERE device_id = ? AND member_id = ?`, [failed.return_code, now, now, deviceId, memberId]);
    return;
  }
  const removed = row.pending_hash === REMOVED;
  await exec(db, `UPDATE device_member_sync SET state = ?, applied_hash = ?, applied_json = ?, pending_batch_id = NULL, pending_hash = NULL,
    attempts = 0, last_return_code = NULL, updated_at = ? WHERE device_id = ? AND member_id = ?`,
  [removed ? 'removed' : 'in_sync', removed ? null : row.pending_hash, removed ? null : row.desired_json, now, deviceId, memberId]);
}

/**
 * devicecmd results for this device only. One body can carry several results (Return= or return=).
 * → { acked, failed, retried, ignored }
 */
async function recordResults(db, device, results, now = new Date()) {
  const cfg = getDeviceConfig();
  const counts = { acked: 0, failed: 0, retried: 0, ignored: 0 };
  const toReconcile = new Set();
  for (const r of results) {
    const [cmd] = await select(db, 'SELECT * FROM device_commands WHERE id = ? AND device_id = ?', [r.id, device.id]);
    if (!cmd || cmd.status !== 'sent') { counts.ignored += 1; continue; }
    const action = rules.returnAction(r.returnCode);
    const args = parse(cmd.args_json, {}) || {};
    const setStatus = (status, extra = '') => exec(db, `UPDATE device_commands SET status = ?, return_code = ?, acked_at = ?, updated_at = ?${extra} WHERE id = ?`,
      [status, r.returnCode, now, now, cmd.id]);

    if (action === 'ok') {
      await setStatus('acked');
      counts.acked += 1;
      if (args.audit && cmd.kind === 'count' && cfg.countResult === 'return') {
        await exec(db, 'UPDATE device_audits SET device_user_count = ? WHERE count_cmd_id = ?', [r.returnCode, cmd.id]);
      }
    } else if (action === 'transient') {
      const wait = rules.backoffSeconds(Number(cmd.attempts));
      if (wait !== null && Number(cmd.attempts) < cfg.maxAttempts) {
        await exec(db, 'UPDATE device_commands SET status = \'queued\', return_code = ?, claim_token = NULL, not_before = ?, updated_at = ? WHERE id = ?',
          [r.returnCode, new Date(now.getTime() + wait * 1000), now, cmd.id]);
        counts.retried += 1;
        continue;
      }
      await setStatus('failed');
      await logError(db, device.id, { kind: 'command_failed', code: r.returnCode, data: { commandId: Number(cmd.id), kind: cmd.kind, attempts: Number(cmd.attempts) } }, now);
      counts.failed += 1;
    } else if (action === 'unknown_pin' && cmd.member_id && cmd.kind !== 'user_upsert' && !args.requeued && !cmd.kind.endsWith('_delete')) {
      // -27: the device does not know the PIN yet. Send the user again, then this command.
      await setStatus('failed');
      for (const k of [{ kind: 'user_upsert', args: { pin: args.pin } }, { kind: cmd.kind, args: { ...args, requeued: true } }]) {
        await exec(db, `INSERT INTO device_commands (device_id, member_id, batch_id, kind, args_json, priority, status, attempts, not_before, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`, [device.id, cmd.member_id, cmd.batch_id, k.kind, JSON.stringify(k.args), cmd.priority, new Date(now.getTime() - 1000), now, now]);
      }
      // The failed copy no longer blocks the batch: it was replaced.
      await exec(db, 'UPDATE device_commands SET status = \'superseded\' WHERE id = ?', [cmd.id]);
      counts.retried += 1;
      continue;
    } else if (action === 'unknown_pin' && cmd.kind.endsWith('_delete')) {
      // Deleting something the device does not have: the goal is reached.
      await setStatus('acked');
      counts.acked += 1;
    } else if (action === 'version_mismatch' && cmd.kind === 'bio_upsert' && cmd.member_id) {
      // -30: these templates do not fit this device; use the comparison photo instead (§3, §7.1).
      await setStatus('failed');
      const [row] = await select(db, 'SELECT incompatible_json FROM device_member_sync WHERE device_id = ? AND member_id = ?', [device.id, cmd.member_id]);
      const list = new Set(parse(row?.incompatible_json, []));
      for (const id of args.ids || []) list.add(id);
      await exec(db, 'UPDATE device_member_sync SET incompatible_json = ?, pending_batch_id = NULL, pending_hash = NULL, state = \'pending_update\', updated_at = ? WHERE device_id = ? AND member_id = ?',
        [JSON.stringify([...list]), now, device.id, cmd.member_id]);
      await logError(db, device.id, { kind: 'template_version_mismatch', code: r.returnCode, data: { commandId: Number(cmd.id), type: args.type } }, now);
      toReconcile.add(cmd.member_id);
      counts.failed += 1;
      continue;
    } else if (action === 'unsupported') {
      await setStatus('failed');
      await markUnsupported(db, device.id, cmd.kind);
      await logError(db, device.id, { kind: 'command_unsupported', code: r.returnCode, data: { commandId: Number(cmd.id), kind: cmd.kind } }, now);
      if (cmd.member_id && (cmd.kind === 'bio_photo' || cmd.kind === 'user_pic')) {
        await exec(db, 'UPDATE device_member_sync SET pending_batch_id = NULL, pending_hash = NULL, state = \'pending_update\', updated_at = ? WHERE device_id = ? AND member_id = ?', [now, device.id, cmd.member_id]);
        toReconcile.add(cmd.member_id);
        counts.failed += 1;
        continue;
      }
      counts.failed += 1;
    } else {
      // empty_template, storage_full, unknown, and -27 on a user record: failed and logged.
      await setStatus('failed');
      const kind = action === 'storage_full' ? 'device_storage_full' : action === 'empty_template' ? 'empty_template' : 'command_failed';
      await logError(db, device.id, { kind, code: r.returnCode, data: { commandId: Number(cmd.id), kind: cmd.kind } }, now);
      counts.failed += 1;
    }
    if (cmd.batch_id && cmd.member_id) await settleBatch(db, device.id, cmd.member_id, cmd.batch_id, now);
  }
  for (const memberId of toReconcile) await reconcileMember(db, memberId, 'device_result', { deviceIds: [device.id], now });
  return counts;
}

/** A command the server could not build (template gone, photo missing): failed, and the pair re-planned. */
async function failUnrenderable(db, device, ids, now = new Date()) {
  if (!ids.length) return;
  await exec(db, 'UPDATE device_commands SET status = \'failed\', updated_at = ? WHERE id IN (?) AND device_id = ?', [now, ids, device.id]);
  const rows = await select(db, 'SELECT DISTINCT member_id, batch_id FROM device_commands WHERE id IN (?) AND member_id IS NOT NULL', [ids]);
  for (const r of rows) {
    await exec(db, 'UPDATE device_member_sync SET pending_batch_id = NULL, pending_hash = NULL, state = \'pending_update\', updated_at = ? WHERE device_id = ? AND member_id = ? AND pending_batch_id = ?',
      [now, device.id, r.member_id, r.batch_id]);
    await reconcileMember(db, r.member_id, 'unrenderable', { deviceIds: [device.id], now });
  }
}

/** Marks commands superseded (their batch was replaced) and settles nothing (the new batch will). */
async function supersede(db, device, ids, now = new Date()) {
  if (!ids.length) return;
  await exec(db, 'UPDATE device_commands SET status = \'superseded\', updated_at = ? WHERE id IN (?) AND device_id = ?', [now, ids, device.id]);
}

// ── Audit compare (§8.3 layer 3) ──────────────────────────────────────────────
/**
 * The device's user list (PINs from its query packs) against what GymsEra thinks is there:
 *   extra   on the device, not desired → removed; a PIN of no member → "unlinked" list
 *   missing desired and confirmed, not on the device → sent again
 * → the report saved on device_audits.
 */
async function compareAudit(db, deviceId, auditId, now = new Date()) {
  const devicePins = new Set((await select(db, 'SELECT pin FROM device_audit_pins WHERE audit_id = ?', [auditId])).map((r) => String(r.pin)));
  const rows = await select(db, 'SELECT member_id, pin, desired, state FROM device_member_sync WHERE device_id = ?', [deviceId]);
  const byPin = new Map(rows.map((r) => [String(r.pin), r]));
  const report = { extraRemoved: 0, missingResent: 0, unlinked: 0, retiredRemoved: 0 };

  for (const pin of devicePins) {
    const row = byPin.get(pin);
    if (row && row.state !== 'removed' && Number(row.desired) === 1) continue;
    if (row && row.state === 'pending_add') continue; // on its way
    const owner = await identity.ownerOfPin(db, pin);
    if (!owner) {
      await noteUnlinked(db, deviceId, { pin, source: 'audit' }, now);
      report.unlinked += 1;
      continue;
    }
    await forceRemove(db, deviceId, owner.memberId, pin, { priority: 9, now });
    if (owner.retired) report.retiredRemoved += 1;
    else report.extraRemoved += 1;
  }
  for (const row of rows) {
    if (Number(row.desired) !== 1 || row.state !== 'in_sync' || devicePins.has(String(row.pin))) continue;
    await forceResend(db, deviceId, row.member_id, { priority: 9, now });
    report.missingResent += 1;
  }
  const desiredCount = rows.filter((r) => Number(r.desired) === 1).length;
  await exec(db, `UPDATE device_audits SET status = 'compared', desired_count = ?, extra_count = ?, missing_count = ?, unlinked_count = ?,
    report_json = ?, finished_at = ? WHERE id = ?`,
  [desiredCount, report.extraRemoved + report.retiredRemoved, report.missingResent, report.unlinked, JSON.stringify({ ...report, devicePins: devicePins.size }), now, auditId]);
  await exec(db, 'UPDATE access_device_details SET last_full_audit_at = ? WHERE id = ?', [now, deviceId]);
  return { ...report, devicePins: devicePins.size, desiredCount };
}

/** §7.5: a PIN the device knows that is no member of this tenant. */
async function noteUnlinked(db, deviceId, { pin, name = null, cardNo = null, source }, now = new Date()) {
  await exec(
    db,
    `INSERT INTO device_unlinked_users (device_id, pin, name, card_no, source, first_seen_at, last_seen_at, hits) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at), hits = hits + 1, name = COALESCE(VALUES(name), name), card_no = COALESCE(VALUES(card_no), card_no)`,
    [deviceId, String(pin).slice(0, 16), name ? String(name).slice(0, 24) : null, cardNo && cardNo !== '0' ? String(cardNo).slice(0, 32) : null, source, now, now]
  );
}

module.exports = {
  settleBatch,
  devicesOf,
  hasDevices,
  syncFrozen,
  desiredFor,
  applyOne,
  reconcileMember,
  reconcileDevice,
  forceResend,
  forceRemove,
  noteDeviceHolds,
  renderCommands,
  recordResults,
  failUnrenderable,
  supersede,
  logError,
  compareAudit,
  noteUnlinked,
  REMOVED,
};
