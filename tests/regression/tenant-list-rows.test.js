/**
 * Regression Test: §9.7 tenant list rows
 * Spec §13 / Mobile Doc §9.7
 *
 * Requirement:
 * Tenant with 3 ACTIVE orgs -> 1 row in the admin tenant list.
 */
const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
} = require('../harness');
const adminService = require('../../src/services/admin.service');

describe('Regression §9.7: tenant list rows', () => {
  let dbHarness;
  let tenant;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant = await factories.createTenant({
      gymName: 'Multi-Org Fitness Group',
      status: 'ACTIVE',
    });

    // Create 3 ACTIVE organizations under this tenant
    await factories.createGymListing(tenant.id, {
      title: 'Org 1 - Downtown',
      status: 'ACTIVE',
    });
    await factories.createGymListing(tenant.id, {
      title: 'Org 2 - Uptown',
      status: 'ACTIVE',
    });
    await factories.createGymListing(tenant.id, {
      title: 'Org 3 - Midtown',
      status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('Tenant with 3 ACTIVE organizations produces exactly 1 row in listTenants', async () => {
    const result = await adminService.listTenants({
      status: 'ACTIVE',
      page: 1,
      limit: 50,
      offset: 0,
    });

    // Filter to rows matching this tenant
    const matchingRows = result.tenants.filter(
      (t) => t.id === tenant.id || t.tenantId === tenant.id || t.id.startsWith(`${tenant.id}:`)
    );

    // §9.7 invariant: ACTIVE organizations must never be synthesized as duplicate top-level tenant rows
    expect(matchingRows).toHaveLength(1);
    expect(matchingRows[0].id).toBe(tenant.id);
  });
});
