/**
 * Phase 7 P10 item 5: one Apple ID (or Google account) used on two host accounts.
 *
 * The billing guard (BILL-01, subscription-migration.service.js) leaves the subscription with
 * the tenant that owns it and answers the other host 409 subscription_owned_by_other_account.
 * Before: that refusal wrote nothing to the API log, so an admin could not tell which two
 * accounts were involved; only the owner's own sync with another tenant's store token logged a
 * line. Now every ownership mismatch writes one "ownership mismatch" line naming both tenants
 * (ids only, no names, no transaction id), and the answer keeps its code and copy.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { City, TenantSubscription } = require('../../src/models/platform');

describe('P10 item 5: an ownership mismatch names both tenants in the log', () => {
  let app; let h; let tenantA; let tenantB; let tokenA; let tokenB; let plan;
  let warnings;

  beforeAll(async () => {
    app = await startTestServer();
    h = await setupTestDatabases();
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenantA = await factories.createTenant({ connectionStringEncrypted: h.tenant1.encryptedConnStr });
    tenantB = await factories.createTenant({ connectionStringEncrypted: h.tenant2.encryptedConnStr });
    await factories.createGymListing(tenantA.id);
    await factories.createGymListing(tenantB.id);
    plan = await factories.createBillingPlan({ branchCount: 3, sortOrder: 3 });
    const tokenFor = (t) => signToken({ sub: t.ownerUserId, id: t.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: t.id });
    tokenA = tokenFor(tenantA);
    tokenB = tokenFor(tenantB);
    warnings = [];
    jest.spyOn(console, 'warn').mockImplementation((...args) => warnings.push(args.join(' ')));
  });

  const iosSync = (token, transactionId) =>
    request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId });
  const androidSync = (token, purchaseToken) =>
    request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`)
      .send({ purchaseToken, productId: plan.androidProductId });
  const mismatchLines = () => warnings.filter((l) => l.includes('ownership mismatch'));
  const expectNamesBoth = (line) => {
    expect(line).toContain(tenantA.id);
    expect(line).toContain(tenantB.id);
  };

  test('Apple: host B syncs host A’s subscription (same Apple ID): 409, the plan stays with A, one line names A and B', async () => {
    fakes.installAppleFakes({ 5100001: fakes.appleTransaction({ originalTransactionId: '5100001', productId: plan.iosMonthlyProductId }) });
    expect((await iosSync(tokenA, '5100001')).status).toBe(200);
    expect(mismatchLines()).toHaveLength(0);

    const res = await iosSync(tokenB, '5100001');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('subscription_owned_by_other_account');
    expect((await TenantSubscription.findOne({ where: { externalOriginalTransactionId: '5100001' } })).tenantId).toBe(tenantA.id);

    const lines = mismatchLines();
    expect(lines).toHaveLength(1);
    expectNamesBoth(lines[0]);
    expect(lines[0]).toMatch(/owned by tenant/);
    expect(lines[0]).not.toContain('5100001'); // no store transaction id in the log
  });

  test('Apple: no row yet, the store token names A, B syncs: 409 and one line names A and B', async () => {
    fakes.installAppleFakes({
      5100002: fakes.appleTransaction({ originalTransactionId: '5100002', productId: plan.iosMonthlyProductId, appAccountToken: tenantA.id }),
    });
    const res = await iosSync(tokenB, '5100002');
    expect(res.status).toBe(409);
    const lines = mismatchLines();
    expect(lines).toHaveLength(1);
    expectNamesBoth(lines[0]);
  });

  test('Apple: A owns the row and B bought on the same Apple ID (token names B): A keeps it, one line names A and B', async () => {
    fakes.installAppleFakes({ 5100003: fakes.appleTransaction({ originalTransactionId: '5100003', productId: plan.iosMonthlyProductId }) });
    expect((await iosSync(tokenA, '5100003')).status).toBe(200);
    fakes.installAppleFakes({
      5100003: fakes.appleTransaction({ originalTransactionId: '5100003', productId: plan.iosMonthlyProductId, appAccountToken: tenantB.id }),
    });
    expect((await iosSync(tokenA, '5100003')).status).toBe(200);
    expect((await TenantSubscription.findOne({ where: { externalOriginalTransactionId: '5100003' } })).tenantId).toBe(tenantA.id);
    const lines = mismatchLines();
    expect(lines).toHaveLength(1);
    expectNamesBoth(lines[0]);
  });

  test('Google: the same rule and the same line', async () => {
    fakes.installGoogleFakes({ 'tok-p10': fakes.googlePurchase({ productId: plan.androidProductId }) });
    expect((await androidSync(tokenA, 'tok-p10')).status).toBe(200);
    const res = await androidSync(tokenB, 'tok-p10');
    expect(res.status).toBe(409);
    const lines = mismatchLines();
    expect(lines).toHaveLength(1);
    expectNamesBoth(lines[0]);
  });
});
