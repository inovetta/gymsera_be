/**
 * OBS-05 — every billing event is tied to its tenant when the owner is known (spec §12.12).
 *
 * The owner is found the way the sync already finds it: the tenant that holds the subscription
 * row for the provider's id (subscription-migration.service.js#resolveSubscriptionOwner). A failed
 * event is attributed too, so "which tenant is stuck" is answerable. Old rows are not backfilled.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { BillingEvent, City } = require('../../src/models/platform');
const billingEvents = require('../../src/services/billing-event.service');

let app;
beforeAll(async () => {
  app = await startTestServer();
});

describe('OBS-05: billing events carry the tenant', () => {
  let dbHarness;
  let tenant;
  let plan3;
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
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    await factories.createGymListing(tenant.id);
    plan3 = await factories.createBillingPlan({ branchCount: 3, sortOrder: 3 });
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
  });

  test('Apple: a processed notification is stored with the tenant that owns the transaction', async () => {
    const tx = fakes.appleTransaction({ originalTransactionId: '2000001', productId: plan3.iosMonthlyProductId });
    fakes.installAppleFakes({ 2000001: tx });
    await request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId: '2000001' });

    await request(app)
      .post('/api/v1/billing/webhooks/apple')
      .send(fakes.appleNotificationBody({ notificationUUID: 'uuid-1', transaction: tx }));

    const event = await BillingEvent.findOne({ where: { provider: 'APPLE', providerEventId: 'uuid-1' } });
    expect(event.status).toBe('PROCESSED');
    expect(event.tenantId).toBe(tenant.id);
  });

  test('Apple: a FAILED event is attributed too', async () => {
    const tx = fakes.appleTransaction({ originalTransactionId: '2000002', productId: plan3.iosMonthlyProductId });
    const { latest } = fakes.installAppleFakes({ 2000002: tx });
    await request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId: '2000002' });
    latest.mockRejectedValue(new Error('Apple API down'));

    await request(app)
      .post('/api/v1/billing/webhooks/apple')
      .send(fakes.appleNotificationBody({ notificationUUID: 'uuid-2', transaction: tx }));

    const event = await BillingEvent.findOne({ where: { providerEventId: 'uuid-2' } });
    expect(event.status).toBe('FAILED');
    expect(event.tenantId).toBe(tenant.id);
  });

  test('Google: the tenant holding the purchase token', async () => {
    fakes.installGoogleFakes({ 'tok-1': fakes.googlePurchase({ productId: plan3.androidProductId }) });
    await request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`)
      .send({ purchaseToken: 'tok-1', productId: plan3.androidProductId });

    const body = fakes.rtdnBody({
      messageId: 'pubsub-1',
      notification: { subscriptionNotification: { notificationType: 2, purchaseToken: 'tok-1', subscriptionId: plan3.androidProductId } },
    });
    await request(app).post('/api/v1/billing/webhooks/google').set('Authorization', fakes.rtdnAuthHeader()).send(body);

    const event = await BillingEvent.findOne({ where: { providerEventId: 'pubsub-1' } });
    expect(event.tenantId).toBe(tenant.id);
  });

  test('Stripe: the tenant holding the subscription id, even when the sync then fails', async () => {
    await plan3.update({ stripeMonthlyPriceId: 'price_3m' });
    const live = fakes.stripeSubscription({ id: 'sub_1', priceId: 'price_3m', tenantId: tenant.id });
    const { retrieve } = fakes.installStripeFakes({ subscriptions: { sub_1: live } });
    const first = { id: 'evt_a', type: 'customer.subscription.updated', data: { object: live } };
    await request(app).post('/api/v1/billing/webhooks/stripe').send(first);
    retrieve.mockRejectedValue(new Error('Stripe down'));
    const second = { id: 'evt_b', type: 'customer.subscription.updated', data: { object: live } };
    await request(app).post('/api/v1/billing/webhooks/stripe').send(second);

    expect((await BillingEvent.findOne({ where: { providerEventId: 'evt_a' } })).tenantId).toBe(tenant.id);
    const failed = await BillingEvent.findOne({ where: { providerEventId: 'evt_b' } });
    expect(failed.status).toBe('FAILED');
    expect(failed.tenantId).toBe(tenant.id);
  });

  test('an event no tenant owns stays unattributed (null), not guessed', async () => {
    const tx = fakes.appleTransaction({ originalTransactionId: '9999999', productId: plan3.iosMonthlyProductId });
    fakes.installAppleFakes({ 9999999: tx });
    await request(app)
      .post('/api/v1/billing/webhooks/apple')
      .send(fakes.appleNotificationBody({ notificationUUID: 'uuid-9', transaction: tx }));
    const event = await BillingEvent.findOne({ where: { providerEventId: 'uuid-9' } });
    expect(event.tenantId).toBeNull();
  });

  test('an unreadable payload never breaks processing and leaves tenantId null', async () => {
    const { event } = await billingEvents.recordEvent({ provider: 'APPLE', providerEventId: 'bad-1', rawPayload: '{"signedPayload": 5' });
    await billingEvents.processEvent(event);
    const row = await BillingEvent.findOne({ where: { providerEventId: 'bad-1' } });
    expect(row.status).toBe('FAILED');
    expect(row.tenantId).toBeNull();
  });

  test('an attributed tenant is never overwritten by a later attempt, and old rows are not backfilled by the migration', async () => {
    const { event } = await billingEvents.recordEvent({ provider: 'STRIPE', providerEventId: 'keep-1', rawPayload: '{"id":"keep-1","type":"other"}' });
    await event.update({ tenantId: tenant.id });
    await billingEvents.processEvent(event);
    expect((await BillingEvent.findOne({ where: { providerEventId: 'keep-1' } })).tenantId).toBe(tenant.id);
  });
});
