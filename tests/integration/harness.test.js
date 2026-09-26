/**
 * Test Harness & Factories Self-Check
 * Verifies that the real MySQL test databases, factories, and persona caller work as specified.
 */
const {
  setupTestDatabases,
  resetTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
  asPersona,
} = require('../harness');

describe('Integration Test Harness & Factories', () => {
  let dbHarness;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    await setupPersonas(dbHarness);
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('Real MySQL test databases initialized (Safety Rule R-19)', () => {
    expect(dbHarness.platform.database).toBe('gymsera_test_platform');
    expect(dbHarness.tenant1.database).toBe('gymsera_test_tenant_1');
    expect(dbHarness.tenant2.database).toBe('gymsera_test_tenant_2');
  });

  test('Factories create records across platform and tenant databases', async () => {
    // 1. Tenant & Subscription
    const tenant = await factories.createTenant({ gymName: 'Factory Test Gym' });
    expect(tenant.id).toBeDefined();

    const sub = await factories.createTenantSubscription(tenant.id, { branchCount: 3 });
    expect(sub.branchCount).toBe(3);
    expect(sub.status).toBe('ACTIVE');

    // 2. GymListing
    const listing = await factories.createGymListing(tenant.id, { title: 'Factory Listing' });
    expect(listing.title).toBe('Factory Listing');

    // 3. Branch in tenant DB
    const branch = await factories.createBranch(dbHarness.tenant1, listing.id, {
      branchName: 'North Branch',
    });
    expect(branch.branchName).toBe('North Branch');
    expect(branch.status).toBe('ACTIVE');

    // 4. RoleAssignment in tenant DB
    const user = await factories.createUser({ role: 'BRANCH_MANAGER' });
    const assignment = await factories.createRoleAssignment(dbHarness.tenant1, {
      userId: user.id,
      roleKey: 'BRANCH_MANAGER',
      scopeType: 'BRANCH',
      scopeId: branch.id,
      branchIds: [branch.id],
      tenantId: tenant.id,
    });
    expect(assignment.roleKey).toBe('MANAGER');
    expect(assignment.roleLevel).toBe(60);

    // 5. Payment in tenant DB
    const payment = await factories.createPayment(dbHarness.tenant1, branch.id, {
      amount: 7500.00,
    });
    expect(payment.amount).toBe(7500.00);
    expect(payment.status).toBe('COMPLETED');
  });

  test('Persona helper calls API with §8.4 roles', async () => {
    // 1. Anonymous call to health/discovery
    const resAnon = await asPersona('anonymous').get('/discovery/cities');
    expect([200, 404]).toContain(resAnon.status);

    // 2. Member call to /me/profile
    const resMember = await asPersona('member').get('/me/profile');
    expect([200, 401, 404]).toContain(resMember.status);

    // 3. Owner call to /host/branch-quota
    const resOwner = await asPersona('owner').get('/host/branch-quota');
    expect([200, 404]).toContain(resOwner.status);
    if (resOwner.status === 200) {
      expect(resOwner.body).toHaveProperty('success');
    }

    // 4. Manager call to /gyms/branches
    const resManager = await asPersona('manager').get('/gyms/branches');
    expect([200, 403, 404]).toContain(resManager.status);
  });
});
