/**
 * OBS-06 — the nightly capacity audit alerts instead of only logging
 * (spec §12.12). Before: `subscription-expiry.cron.js` only console.warn'd on
 * ledger drift, an over-quota mismatch or an empty ACTIVE organization.
 */
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const TenantDbManager = require('../../src/database/TenantDbManager');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const alertService = require('../../src/services/alert.service');
const { Notification, City } = require('../../src/models/platform');
const { reconcileCapacityForAllTenants } = require('../../src/jobs/subscription-expiry.cron');

describe('OBS-06: nightly capacity audit raises alerts', () => {
  let h;
  let admin;

  const makeTenant = async (db, name) => {
    const tenant = await factories.createTenant({ gymName: name, tenantDbName: db });
    await factories.createTenantSubscription(tenant.id, { branchCount: 20, overQuotaCount: 0 });
    return tenant;
  };
  // An ACTIVE organization with one ACTIVE branch (not empty) and slots the ledger does not explain.
  const addDrift = async (tenant, tenantDb) => {
    const listing = await factories.createGymListing(tenant.id, { status: 'ACTIVE', reservedSlots: 2 });
    await factories.createBranch(tenantDb, listing.id);
    return listing;
  };
  const addEmptyOrg = (tenant) => factories.createGymListing(tenant.id, { status: 'ACTIVE', reservedSlots: 0 });
  const alerts = async (code) =>
    (await Notification.findAll({ where: { type: 'PLATFORM_ALERT', userId: admin.id } })).filter(
      (n) => (n.metadataJson || n.metadata || {}).alertCode === code
    );

  beforeAll(async () => {
    h = await setupTestDatabases();
  });
  afterAll(async () => {
    await TenantDbManager.releaseAll();
    await teardownTestDatabases();
  });
  beforeEach(async () => {
    await resetTestDatabases();
    // the reset truncates cities, and the tenant factory needs city 1
    await City.create({ id: 1, name: 'Karachi', isActive: true });
    alertService._resetForTests();
    admin = await factories.createUser({ role: 'PLATFORM_ADMIN' });
  });
  afterEach(() => jest.restoreAllMocks());

  test('a tenant with ledger drift raises CAPACITY_DRIFT with its id and counts, no names', async () => {
    const t = await makeTenant('gymsera_test_tenant_1', 'Drifting Gym Ltd');
    await addDrift(t, h.tenant1);
    await reconcileCapacityForAllTenants();
    const [row] = await alerts('CAPACITY_DRIFT');
    expect(row).toBeDefined();
    const meta = row.metadataJson || row.metadata;
    expect(meta).toMatchObject({ tenantCount: 1, tenantIds: [t.id], driftedListingCount: 1 });
    expect(JSON.stringify(row.toJSON())).not.toContain('Drifting Gym');
    expect(await alerts('CAPACITY_EMPTY_ACTIVE_ORG')).toHaveLength(0);
  });

  test('an ACTIVE organization with no ACTIVE branch raises CAPACITY_EMPTY_ACTIVE_ORG', async () => {
    const t = await makeTenant('gymsera_test_tenant_1', 'Empty Org Gym');
    await addEmptyOrg(t);
    await reconcileCapacityForAllTenants();
    const [row] = await alerts('CAPACITY_EMPTY_ACTIVE_ORG');
    const meta = row.metadataJson || row.metadata;
    expect(meta).toMatchObject({ tenantCount: 1, tenantIds: [t.id], emptyOrgCount: 1 });
    expect(await alerts('CAPACITY_DRIFT')).toHaveLength(0);
  });

  test('a clean tenant raises nothing', async () => {
    const t = await makeTenant('gymsera_test_tenant_1', 'Clean Gym');
    const listing = await factories.createGymListing(t.id, { status: 'ACTIVE', reservedSlots: 0 });
    await factories.createBranch(h.tenant1, listing.id);
    await reconcileCapacityForAllTenants();
    expect(await Notification.count({ where: { type: 'PLATFORM_ALERT' } })).toBe(0);
  });

  test('several tenants in one run give ONE alert per code (aggregated), not one per tenant', async () => {
    const a = await makeTenant('gymsera_test_tenant_1', 'Gym A');
    const b = await makeTenant('gymsera_test_tenant_2', 'Gym B');
    await addDrift(a, h.tenant1);
    await addDrift(b, h.tenant2);
    await reconcileCapacityForAllTenants();
    const rows = await alerts('CAPACITY_DRIFT');
    expect(rows).toHaveLength(1);
    const meta = rows[0].metadataJson || rows[0].metadata;
    expect(meta.tenantCount).toBe(2);
    expect([...meta.tenantIds].sort()).toEqual([a.id, b.id].sort());
  });

  test('the same problem on the next run within the hour does not alert again', async () => {
    const t = await makeTenant('gymsera_test_tenant_1', 'Drifting Gym');
    await addDrift(t, h.tenant1);
    await reconcileCapacityForAllTenants();
    await reconcileCapacityForAllTenants();
    expect(await alerts('CAPACITY_DRIFT')).toHaveLength(1);
  });

  test('an audit that cannot run raises CAPACITY_AUDIT_FAILED instead of failing silently', async () => {
    const t = await makeTenant('gymsera_test_tenant_1', 'Broken Audit Gym');
    jest.spyOn(subscriptionQuotaService, 'auditCapacity').mockRejectedValue(new Error('boom'));
    await reconcileCapacityForAllTenants();
    const [row] = await alerts('CAPACITY_AUDIT_FAILED');
    const meta = row.metadataJson || row.metadata;
    expect(meta).toMatchObject({ tenantCount: 1, tenantIds: [t.id] });
  });

  test('the detailed console warnings are still printed for the logs', async () => {
    const t = await makeTenant('gymsera_test_tenant_1', 'Logged Gym');
    await addDrift(t, h.tenant1);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await reconcileCapacityForAllTenants();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('CAPACITY AUDIT FAILED'))).toBe(true);
  });
});
