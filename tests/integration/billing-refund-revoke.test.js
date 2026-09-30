/**
 * BILL-02 — Refunds and revocations must end entitlement (spec §7.5.7, §12.1).
 *
 * One fixture per provider: refund/revoke event → row REVOKED → maxBranches
 * drops to 0 → reconcileCapacity trims the tenant's unbuilt reserved slots →
 * a second copy of the same event changes nothing.
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
const { City, Tenant, TenantSubscription, CapacityEvent, GymListing, BillingEvent } = require('../../src/models/platform');
const quota = require('../../src/services/subscription-quota.service');
const billingEvents = require('../../src/services/billing-event.service');
const googlePlayBilling = require('../../src/services/google-play-billing.service');
const stripeBilling = require('../../src/services/stripe-billing.service');

describe('BILL-02: refunds and revocations end entitlement', () => {
  let dbHarness;
  let tenant;
  let listing;
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
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    // A tenant whose registration picked a legacy package: that fallback
    // must not hand entitlement back after a refund.
    const legacyPackage = await require('../../src/models/platform').PlatformPackage.create({
      name: 'Legacy 10', price: 1000, billingCycle: 'MONTHLY', maxBranches: 10, maxOrganizations: 3,
      maxTrainers: 10, maxMembers: 1000,
    });
    tenant = await factories.createTenant({
      connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr,
      selectedPackageId: legacyPackage.id,
    });
    listing = await factories.createGymListing(tenant.id, { reservedSlots: 3 });
    // 2 real branches + 3 reserved slots = the full 5-branch plan.
    await factories.createBranch(dbHarness.tenant1, listing.id);
    await factories.createBranch(dbHarness.tenant1, listing.id);
    plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5, stripeMonthlyPriceId: 'price_5m' });
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
  });

  const maxBranches = async () => {
    const t = await Tenant.findByPk(tenant.id);
    return quota.resolveMaxBranches(t, await quota.getActiveSubscription(tenant.id));
  };
  const reservedSlots = async () => (await GymListing.findByPk(listing.id)).reservedSlots;
  const snapshot = async () => ({
    rows: (await TenantSubscription.findAll({ order: [['createdAt', 'ASC']] })).map((r) => `${r.id}:${r.status}`),
    capacityEvents: await CapacityEvent.count(),
    reserved: await reservedSlots(),
  });

  const expectRevoked = async (externalId) => {
    const row = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: externalId } });
    expect(row.status).toBe('REVOKED');
    expect(await maxBranches()).toBe(0);
    expect(await reservedSlots()).toBe(0);
    const trims = await CapacityEvent.count({ where: { tenantId: tenant.id, action: 'SLOT_TRIMMED_DOWNGRADE' } });
    expect(trims).toBeGreaterThan(0);
  };

  test('Apple REFUND: Apple now reports revocationDate → REVOKED, entitlement 0, slots trimmed; a replay changes nothing', async () => {
    const tx = fakes.appleTransaction({ originalTransactionId: '3000001', productId: plan5.iosMonthlyProductId });
    const { truth } = fakes.installAppleFakes({ 3000001: tx });
    await request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId: '3000001' });
    expect(await maxBranches()).toBe(5);

    truth['3000001'] = { ...tx, revocationDate: Date.now(), revocationReason: 0 };
    const body = fakes.appleNotificationBody({ notificationUUID: 'uuid-refund', notificationType: 'REFUND', transaction: truth['3000001'] });
    await request(app).post('/api/v1/billing/webhooks/apple').send(body);
    await expectRevoked('3000001');

    const before = await snapshot();
    await request(app).post('/api/v1/billing/webhooks/apple').send(body);
    expect(await snapshot()).toEqual(before);
  });

  test('Google SUBSCRIPTION_REVOKED: Play now reports the subscription expired → REVOKED, entitlement 0; a replay changes nothing', async () => {
    const { truth } = fakes.installGoogleFakes({ 'tok-rev': fakes.googlePurchase({ productId: plan5.androidProductId }) });
    await request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`)
      .send({ purchaseToken: 'tok-rev', productId: plan5.androidProductId });
    expect(await maxBranches()).toBe(5);

    truth['tok-rev'] = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_EXPIRED', expiresInDays: 0 });
    const body = fakes.rtdnBody({
      messageId: 'pubsub-revoked',
      notification: { subscriptionNotification: { notificationType: 12, purchaseToken: 'tok-rev', subscriptionId: plan5.androidProductId } },
    });
    await request(app).post('/api/v1/billing/webhooks/google').set('Authorization', fakes.rtdnAuthHeader()).send(body);
    await expectRevoked('tok-rev');

    const before = await snapshot();
    await request(app).post('/api/v1/billing/webhooks/google').set('Authorization', fakes.rtdnAuthHeader()).send(body);
    expect(await snapshot()).toEqual(before);
  });

  test('Google voided purchase (refund without revoke): REVOKED even though Play still reports it active', async () => {
    fakes.installGoogleFakes({ 'tok-void': fakes.googlePurchase({ productId: plan5.androidProductId }) });
    await request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`)
      .send({ purchaseToken: 'tok-void', productId: plan5.androidProductId });

    const body = fakes.rtdnBody({
      messageId: 'pubsub-voided',
      notification: { voidedPurchaseNotification: { purchaseToken: 'tok-void', orderId: 'GPA.1', productType: 1, refundType: 1 } },
    });
    await request(app).post('/api/v1/billing/webhooks/google').set('Authorization', fakes.rtdnAuthHeader()).send(body);
    await expectRevoked('tok-void');

    // A later resync of the same (unchanged) period must not resurrect it.
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-void', tenantId: tenant.id });
    expect((await TenantSubscription.findOne({ where: { externalOriginalTransactionId: 'tok-void' } })).status).toBe('REVOKED');
  });

  test('Google Voided Purchases API in the daily sweep revokes a refund whose notification never arrived', async () => {
    fakes.installGoogleFakes({ 'tok-sweep': fakes.googlePurchase({ productId: plan5.androidProductId }) });
    await request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`)
      .send({ purchaseToken: 'tok-sweep', productId: plan5.androidProductId });
    jest.spyOn(googlePlayBilling.playApi, 'listVoidedPurchases').mockResolvedValue([
      { purchaseToken: 'tok-sweep', orderId: 'GPA.2', voidedTimeMillis: String(Date.now()), voidedReason: 1, kind: 'androidpublisher#voidedPurchase' },
    ]);

    await billingEvents.sweepGoogleVoidedPurchases();
    await expectRevoked('tok-sweep');

    // The sweep runs over overlapping windows; the same voided order is one event.
    await billingEvents.sweepGoogleVoidedPurchases();
    expect(await BillingEvent.count({ where: { provider: 'GOOGLE', providerEventId: 'voided:GPA.2' } })).toBe(1);
  });

  describe('Stripe', () => {
    let retrieveCharge;

    beforeEach(async () => {
      const live = fakes.stripeSubscription({ id: 'sub_r', priceId: 'price_5m', tenantId: tenant.id });
      fakes.installStripeFakes({ subscriptions: { sub_r: live } });
      await request(app).post('/api/v1/billing/webhooks/stripe')
        .send({ id: 'evt_start', type: 'customer.subscription.created', data: { object: live } });
      expect(await maxBranches()).toBe(5);
      retrieveCharge = jest.spyOn(stripeBilling.stripeApi, 'retrieveCharge');
      jest.spyOn(stripeBilling.stripeApi, 'subscriptionIdForCharge').mockResolvedValue('sub_r');
    });

    test('charge.refunded (full refund, confirmed by re-fetching the charge) → REVOKED; replay changes nothing', async () => {
      retrieveCharge.mockResolvedValue({ id: 'ch_1', refunded: true, disputed: false });
      const event = { id: 'evt_refund', type: 'charge.refunded', data: { object: { id: 'ch_1', refunded: true } } };
      await request(app).post('/api/v1/billing/webhooks/stripe').send(event);
      await expectRevoked('sub_r');

      const before = await snapshot();
      await request(app).post('/api/v1/billing/webhooks/stripe').send(event);
      expect(await snapshot()).toEqual(before);

      // Stripe still reports the subscription active for the same period: no resurrection.
      await request(app).post('/api/v1/billing/webhooks/stripe')
        .send({ id: 'evt_update_after', type: 'customer.subscription.updated', data: { object: { id: 'sub_r' } } });
      expect((await TenantSubscription.findOne({ where: { externalOriginalTransactionId: 'sub_r' } })).status).toBe('REVOKED');
    });

    test('a partial refund does not revoke', async () => {
      retrieveCharge.mockResolvedValue({ id: 'ch_2', refunded: false, amount_refunded: 100, disputed: false });
      await request(app).post('/api/v1/billing/webhooks/stripe')
        .send({ id: 'evt_partial', type: 'charge.refunded', data: { object: { id: 'ch_2' } } });
      expect(await maxBranches()).toBe(5);
    });

    test('charge.dispute.created → REVOKED', async () => {
      retrieveCharge.mockResolvedValue({ id: 'ch_3', refunded: false, disputed: true });
      await request(app).post('/api/v1/billing/webhooks/stripe')
        .send({ id: 'evt_dispute', type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: 'ch_3' } } });
      await expectRevoked('sub_r');
    });
  });
});
