/**
 * BILL-01 — A store purchase is bound to exactly one tenant (spec §7.5.2, §12.1).
 *
 * Tenant B restoring/verifying a transaction tenant A owns must get
 * 409 subscription_owned_by_other_account and change nothing: the row stays
 * A's, A keeps its entitlement, B gains none. The binding comes from the row
 * that already exists, or — before any row exists — from the tenant id the
 * app sent with the purchase (Apple appAccountToken, Google
 * obfuscatedExternalAccountId).
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
// supertest calls a server already listening on 127.0.0.1 (TEST-FLAKE-1B).
const { startTestServer } = require('../harness/test-server');

let app;
beforeAll(async () => {
  app = await startTestServer();
});
const { signToken } = require('../../src/utils/jwt.utils');
const { City, Tenant, TenantSubscription, BillingEvent } = require('../../src/models/platform');
const quota = require('../../src/services/subscription-quota.service');

describe('BILL-01: store purchases are bound to one tenant', () => {
  let dbHarness;
  let tenantA;
  let tenantB;
  let tokenA;
  let tokenB;
  let plan5;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenantA = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    tenantB = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant2.encryptedConnStr });
    await factories.createGymListing(tenantA.id);
    await factories.createGymListing(tenantB.id);
    plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5 });
    const tokenFor = (t) => signToken({ sub: t.ownerUserId, id: t.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: t.id });
    tokenA = tokenFor(tenantA);
    tokenB = tokenFor(tenantB);
  });

  const iosSync = (token, transactionId) =>
    request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId });
  const androidSync = (token, purchaseToken) =>
    request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`)
      .send({ purchaseToken, productId: plan5.androidProductId });
  const entitlement = async (tenant) =>
    quota.resolveMaxBranches(await Tenant.findByPk(tenant.id), await quota.getActiveSubscription(tenant.id));
  const expectOwnedByOther = (res) => {
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('subscription_owned_by_other_account');
  };

  test('tenant B restoring tenant A’s Apple transaction gets 409; the row, A’s entitlement and B’s stay unchanged', async () => {
    fakes.installAppleFakes({ 4000001: fakes.appleTransaction({ originalTransactionId: '4000001', productId: plan5.iosMonthlyProductId }) });
    expect((await iosSync(tokenA, '4000001')).status).toBe(200);
    const before = (await TenantSubscription.findAll()).map((r) => r.toJSON());

    expectOwnedByOther(await iosSync(tokenB, '4000001'));

    expect((await TenantSubscription.findAll()).map((r) => r.toJSON())).toEqual(before);
    const row = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: '4000001' } });
    expect(row.tenantId).toBe(tenantA.id);
    expect(row.status).toBe('ACTIVE');
    expect(await entitlement(tenantA)).toBe(5);
    expect(await quota.getActiveSubscription(tenantB.id)).toBeNull();
  });

  test('before any row exists, Apple’s appAccountToken decides: only the tenant that bought it can claim it', async () => {
    fakes.installAppleFakes({
      4000002: fakes.appleTransaction({ originalTransactionId: '4000002', productId: plan5.iosMonthlyProductId, appAccountToken: tenantA.id }),
    });

    expectOwnedByOther(await iosSync(tokenB, '4000002'));
    expect(await TenantSubscription.count()).toBe(0);

    expect((await iosSync(tokenA, '4000002')).status).toBe(200);
    const row = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: '4000002' } });
    expect(row.tenantId).toBe(tenantA.id);
  });

  test('Google: obfuscatedExternalAccountId naming tenant A → tenant B gets 409', async () => {
    fakes.installGoogleFakes({
      'tok-bound': fakes.googlePurchase({ productId: plan5.androidProductId, obfuscatedExternalAccountId: tenantA.id }),
    });

    expectOwnedByOther(await androidSync(tokenB, 'tok-bound'));
    expect(await TenantSubscription.count()).toBe(0);
    expect((await androidSync(tokenA, 'tok-bound')).status).toBe(200);
    expectOwnedByOther(await androidSync(tokenB, 'tok-bound'));
    expect(await entitlement(tenantA)).toBe(5);
  });

  test('two tenants verifying the same new transaction at the same moment: exactly one wins', async () => {
    fakes.installAppleFakes({ 4000003: fakes.appleTransaction({ originalTransactionId: '4000003', productId: plan5.iosMonthlyProductId }) });

    const results = await Promise.all([iosSync(tokenA, '4000003'), iosSync(tokenB, '4000003')]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await TenantSubscription.count({ where: { externalOriginalTransactionId: '4000003' } })).toBe(1);
  });

  test('a notification for a transaction no row owns yet is applied to the tenant its appAccountToken names', async () => {
    const tx = fakes.appleTransaction({ originalTransactionId: '4000004', productId: plan5.iosMonthlyProductId, appAccountToken: tenantA.id });
    fakes.installAppleFakes({ 4000004: tx });

    await request(app).post('/api/v1/billing/webhooks/apple')
      .send(fakes.appleNotificationBody({ notificationUUID: 'uuid-bound', notificationType: 'SUBSCRIBED', transaction: tx }));

    const row = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: '4000004' } });
    expect(row).not.toBeNull();
    expect(row.tenantId).toBe(tenantA.id);
    expect((await BillingEvent.findOne({ where: { providerEventId: 'uuid-bound' } })).status).toBe('PROCESSED');
  });

  test('a token that names no GymsEra tenant is never trusted', async () => {
    const tx = fakes.appleTransaction({
      originalTransactionId: '4000005',
      productId: plan5.iosMonthlyProductId,
      appAccountToken: '99999999-9999-4999-8999-999999999999',
    });
    fakes.installAppleFakes({ 4000005: tx });

    await request(app).post('/api/v1/billing/webhooks/apple')
      .send(fakes.appleNotificationBody({ notificationUUID: 'uuid-stranger', transaction: tx }));
    expect(await TenantSubscription.count()).toBe(0);
    expect((await BillingEvent.findOne({ where: { providerEventId: 'uuid-stranger' } })).status).toBe('IGNORED');
  });
});
