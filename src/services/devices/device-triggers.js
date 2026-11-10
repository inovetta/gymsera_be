/**
 * Real-time device triggers (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §8.2).
 *
 * A business change that can change who may enter writes an outbox row IN ITS OWN TRANSACTION
 * (when it has one), so a crash between commit and enqueue cannot lose it. After commit the row is
 * processed at once, in the background of the same process: reconcileMember only writes queue rows
 * (it never talks to a device), and the request never waits for it or fails because of it, whether
 * the devices are online or not. Rows a crash left behind are picked up by the device-sync job.
 *
 * The outbox is the existing tenant `capacity_outbox` table (CAP-02) with event_type
 * DEVICE_RECONCILE; capacity-outbox.service.js leaves those rows alone.
 *
 * Sources (model hooks, attached in src/models/tenant/index.js, so every write path is covered):
 *   member_subscriptions  created, status / dates / branch / freeze / visits changed, deleted,
 *                         bulk updates (expiry cron, account deletion): package assigned, activated,
 *                         payment verified, renewed, frozen, unfrozen, cancelled, expired
 *   member_profiles       created (member created)
 *   gym_staff             device_access or employment changes (D-8)
 * and explicit calls: consent given or withdrawn, member deleted (device-privacy.service.js).
 * A tenant with no enabled device writes nothing (one indexed read).
 */
const { utc } = require('./sql-time');
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');

const EVENT_TYPE = 'DEVICE_RECONCILE';
const inFlight = new Set();

const dbOf = (sequelize) => ({ sequelize, models: sequelize.models });

async function hasDevices(sequelize) {
  try {
    const rows = await sequelize.query('SELECT 1 AS x FROM access_device_details WHERE enabled = 1 AND removed_at IS NULL LIMIT 1', { type: QueryTypes.SELECT });
    return rows.length > 0;
  } catch (_) {
    return false; // tenant not migrated to 023 yet
  }
}

/**
 * Writes the outbox row (inside `transaction` when given) and processes it after commit.
 * Never throws: a trigger must not fail the business change.
 */
