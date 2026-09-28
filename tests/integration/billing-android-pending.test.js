/**
 * BILL-08 — pending Android purchases (cash, carrier billing, slow methods;
 * spec §7.5.1, §12.1).
 *
 * While Google reports SUBSCRIPTION_STATE_PENDING nothing is granted, nothing
 * is written, nothing is acknowledged, and the app gets a clear
 * "payment pending" answer (202). Google's later notification resolves it
 * through the existing webhook path: completed → the plan is applied like any
 * purchase; cancelled → nothing.
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

describe('BILL-08: pending Android purchases', () => {
  let dbHarness;
  let tenant;
  let plan5;
  let token;
  let truth;
  let ack;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    process.env.GOOGLE_PLAY_RTDN_TOKEN = 'test-rtdn-token';
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    await factories.createGymListing(tenant.id);
    plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5 });
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
    ({ truth, ack } = fakes.installGoogleFakes({
      'tok-pend': fakes.googlePurchase({
        productId: plan5.androidProductId,
        state: 'SUBSCRIPTION_STATE_PENDING',
        acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
        obfuscatedExternalAccountId: tenant.id,
      }),
    }));
  });

  const sync = () => request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`)
    .send({ purchaseToken: 'tok-pend' });
  const rtdn = (messageId, notificationType) =>
    request(app).post('/api/v1/billing/webhooks/google?token=test-rtdn-token').send(fakes.rtdnBody({
      messageId,
      notification: { subscriptionNotification: { notificationType, purchaseToken: 'tok-pend', subscriptionId: plan5.androidProductId } },
    }));
  const maxBranches = async () => {
    const t = await Tenant.findByPk(tenant.id);
    return quota.resolveMaxBranches(t, await quota.getActiveSubscription(tenant.id));
  };

  test('/sync of a pending purchase: 202 "payment pending", no row, no entitlement, no acknowledge', async () => {
    const res = await sync();
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ state: 'PAYMENT_PENDING', subscription: null });
    expect(await TenantSubscription.count()).toBe(0);
    expect(await quota.getActiveSubscription(tenant.id)).toBeNull();
    expect(ack).not.toHaveBeenCalled();
  });

  test('Google completes it later: the notification applies the plan through the webhook path and acknowledges', async () => {
    await sync();
    // A notification while still pending is recorded and ignored, never applied.
    await rtdn('pend-1', 4);
    expect((await BillingEvent.findOne({ where: { providerEventId: 'pend-1' } })).status).toBe('IGNORED');
    expect(await TenantSubscription.count()).toBe(0);

    truth['tok-pend'] = fakes.googlePurchase({
      productId: plan5.androidProductId,
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      obfuscatedExternalAccountId: tenant.id,
    });
    await rtdn('pend-2', 4); // SUBSCRIPTION_PURCHASED
    const row = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: 'tok-pend' } });
    expect(row).toMatchObject({ status: 'ACTIVE', branchCount: 5, tenantId: tenant.id });
    expect(await maxBranches()).toBe(5);
    expect(ack).toHaveBeenCalledWith('tok-pend', plan5.androidProductId);
  });

  test('the pending payment is cancelled: nothing is ever granted', async () => {
    await sync();
    truth['tok-pend'] = fakes.googlePurchase({
      productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', obfuscatedExternalAccountId: tenant.id,
    });
    await rtdn('pend-cancel', 20); // SUBSCRIPTION_PENDING_PURCHASE_CANCELED
    expect((await BillingEvent.findOne({ where: { providerEventId: 'pend-cancel' } })).status).toBe('IGNORED');
    expect(await TenantSubscription.count()).toBe(0);

    const res = await sync();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ state: 'PAYMENT_CANCELLED', subscription: null });
  });

  test('a pending upgrade leaves the plan the tenant already has untouched', async () => {
    truth['tok-cur'] = fakes.googlePurchase({ productId: plan5.androidProductId, latestOrderId: 'GPA.CUR' });
    await request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`).send({ purchaseToken: 'tok-cur' });
    const plan8 = await factories.createBillingPlan({ branchCount: 8, sortOrder: 8 });
    truth['tok-pend'] = { ...fakes.googlePurchase({ productId: plan8.androidProductId, state: 'SUBSCRIPTION_STATE_PENDING' }), linkedPurchaseToken: 'tok-cur' };

    expect((await sync()).status).toBe(202);
    const current = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: 'tok-cur' } });
    expect(current.status).toBe('ACTIVE');
    expect(await maxBranches()).toBe(5);
    expect(await TenantSubscription.count()).toBe(1);
  });
});
