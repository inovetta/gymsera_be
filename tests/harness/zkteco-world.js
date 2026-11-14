/**
 * ZKTeco Phase 2 test world: the harness tenants, an API server, and helpers to add devices (with a
 * simulator that registers), gyms, branches, plans, members and subscriptions. Dates are always
 * relative to today in the branch's time zone (NEW-207: no calendar literals in tests).
 */
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, setupPersonas } = require('./index');
const { personaManager } = require('./personas');
const { startTestServer } = require('./test-server');
const { createUser, createBranch } = require('./factories');
const { ZkDeviceSimulator } = require('../../scripts/zk-device-simulator');
const registry = require('../../src/services/devices/device-registry.service');
const triggers = require('../../src/services/devices/device-triggers');
const { computeBusinessDate } = require('../../src/services/ledger.service');
const { addDays } = require('../../src/utils/business-date.utils');
const { sequelize: platformDb } = require('../../src/database/platform');

const DEVICE_TABLES = [
  'access_device_details', 'device_commands', 'device_member_sync', 'member_device_identity', 'member_biometrics', 'member_biometric_photos',
  'member_biometric_consents', 'device_access_events', 'device_state', 'device_error_logs', 'device_unlinked_users', 'device_audits', 'device_audit_pins',
  'device_push_requests', 'device_capture_photos', 'device_branch_settings',
  'device_imports', 'device_import_users', 'device_import_templates', 'device_import_packs',
  'device_admin_pins',
];

// A test-only biometric key, made fresh per run (never a real key).
process.env.BIOMETRIC_DATA_KEY = process.env.BIOMETRIC_DATA_KEY || `1:${crypto.randomBytes(32).toString('hex')}`;

const TZ = 'Asia/Karachi';
const today = (tz = TZ) => computeBusinessDate(new Date(), tz);
const day = (n, tz = TZ) => addDays(today(tz), n);
/** Device local time for "now + minutes" in the branch zone, 'YYYY-MM-DD HH:MM:SS'. */
const localNow = (minutes = 0, tz = TZ) => {
  const p = require('../../src/services/devices/sync-rules').localParts(new Date(Date.now() + minutes * 60000), tz);
  const z = (v) => String(v).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)} ${z(p.hour)}:${z(p.minute)}:${z(p.second)}`;
};

let serial = 0;
const RUN = Math.random().toString(36).slice(2, 6).toUpperCase();

async function createWorld() {
  const h = await setupTestDatabases();
  const personas = await setupPersonas(h);
  const ctx = personaManager.context;
  await platformDb.query('DELETE FROM `access_devices`');
  await platformDb.query('DELETE FROM `unclaimed_device_contacts`');
  for (const db of [ctx.tenant1Db, ctx.tenant2Db]) {
    for (const t of DEVICE_TABLES) await db.sequelize.query(`DELETE FROM \`${t}\``);
    await db.sequelize.query('UPDATE device_pin_sequence SET next_pin = 1001 WHERE id = 1');
    await db.sequelize.query('DELETE FROM capacity_outbox WHERE event_type = \'DEVICE_RECONCILE\'');
    await db.sequelize.query('DELETE FROM audit_logs WHERE action LIKE \'devices.%\' OR action LIKE \'biometrics.%\'');
    if (db.tenantId === undefined) db.tenantId = db === ctx.tenant1Db ? ctx.tenant1.id : ctx.tenant2.id;
  }
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const w = {
    ctx,
    owner: personas.owner,
    baseUrl,
    db1: ctx.tenant1Db,
    db2: ctx.tenant2Db,

    async gym(db, name = `Org ${uuidv4().slice(0, 6)}`) {
      return db.models.Gym.create({ id: uuidv4(), name, gymListingId: ctx.branch1.gymListingId || null });
    },

    async branch(db, { gymId, timezone = TZ, name } = {}) {
      const b = await createBranch(db, ctx.branch1.gymListingId || null, { gymId, timezone, branchName: name || `Branch ${uuidv4().slice(0, 6)}` });
      return b;
    },

    async plan(db, branch) {
      return db.models.MembershipPlan.create({ id: uuidv4(), gymId: branch.gymId, branchId: branch.id, name: 'Monthly', durationType: 'MONTHLY', durationValue: 1, price: 1000, status: 'ACTIVE' });
    },

    async member(fullName = 'Device Member', over = {}) {
      return createUser({ fullName, ...over });
    },

    /** An ACTIVE subscription from `start` to `end` (relative days). Fires the model hooks (real-time). */
    async subscribe(db, { user, branch, start = -10, end = 20, status = 'ACTIVE', remainingVisits = null }) {
      const plan = await w.plan(db, branch);
      const sub = await db.models.MemberSubscription.create({
        userId: user.id, branchId: branch.id, membershipPlanId: plan.id, startDate: day(start, branch.timezone || TZ),
        endDate: day(end, branch.timezone || TZ), status, subscribedAt: new Date(), remainingVisits,
      });
      await triggers.settled();
      return sub;
    },

    /**
     * A device on `branch`, registered by a simulator (capabilities known), with the first reconcile done.
     * importFirst: added in import hold (Phase 4: a device that already has another system's users).
     */
    async device(db, { branch, direction = 'in', name = 'Door', registryBody, tenantId, importFirst = false, ...simOpts } = {}) {
      const tid = tenantId || db.tenantId;
      const { device } = await registry.createDevice({ tenantId: tid, tenantDb: db, branchId: branch.id, organizationId: branch.gymId || null, name, direction, importFirst, createdBy: personas.owner.user.id });
      const sim = new ZkDeviceSimulator({ baseUrl, sn: `SIM${RUN}${String(++serial).padStart(4, '0')}`, key: device.deviceKey, mode: 'host', registryBody, ...simOpts });
      const c = await sim.connect();
      if (!c.ok) throw new Error(`simulator did not connect: ${c.step} ${c.res.status}`);
      await triggers.settled();
      return { device, sim, id: device.id };
    },

    settled: () => triggers.settled(),

    async syncRow(db, deviceId, memberId) {
      const [row] = await db.sequelize.query('SELECT * FROM device_member_sync WHERE device_id = ? AND member_id = ?', { replacements: [deviceId, memberId], type: QueryTypes.SELECT });
      return row || null;
    },

    async commands(db, deviceId, where = '1=1', rep = []) {
      return db.sequelize.query(`SELECT * FROM device_commands WHERE device_id = ? AND ${where} ORDER BY id`, { replacements: [deviceId, ...rep], type: QueryTypes.SELECT });
    },

    async pinOf(db, memberId) {
      const [row] = await db.sequelize.query('SELECT pin FROM member_device_identity WHERE member_id = ?', { replacements: [memberId], type: QueryTypes.SELECT });
      return row ? String(row.pin) : null;
    },

    q: (db, sql, rep = []) => db.sequelize.query(sql, { replacements: rep, type: QueryTypes.SELECT }),
  };
  return w;
}

module.exports = { createWorld, today, day, localNow, TZ, DEVICE_TABLES };
