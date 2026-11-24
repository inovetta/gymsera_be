/**
 * NEW-277 — an Apple transaction is used only when it was made in our app.
 *
 * The server sends APPLE_IAP_BUNDLE_ID only as `bid` in its own API token
 * (apple-billing.service.js#_appleApiJwt) and never compared the verified transaction's
 * `bundleId` with it. Now every Apple sync (the app's /sync, notifications, the daily
 * sweep: all go through syncFromApple) refuses a transaction whose bundleId is not ours:
 * 422 store_bundle_mismatch, nothing written.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { City, TenantSubscription } = require('../../src/models/platform');

const OUR_BUNDLE = 'com.inovettatech.gymsera';

let app;
beforeAll(async () => {
  app = await startTestServer();
});

describe('NEW-277: Apple transactions from another app are refused', () => {
  let dbHarness;
  let tenant;
  let token;
  let plan5;
  let savedBundle;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    savedBundle = process.env.APPLE_IAP_BUNDLE_ID;
    process.env.APPLE_IAP_BUNDLE_ID = OUR_BUNDLE;
  });

  afterAll(async () => {
    if (savedBundle === undefined) delete process.env.APPLE_IAP_BUNDLE_ID;
    else process.env.APPLE_IAP_BUNDLE_ID = savedBundle;
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    await factories.createGymListing(tenant.id);
    plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5 });
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, organizationId: tenant.id });
  });

  const iosSync = (transactionId) =>
    request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId });
  const tx = (id, bundleId) =>
    fakes.appleTransaction({ originalTransactionId: id, productId: plan5.iosMonthlyProductId, appAccountToken: tenant.id, bundleId });

  test('a transaction from our app is applied', async () => {
    fakes.installAppleFakes({ 6000001: tx('6000001', OUR_BUNDLE) });
    expect((await iosSync('6000001')).status).toBe(200);
    expect(await TenantSubscription.count()).toBe(1);
  });

  test('a transaction from another app gets 422 store_bundle_mismatch and writes nothing', async () => {
    fakes.installAppleFakes({ 6000002: tx('6000002', 'com.example.otherapp') });
    const res = await iosSync('6000002');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('store_bundle_mismatch');
    expect(await TenantSubscription.count()).toBe(0);
  });

  test('a transaction without a bundleId is not trusted either', async () => {
    fakes.installAppleFakes({ 6000003: tx('6000003', undefined) });
    const res = await iosSync('6000003');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('store_bundle_mismatch');
    expect(await TenantSubscription.count()).toBe(0);
  });
});
