/**
 * NEW-80: the daily expiry cron processed only the tenant pools that happened
 * to be open (TenantDbManager.getAllEntries) whenever at least one was open.
 * A tenant nobody had called since the last restart (or whose idle pool was
 * evicted, PERF-07) was silently skipped: its subscriptions never expired.
 * The cron must iterate every ACTIVE tenant from the platform DB.
 */
const { setupTestDatabases, teardownTestDatabases, factories } = require('../harness');
const TenantDbManager = require('../../src/database/TenantDbManager');
const { runExpiryCheck } = require('../../src/jobs/subscription-expiry.cron');

describe('NEW-80: expiry cron iterates ACTIVE tenants from the platform DB', () => {
  let h;
  const seeded = {};

  const seedExpiredSubscription = async (tenantDb, tenant, label) => {
    const user = await factories.createUser({ email: `${label}@new80.test`, role: 'MEMBER' });
    const listing = await factories.createGymListing(tenant.id);
    const branch = await factories.createBranch(tenantDb, listing.id, { name: `Branch ${label}` });
    const plan = await tenantDb.models.MembershipPlan.create({
      gymId: branch.gymId, branchId: branch.id, name: 'Std', price: 1000,
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
    });
    return tenantDb.models.MemberSubscription.create({
      userId: user.id, membershipPlanId: plan.id, branchId: branch.id,
      status: 'ACTIVE', startDate: '2020-01-01', endDate: '2020-01-31',
    });
  };

  beforeAll(async () => {
    // PERF-07: with a one-pool cap and no idle grace, the pool the cron opened
    // for tenant A is closed as soon as it opens tenant B's, so by the time the
    // per-tenant pass reads TenantDbManager.getAllEntries() only B is left.
    process.env.TENANT_POOL_CAP = '1';
    process.env.TENANT_POOL_MIN_IDLE_BEFORE_EVICT_MS = '0';
    h = await setupTestDatabases();
    seeded.tenantA = await factories.createTenant({ gymName: 'Cron A', tenantDbName: 'gymsera_test_tenant_1' });
    seeded.tenantB = await factories.createTenant({ gymName: 'Cron B', tenantDbName: 'gymsera_test_tenant_2' });
    seeded.pending = await factories.createTenant({
      gymName: 'Cron Pending', connectionStringEncrypted: 'PENDING_PROVISIONING',
    });
    seeded.subA = await seedExpiredSubscription(h.tenant1, seeded.tenantA, 'a');
    seeded.subB = await seedExpiredSubscription(h.tenant2, seeded.tenantB, 'b');
  });

  afterAll(async () => {
    delete process.env.TENANT_POOL_CAP;
    delete process.env.TENANT_POOL_MIN_IDLE_BEFORE_EVICT_MS;
    await TenantDbManager.releaseAll();
    await teardownTestDatabases();
  });

  test('a tenant whose pool was evicted is still processed', async () => {
    await TenantDbManager.releaseAll();
    // Pools open and close as tenants are used; an open pool is the only thing
    // the old per-tenant pass looked at.
    await TenantDbManager.getConnection(seeded.tenantA.id, seeded.tenantA.connectionStringEncrypted);
    await TenantDbManager.getConnection(seeded.tenantB.id, seeded.tenantB.connectionStringEncrypted);
    await new Promise((r) => setTimeout(r, 50));
    expect(TenantDbManager.getAllEntries().map(([id]) => id)).toEqual([seeded.tenantB.id]);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runExpiryCheck();
      const tenantErrors = errorSpy.mock.calls.filter((c) => String(c[0]).includes('[Cron] Failed to process tenant'));
      expect(tenantErrors).toEqual([]); // the PENDING_PROVISIONING tenant is skipped, not an error
    } finally {
      errorSpy.mockRestore();
    }

    await seeded.subA.reload();
    await seeded.subB.reload();
    expect(seeded.subA.status).toBe('EXPIRED');
    expect(seeded.subB.status).toBe('EXPIRED');
  });
});
