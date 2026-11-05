/**
 * Phase 7 P9c (D, owner question): the CMS Subscription & Billing page showed a plan named
 * "Subscription" at Rs 4,999 with "Branches built 3 of 1".
 * Root cause of the name: the entitling row was a legacy PlatformPackage row (branchCount null:
 * created at web signup with bank transfer, tenant.service.js:330, or by the admin "assign
 * package" form) and getActiveSubscription included only maxBranches / maxOrganizations of the
 * package, so `package.name` never reached the CMS, which fell back to "Subscription".
 * Rs 4,999 / "of 1" are that package (seed "Starter": 4,999, maxBranches 1); 3 is the tenant's
 * real ACTIVE branches: the tenant is over its legacy quota.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { TenantSubscription, PlatformPackage } = require('../../src/models/platform');

describe('P9c: a legacy package plan is named by its package', () => {
  let ctx;
  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
  });
  afterAll(() => teardownTestDatabases());

  test('GET /host/subscription/current carries the package name and its branch limit', async () => {
    const pkg = await PlatformPackage.create({ name: 'Starter', price: 4999, billingCycle: 'MONTHLY', maxOrganizations: 1, maxBranches: 1, status: 'ACTIVE' });
    await TenantSubscription.destroy({ where: { tenantId: ctx.tenant1.id } });
    await TenantSubscription.create({
      tenantId: ctx.tenant1.id, platformPackageId: pkg.id, platform: 'MANUAL', startDate: new Date(), endDate: new Date(Date.now() + 20 * 86400000),
      amount: 4999, billingCycle: 'MONTHLY', status: 'ACTIVE', autoRenew: true, paymentStatus: 'PENDING',
    });
    const res = await asPersona('owner').get('/host/subscription/current');
    expect(res.status).toBe(200);
    expect(res.body.data.branchCount).toBeNull();
    expect(res.body.data.package).toMatchObject({ name: 'Starter', maxBranches: 1 });
  });
});