async function enqueue(sequelize, { memberIds, reason, transaction = null, noGrace = false }) {
  const ids = [...new Set((memberIds || []).filter(Boolean))];
  if (!ids.length) return null;
  try {
    if (!(await hasDevices(sequelize))) return null;
    const id = crypto.randomUUID();
    const now = new Date();
    await sequelize.query(
      `INSERT INTO capacity_outbox (id, event_type, payload_json, idempotency_key, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
      { replacements: utc([id, EVENT_TYPE, JSON.stringify({ memberIds: ids, reason, noGrace }), `device:${id}`, now, now]), transaction }
    );
    const run = () => track(processRow(dbOf(sequelize), id));
    if (transaction && typeof transaction.afterCommit === 'function') transaction.afterCommit(run);
    else run();
    return id;
  } catch (err) {
    console.warn(`[device-triggers] could not queue a device reconcile (${reason}): ${err.message}`);
    return null;
  }
}

function track(promise) {
  const p = promise.catch((err) => console.warn(`[device-triggers] reconcile failed: ${err.message}`)).finally(() => inFlight.delete(p));
  inFlight.add(p);
  return p;
}

/** Runs one outbox row once (a second process finds it PROCESSED or claimed). */
async function processRow(db, id) {
  const [, meta] = await db.sequelize.query(
    'UPDATE capacity_outbox SET status = \'PROCESSED\', processed_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN (\'PENDING\', \'FAILED\') AND event_type = ?',
    { replacements: utc([new Date(), new Date(), id, EVENT_TYPE]) }
  );
  if ((typeof meta === 'number' ? meta : meta?.affectedRows) !== 1) return;
  const [row] = await db.sequelize.query('SELECT payload_json FROM capacity_outbox WHERE id = ?', { replacements: utc([id]), type: QueryTypes.SELECT });
  const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
  const sync = require('./device-sync.service');
  try {
    for (const memberId of payload.memberIds) {
      await sync.reconcileMember(db, memberId, payload.reason, { priority: 5, noGrace: Boolean(payload.noGrace) });
    }
  } catch (err) {
    await db.sequelize.query('UPDATE capacity_outbox SET status = \'FAILED\', last_error = ?, updated_at = ? WHERE id = ?', {
      replacements: utc([String(err.message).slice(0, 500), new Date(), id]),
    });
    throw err;
  }
}

/** The device-sync job: rows left PENDING or FAILED (process died, error) older than `minAgeMs`. */
async function sweepOutbox(db, { minAgeMs = 60000, limit = 200 } = {}) {
  const rows = await db.sequelize.query(
    'SELECT id FROM capacity_outbox WHERE event_type = ? AND status IN (\'PENDING\', \'FAILED\') AND attempts < 10 AND created_at < ? ORDER BY created_at LIMIT ?',
    { replacements: utc([EVENT_TYPE, new Date(Date.now() - minAgeMs), limit]), type: QueryTypes.SELECT }
  );
  let processed = 0;
  for (const r of rows) {
    // FAILED rows go back to PENDING once per sweep.
    await db.sequelize.query('UPDATE capacity_outbox SET status = \'PENDING\' WHERE id = ? AND status = \'FAILED\'', { replacements: utc([r.id]) });
    try {
      await processRow(db, r.id);
      processed += 1;
    } catch (_) { /* recorded on the row */ }
  }
  return processed;
}

/**
 * A full reconcile of one device, in the background (registration, direction change, re-enable:
 * §8.2 "device created, re-paired, moved, direction changed"). Never throws, never blocks the caller.
 */
function reconcileDeviceSoon(db, deviceId, reason) {
  return track((async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await require('./device-sync.service').reconcileDevice(db, deviceId, reason, { priority: 9 });
  })());
}

/** Tests: wait until every background reconcile started so far has finished. */
async function settled() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

// ── Model hooks ───────────────────────────────────────────────────────────────
const SUB_FIELDS = ['status', 'startDate', 'endDate', 'branchId', 'freezeFrom', 'freezeTo', 'remainingVisits', 'userId'];
const STAFF_FIELDS = ['employmentStatus', 'status', 'branchId', 'userId'];

function attachHooks(models) {
  const { MemberSubscription, MemberProfile, GymStaff } = models;
  if (!MemberSubscription || MemberSubscription.__deviceHooks) return;
  MemberSubscription.__deviceHooks = true;
  const seq = MemberSubscription.sequelize;

  MemberSubscription.addHook('afterCreate', 'deviceSync', (sub, options) =>
    enqueue(seq, { memberIds: [sub.userId], reason: 'subscription_created', transaction: options.transaction }));
  MemberSubscription.addHook('afterUpdate', 'deviceSync', (sub, options) => {
    const changed = sub.changed() || [];
    if (!changed.some((f) => SUB_FIELDS.includes(f))) return null;
    return enqueue(seq, { memberIds: [sub.userId, sub.previous('userId')], reason: `subscription_${String(sub.status).toLowerCase()}`, transaction: options.transaction });
  });
  MemberSubscription.addHook('afterDestroy', 'deviceSync', (sub, options) =>
    enqueue(seq, { memberIds: [sub.userId], reason: 'subscription_deleted', transaction: options.transaction }));
  // Bulk writes (expiry cron, account deletion): find the members first, queue after.
  MemberSubscription.addHook('beforeBulkUpdate', 'deviceSync', async (options) => {
    const fields = options.fields || Object.keys(options.attributes || {});
    if (!fields.some((f) => SUB_FIELDS.includes(f))) return;
    if (!(await hasDevices(seq))) return;
    const rows = await MemberSubscription.findAll({ where: options.where, attributes: ['userId'], transaction: options.transaction, raw: true }).catch(() => []);
    options.__deviceMembers = rows.map((r) => r.userId);
  });
  MemberSubscription.addHook('afterBulkUpdate', 'deviceSync', (options) =>
    enqueue(seq, { memberIds: options.__deviceMembers, reason: 'subscriptions_bulk', transaction: options.transaction }));

  if (MemberProfile) {
    MemberProfile.addHook('afterCreate', 'deviceSync', (p, options) =>
      enqueue(seq, { memberIds: [p.userId], reason: 'member_created', transaction: options.transaction }));
  }
  if (GymStaff) {
    GymStaff.addHook('afterUpdate', 'deviceSync', (st, options) => {
      if (!(st.changed() || []).some((f) => STAFF_FIELDS.includes(f))) return null;
      return enqueue(seq, { memberIds: [st.userId, st.previous('userId')], reason: 'staff_changed', transaction: options.transaction });
    });
  }
}

module.exports = { EVENT_TYPE, enqueue, reconcileDeviceSoon, processRow, sweepOutbox, settled, attachHooks, hasDevices };
