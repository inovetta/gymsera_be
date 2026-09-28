/**
 * BILL-12 — Webhook durability and ordering (spec §7.6, §12.1).
 *
 * Proves:
 *  - the same provider event delivered 3× is recorded once and changes state once;
 *  - events delivered out of order converge on the provider's truth, because the
 *    processor re-fetches it instead of trusting the notification payload;
 *  - a processing failure is recorded (FAILED + attempts) and retried by the sweep;
 *  - an event that cannot be recorded answers 500 so the provider redelivers;
 *  - webhooks and the app's /sync end in the same apply function.
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
const { BillingEvent, TenantSubscription } = require('../../src/models/platform');
const billingEvents = require('../../src/services/billing-event.service');
const subscriptionMigrationService = require('../../src/services/subscription-migration.service');

describe('BILL-12: billing webhook inbox', () => {
  let dbHarness;
  let tenant;
  let plan3;
  let plan5;
  let token;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestDatabases();
    await require('../../src/models/platform').City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    await factories.createGymListing(tenant.id);
    plan3 = await factories.createBillingPlan({ branchCount: 3, sortOrder: 3 });
    plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5 });
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
  });

  const activeRows = () => TenantSubscription.findAll({ where: { tenantId: tenant.id, status: 'ACTIVE' } });

  describe('Apple App Store Server Notifications', () => {
    test('the same notification delivered 3× is stored once and applied once', async () => {
      const tx = fakes.appleTransaction({ originalTransactionId: '2000001', productId: plan3.iosMonthlyProductId });
      const { latest } = fakes.installAppleFakes({ 2000001: tx });

      const sync = await request(app)
        .post('/api/v1/billing/ios/sync')
        .set('Authorization', `Bearer ${token}`)
        .send({ transactionId: '2000001' });
      expect(sync.status).toBe(200);
      latest.mockClear();

      const body = fakes.appleNotificationBody({ notificationUUID: 'uuid-renew-1', transaction: tx });
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/api/v1/billing/webhooks/apple').send(body);
        expect(res.status).toBe(200);
      }

      const events = await BillingEvent.findAll({ where: { provider: 'APPLE' } });
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('PROCESSED');
      expect(events[0].attempts).toBe(1);
      expect(latest).toHaveBeenCalledTimes(1);
      expect(await activeRows()).toHaveLength(1);
    });

    test('out-of-order notifications converge on the truth Apple reports now, not on what each payload claims', async () => {
      const original = fakes.appleTransaction({ originalTransactionId: '2000002', productId: plan3.iosMonthlyProductId });
      const { truth } = fakes.installAppleFakes({ 2000002: original });
      await request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId: '2000002' });

      // The host upgraded to 5 branches; Apple now reports the 5-branch transaction.
      const upgraded = fakes.appleTransaction({
        originalTransactionId: '2000002',
        transactionId: '2000002-2',
        productId: plan5.iosMonthlyProductId,
      });
      truth['2000002'] = upgraded;

      // Newer event first, then a stale one whose payload still claims 3 branches.
      await request(app).post('/api/v1/billing/webhooks/apple')
        .send(fakes.appleNotificationBody({ notificationUUID: 'uuid-new', notificationType: 'DID_CHANGE_RENEWAL_PREF', transaction: upgraded }));
      await request(app).post('/api/v1/billing/webhooks/apple')
        .send(fakes.appleNotificationBody({ notificationUUID: 'uuid-old', notificationType: 'SUBSCRIBED', transaction: original }));

      const rows = await activeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].branchCount).toBe(5);
      expect(rows[0].productId).toBe(plan5.iosMonthlyProductId);
    });

    test('a processing failure is recorded and retried by the sweep; the webhook still answers 200', async () => {
      const tx = fakes.appleTransaction({ originalTransactionId: '2000003', productId: plan3.iosMonthlyProductId });
      const { latest } = fakes.installAppleFakes({ 2000003: tx });
      await request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId: '2000003' });

      latest.mockRejectedValueOnce(new Error('App Store Server API timeout'));
      const res = await request(app).post('/api/v1/billing/webhooks/apple')
        .send(fakes.appleNotificationBody({ notificationUUID: 'uuid-fail', transaction: tx }));
      expect(res.status).toBe(200);

      let event = await BillingEvent.findOne({ where: { providerEventId: 'uuid-fail' } });
      expect(event.status).toBe('FAILED');
      expect(event.attempts).toBe(1);
      expect(event.lastError).toContain('timeout');

      await billingEvents.processPendingEvents();
      event = await event.reload();
      expect(event.status).toBe('PROCESSED');
      expect(event.attempts).toBe(2);
    });

    test('if the event cannot be recorded the webhook answers 500 so Apple redelivers', async () => {
      const tx = fakes.appleTransaction({ originalTransactionId: '2000004', productId: plan3.iosMonthlyProductId });
      fakes.installAppleFakes({ 2000004: tx });
      jest.spyOn(BillingEvent, 'create').mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      const res = await request(app).post('/api/v1/billing/webhooks/apple')
        .send(fakes.appleNotificationBody({ notificationUUID: 'uuid-db-down', transaction: tx }));
      expect(res.status).toBe(500);
    });

    test('a payload that fails signature verification is rejected and never stored', async () => {
      fakes.installAppleFakes({});
      const appleBilling = require('../../src/services/apple-billing.service');
      appleBilling.appleApi.verifyAndDecode.mockImplementation(() => { throw new Error('bad chain'); });

      const res = await request(app).post('/api/v1/billing/webhooks/apple').send({ signedPayload: 'forged' });
      expect(res.status).toBe(400);
      expect(await BillingEvent.count()).toBe(0);
    });

    test('a notification for a transaction no tenant owns is stored as IGNORED and creates nothing', async () => {
      const tx = fakes.appleTransaction({ originalTransactionId: '2000005', productId: plan3.iosMonthlyProductId });
      fakes.installAppleFakes({ 2000005: tx });

      await request(app).post('/api/v1/billing/webhooks/apple')
        .send(fakes.appleNotificationBody({ notificationUUID: 'uuid-unknown', transaction: tx }));

      const event = await BillingEvent.findOne({ where: { providerEventId: 'uuid-unknown' } });
      expect(event.status).toBe('IGNORED');
      expect(await TenantSubscription.count()).toBe(0);
    });
  });

  describe('Google Play RTDN', () => {
    test('the same Pub/Sub message delivered 3× is stored once and the purchase is re-fetched once', async () => {
      process.env.GOOGLE_PLAY_RTDN_TOKEN = 'test-rtdn-token';
      const { get } = fakes.installGoogleFakes({ 'tok-1': fakes.googlePurchase({ productId: plan3.androidProductId }) });
      await request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`)
        .send({ purchaseToken: 'tok-1', productId: plan3.androidProductId });
      get.mockClear();

      const body = fakes.rtdnBody({
        messageId: 'pubsub-1',
        notification: { subscriptionNotification: { notificationType: 2, purchaseToken: 'tok-1', subscriptionId: plan3.androidProductId } },
      });
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/api/v1/billing/webhooks/google?token=test-rtdn-token').send(body);
        expect(res.status).toBe(200);
      }

      expect(await BillingEvent.count({ where: { provider: 'GOOGLE' } })).toBe(1);
      expect(get).toHaveBeenCalledTimes(1);
      expect(await activeRows()).toHaveLength(1);
    });
  });

  describe('Stripe webhooks', () => {
    test('a replayed event is a no-op, and state comes from the re-fetched subscription, not the payload', async () => {
      await plan3.update({ stripeMonthlyPriceId: 'price_3m' });
      const live = fakes.stripeSubscription({ id: 'sub_1', priceId: 'price_3m', tenantId: tenant.id });
      const { retrieve } = fakes.installStripeFakes({ subscriptions: { sub_1: live } });

      // The payload's copy is stale ("canceled"); Stripe's API says active.
      const event = {
        id: 'evt_1',
        type: 'customer.subscription.updated',
        data: { object: { ...live, status: 'canceled' } },
      };
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/api/v1/billing/webhooks/stripe').send(event);
        expect(res.status).toBe(200);
      }

      expect(await BillingEvent.count({ where: { provider: 'STRIPE' } })).toBe(1);
      expect(retrieve).toHaveBeenCalledTimes(1);
      const rows = await activeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].platform).toBe('STRIPE');
    });
  });

  test('the app /sync and a webhook both end in the same apply function', async () => {
    const apply = jest.spyOn(subscriptionMigrationService, 'applyVerifiedSubscription');
    const tx = fakes.appleTransaction({ originalTransactionId: '2000006', productId: plan3.iosMonthlyProductId });
    fakes.installAppleFakes({ 2000006: tx });

    await request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId: '2000006' });
    expect(apply).toHaveBeenCalledTimes(1);

    await request(app).post('/api/v1/billing/webhooks/apple')
      .send(fakes.appleNotificationBody({ notificationUUID: 'uuid-same-path', transaction: tx }));
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1][0]).toBe(tenant.id);
  });
});
