/**
 * NEW-124 — an approved host's Gyms tab shows "A database error occurred" (2026-10-26,
 * reference 5bf8b433-bb37-4802-98ff-10baf60168c4).
 *
 * The Gyms tab calls, for an approved host: /host/status (or the /me/bootstrap seed),
 * /host/listings, /host/branches, /host/branch-quota (+ ?organizationId=),
 * /subscriptions/staff?status=PENDING, /notifications/unread-count and, per branch card,
 * /host/branches/:id/dashboard. Only /host/branches and the dashboard read whole `branches`
 * rows from the tenant database; Branch.findAll selects every model column, including
 * `currency` (GLB-02, tenant migration 019). A tenant database still at v18 answers
 * "Unknown column 'currency'", a Sequelize DatabaseError → 500 database_error. The counts
 * (/host/branch-quota) are COUNT(*) and keep working, and an unpaid host never opens the
 * tenant database, which is why only approved hosts see it.
 *
 * Before Phase 7 P2 the app turned the failed branch list into [] ("no branch", BUG-21);
 * NEW-114 (client) shows the error instead. The fix is applying tenant migration 019 in
 * production: this test proves the failure on a v18 database and that the migration runner
 * (`node src/scripts/run-tenant-migrations.js`) clears it.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam } = require('../harness/two-branch-team');
const { runTenantMigrations, TARGET_SCHEMA_VERSION } = require('../../src/database/tenant-migration-runner');

let app;
let team;
let h;

beforeAll(async () => {
  h = await setupTestDatabases();
  const personas = await setupPersonas(h);
  team = await buildTwoBranchTeam(h, personas);
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const get = (path) => request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${team.ownerToken}`);

const gymsTabCalls = () => [
  '/host/status',
  '/me/bootstrap',
  '/host/listings',
  '/host/branches',
  '/host/branch-quota',
  `/host/branch-quota?organizationId=${team.branchA.gymListingId}`,
  '/subscriptions/staff?status=PENDING&limit=1',
  '/notifications/unread-count',
  `/host/branches/${team.branchA.id}/dashboard`,
];

/** The tenant database as production has it when migration 019 was never applied. */
const toPre019 = async () => {
  const seq = h.tenant1.sequelize;
  await seq.query('DELETE FROM schema_migrations WHERE version >= 19');
  await seq.query('ALTER TABLE `branches` DROP COLUMN `currency`');
};

describe('NEW-124: the Gyms tab on a tenant database below schema v19', () => {
  test('at v18 the branch list and the branch dashboard fail with database_error; the counts do not', async () => {
    await toPre019();

    const branches = await get('/host/branches');
    expect(branches.status).toBe(500);
    expect(branches.body.code).toBe('database_error');
    expect(branches.body.message).toBe('A database error occurred');

    const dashboard = await get(`/host/branches/${team.branchA.id}/dashboard`);
    expect(dashboard.status).toBe(500);
    expect(dashboard.body.code).toBe('database_error');

    // Why the "1 of 1 used" and the unpaid host kept working: no full branch row is read.
    expect((await get('/host/branch-quota')).status).toBe(200);
    expect((await get('/host/listings')).status).toBe(200);
  });

  test('after the tenant migration runner, every Gyms tab call answers 200 with the real branches', async () => {
    const res = await runTenantMigrations(h.tenant1.sequelize, { tenantId: team.tenantId });
    expect(res.applied).toContain('019_add_branch_currency');
    expect(res.finalVersion).toBe(TARGET_SCHEMA_VERSION);

    for (const path of gymsTabCalls()) {
      const r = await get(path);
      expect({ path, status: r.status }).toEqual({ path, status: 200 });
    }

    const branches = await get('/host/branches');
    const ids = branches.body.data.branches.map((b) => b.id).sort();
    expect(ids).toEqual([team.branchA.id, team.branchB.id].sort());
    expect(branches.body.data.branches.every((b) => b.currency === 'PKR')).toBe(true);
  });
});
