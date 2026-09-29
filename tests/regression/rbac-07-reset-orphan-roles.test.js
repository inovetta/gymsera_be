/**
 * Regression: RBAC-07 residual role correction script (gymsera-rbac07-reset-orphan-roles.js)
 *
 * Fixtures reproduce what the legacy /gyms/staff flow left behind: a platform user whose
 * users.role was raised to BRANCH_MANAGER while their only trace is someone else's staff
 * row. Verifies:
 * 1. PREVIEW makes zero writes and decides CORRECT only for live LIKELY_BUG_ORPHAN users.
 * 2. --apply without --confirm is refused.
 * 3. All-or-nothing: if any write fails, no role changes and no audit row remains.
 * 4. APPLY corrects the orphans to MEMBER, writes one audit row each, and SKIPS a user
 *    who has an ACTIVE role_assignment (plus owner / no-trace / non-BRANCH_MANAGER / missing).
 *    Users outside the target list are never touched.
 * 5. A second APPLY is a no-op ("already corrected").
 * 6. The CLI list is exactly the six ids from the check report.
 */
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { createUser, createTenant, createRoleAssignment } = require('../harness/factories');
const { TARGET_USER_IDS, AUDIT_ACTION, AUDIT_REASON, run } = require('../../gymsera-rbac07-reset-orphan-roles');

const quiet = () => {};

describe('RBAC-07 residual: reset orphaned BRANCH_MANAGER roles', () => {
  let db;
  let config;
  let platformDb;
  let admin;
  const u = {};
  let targets;

  const roleOf = async (id) => {
    const [[row]] = await admin.query(`SELECT role FROM \`${platformDb}\`.users WHERE id = ?`, [id]);
    return row ? row.role : null;
  };
  const auditRows = async () => {
    const [rows] = await admin.query(
      `SELECT target_id, target_type, actor_user_id, details FROM \`${platformDb}\`.platform_audit_logs WHERE action = ?`,
      [AUDIT_ACTION]
    );
    return rows;
  };

  beforeAll(async () => {
    db = await setupTestDatabases();
    platformDb = db.platform.database;
    config = {
      host: process.env.PLATFORM_TEST_DB_HOST || process.env.PLATFORM_DB_HOST || process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.PLATFORM_DB_PORT, 10),
      user: process.env.PLATFORM_TEST_DB_USER || process.env.PLATFORM_DB_USER || process.env.MYSQL_USER || 'root',
      password: process.env.PLATFORM_DB_PASS || '',
    };
    admin = await mysql.createConnection(config);

    const t1Models = db.tenant1.models;
    const t2Models = db.tenant2.models;
    // gym_staff.branch_id has a foreign key to branches: give each tenant a real branch.
    const branchIn = async (models) => {
      const gym = await models.Gym.create({ name: 'RBAC-07 Test Gym' });
      const branch = await models.Branch.create({ gymId: gym.id, branchName: 'Main', timezone: 'Asia/Karachi' });
      return branch.id;
    };
    const b1 = await branchIn(t1Models);
    const b2 = await branchIn(t2Models);

    // Two tenants owned by real hosts; tenant 1 -> gymsera_test_tenant_1, tenant 2 -> _2.
    const host1 = await createUser({ role: 'GYM_HOST' });
    const host2 = await createUser({ role: 'GYM_HOST' });
    await createTenant({ ownerUserId: host1.id, tenantDbName: 'gymsera_test_tenant_1' });
    await createTenant({ ownerUserId: host2.id, tenantDbName: 'gymsera_test_tenant_2' });

    // Orphan: legacy gym_staff row + a REVOKED assignment in someone else's tenant.
    u.orphan = await createUser({ role: 'BRANCH_MANAGER' });
    await t1Models.GymStaff.create({ branchId: b1, userId: u.orphan.id, email: u.orphan.email, designation: 'Manager', status: 'active' });
    await createRoleAssignment(db.tenant1, { userId: u.orphan.id, roleKey: 'MANAGER', overrides: { status: 'REVOKED' } });

    // Orphan matched only by e-mail (invite row never linked to the account).
    u.orphanByEmail = await createUser({ role: 'BRANCH_MANAGER' });
    await t2Models.GymStaff.create({ branchId: b2, userId: null, email: u.orphanByEmail.email.toUpperCase(), designation: 'Staff', status: 'pending' });

    // Same legacy pattern BUT with an ACTIVE assignment -> must be SKIPPED.
    u.activeStaff = await createUser({ role: 'BRANCH_MANAGER' });
    await t2Models.GymStaff.create({ branchId: b2, userId: u.activeStaff.id, designation: 'Manager', status: 'active' });
    await createRoleAssignment(db.tenant2, { userId: u.activeStaff.id, roleKey: 'MANAGER', overrides: { status: 'ACTIVE' } });

    // Elevated role but owns a tenant -> SKIP (OWNS_TENANT).
    u.owner = await createUser({ role: 'BRANCH_MANAGER' });
    await createTenant({ ownerUserId: u.owner.id, tenantDbName: 'gymsera_test_tenant_1' });

    // Elevated role, no trace anywhere -> SKIP (NO_TRACE).
    u.noTrace = await createUser({ role: 'BRANCH_MANAGER' });

    // Orphan pattern but TRAINER, not BRANCH_MANAGER -> SKIP (role mismatch).
    u.trainer = await createUser({ role: 'TRAINER' });
    await t1Models.GymStaff.create({ branchId: b1, userId: u.trainer.id, designation: 'Trainer', status: 'active' });

    // Orphan NOT in the target list -> must never be touched.
    u.bystander = await createUser({ role: 'BRANCH_MANAGER' });
    await t1Models.GymStaff.create({ branchId: b1, userId: u.bystander.id, designation: 'Manager', status: 'active' });

    targets = [u.orphan.id, u.orphanByEmail.id, u.activeStaff.id, u.owner.id, u.noTrace.id, u.trainer.id, uuidv4()];
  });

  afterAll(async () => {
    if (admin) {
      await admin.query('DROP TRIGGER IF EXISTS `' + platformDb + '`.rbac07_test_fail_audit').catch(() => {});
      await admin.end();
    }
    await teardownTestDatabases();
  });

  test('the CLI target list is exactly the six verified ids', () => {
    expect([...TARGET_USER_IDS]).toEqual([
      'cc831ec5-4e96-4c28-a178-7ef1d32517a3',
      '7ad08423-8307-4d56-af9f-b822176c8676',
      'aa51e47e-c17f-482a-b660-7a51af77ee95',
      '8bef883e-21ef-465f-9097-6e45989a24e3',
      'bba04312-cb45-4336-9748-4eb242fe5699',
      '039a8f11-483d-40e6-a68a-19e8e458077c',
    ]);
    expect(Object.isFrozen(TARGET_USER_IDS)).toBe(true);
  });

  test('PREVIEW decides per live verdict and makes zero writes', async () => {
    const res = await run({ config, platformDb, userIds: targets, log: quiet });
    const byId = Object.fromEntries(res.evaluation.results.map((r) => [r.id, r]));

    expect(res.mode).toBe('PREVIEW');
    expect(byId[u.orphan.id]).toMatchObject({ decision: 'CORRECT', verdict: 'LIKELY_BUG_ORPHAN' });
    expect(byId[u.orphanByEmail.id]).toMatchObject({ decision: 'CORRECT', verdict: 'LIKELY_BUG_ORPHAN' });
    expect(byId[u.activeStaff.id]).toMatchObject({ decision: 'SKIP', verdict: 'STAFF_ACCESS_CURRENT' });
    expect(byId[u.activeStaff.id].reason).toMatch(/ACTIVE role_assignment/);
    expect(byId[u.owner.id]).toMatchObject({ decision: 'SKIP', verdict: 'OWNS_TENANT' });
    expect(byId[u.noTrace.id]).toMatchObject({ decision: 'SKIP', verdict: 'NO_TRACE' });
    expect(byId[u.trainer.id]).toMatchObject({ decision: 'SKIP', reason: 'role is TRAINER, not BRANCH_MANAGER' });
    expect(byId[targets[6]]).toMatchObject({ decision: 'SKIP', reason: 'user not found' });

    for (const id of [u.orphan.id, u.orphanByEmail.id, u.activeStaff.id, u.owner.id, u.noTrace.id]) {
      expect(await roleOf(id)).toBe('BRANCH_MANAGER');
    }
    expect(await auditRows()).toHaveLength(0);
  });

  test('--apply without --confirm is refused and writes nothing', async () => {
    await expect(run({ config, platformDb, userIds: targets, apply: true, log: quiet })).rejects.toThrow(/--apply requires --confirm/);
    expect(await roleOf(u.orphan.id)).toBe('BRANCH_MANAGER');
    expect(await auditRows()).toHaveLength(0);
  });

  test('all-or-nothing: a failing audit insert for the 2nd user rolls back the 1st', async () => {
    await admin.query(
      `CREATE TRIGGER \`${platformDb}\`.rbac07_test_fail_audit BEFORE INSERT ON \`${platformDb}\`.platform_audit_logs
       FOR EACH ROW BEGIN
         IF NEW.target_id = '${u.orphanByEmail.id}' THEN
           SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced failure for test';
         END IF;
       END`
    );
    try {
      await expect(run({ config, platformDb, userIds: targets, apply: true, confirm: true, log: quiet })).rejects.toThrow(/forced failure/);
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS \`${platformDb}\`.rbac07_test_fail_audit`);
    }
    expect(await roleOf(u.orphan.id)).toBe('BRANCH_MANAGER');
    expect(await roleOf(u.orphanByEmail.id)).toBe('BRANCH_MANAGER');
    expect(await auditRows()).toHaveLength(0);
  });

  test('APPLY corrects the orphans, audits each, skips the active-assignment user, post-check passes', async () => {
    const res = await run({ config, platformDb, userIds: targets, apply: true, confirm: true, log: quiet });

    expect(res.corrected.sort()).toEqual([u.orphan.id, u.orphanByEmail.id].sort());
    expect(res.skipped.map((s) => s.id).sort()).toEqual(
      [u.activeStaff.id, u.owner.id, u.noTrace.id, u.trainer.id, targets[6]].sort()
    );
    expect(res.postCheck.ok).toBe(true);

    expect(await roleOf(u.orphan.id)).toBe('MEMBER');
    expect(await roleOf(u.orphanByEmail.id)).toBe('MEMBER');
    expect(await roleOf(u.activeStaff.id)).toBe('BRANCH_MANAGER');
    expect(await roleOf(u.owner.id)).toBe('BRANCH_MANAGER');
    expect(await roleOf(u.noTrace.id)).toBe('BRANCH_MANAGER');
    expect(await roleOf(u.trainer.id)).toBe('TRAINER');
    expect(await roleOf(u.bystander.id)).toBe('BRANCH_MANAGER');

    const audits = await auditRows();
    expect(audits.map((a) => a.target_id).sort()).toEqual([u.orphan.id, u.orphanByEmail.id].sort());
    for (const a of audits) {
      const details = typeof a.details === 'string' ? JSON.parse(a.details) : a.details;
      expect(a.target_type).toBe('user');
      expect(a.actor_user_id).toBeNull();
      expect(details).toMatchObject({ beforeRole: 'BRANCH_MANAGER', afterRole: 'MEMBER', reason: AUDIT_REASON, verdict: 'LIKELY_BUG_ORPHAN' });
      expect(details.evidence.activeRoleAssignments).toEqual([]);
      expect(details.evidence.ownedTenants).toEqual([]);
    }
  });

  test('second APPLY is a no-op: already corrected, no new audit rows', async () => {
    const res = await run({ config, platformDb, userIds: targets, apply: true, confirm: true, log: quiet });
    expect(res.corrected).toEqual([]);
    const byId = Object.fromEntries(res.skipped.map((s) => [s.id, s.reason]));
    expect(byId[u.orphan.id]).toMatch(/already corrected/);
    expect(byId[u.orphanByEmail.id]).toMatch(/already corrected/);
    expect(await auditRows()).toHaveLength(2);
    expect(res.postCheck.ok).toBe(true);
  });
});
