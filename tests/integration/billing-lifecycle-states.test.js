/**
 * BILL-04 — grace, hold and pause states (spec §7.3, §7.4, §12.1).
 *
 * State-transition table: for every provider state we can receive, the row's
 * status and the tenant's entitlement (resolveMaxBranches, through
 * getActiveSubscription and reconcileCapacity) must be:
 *
 *   ACTIVE, GRACE           → entitled (GRACE also carries the provider's own
 *                              "fix your payment" link in the API)
 *   ON_HOLD, PAUSED         → not entitled (0 — never the legacy fallback)
 *   recovery                → entitled again
 *   auto-renew off          → still entitled until the period ends (§7.4)
 *
 * All provider calls are faked (tests/harness/billing-fakes.js).
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
const { City, Tenant, TenantSubscription, GymListing, PlatformPackage } = require('../../src/models/platform');
const quota = require('../../src/services/subscription-quota.service');
const googlePlayBilling = require('../../src/services/google-play-billing.service');
const appleBilling = require('../../src/services/apple-billing.service');

describe('BILL-04: grace, hold and pause states', () => {
  let dbHarness;
  let tenant;
  let listing;
  let plan5;
  let token;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    delete process.env.GOOGLE_PLAY_PACKAGE_NAME;
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.gymsera.test';
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    // A registration package the legacy fallback would hand back: a held or
    // paused plan must not fall through to it.
    const legacyPackage = await PlatformPackage.create({
      name: 'Legacy 10', price: 1000, billingCycle: 'MONTHLY', maxBranches: 10, maxOrganizations: 3,
      maxTrainers: 10, maxMembers: 1000,
    });
    tenant = await factories.createTenant({
      connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr,
      selectedPackageId: legacyPackage.id,
    });
    listing = await factories.createGymListing(tenant.id, { reservedSlots: 3 });
    await factories.createBranch(dbHarness.tenant1, listing.id);
    await factories.createBranch(dbHarness.tenant1, listing.id);
    plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5, stripeMonthlyPriceId: 'price_5m' });
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
  });

  const maxBranches = async () => {
    const t = await Tenant.findByPk(tenant.id);
    return quota.resolveMaxBranches(t, await quota.getActiveSubscription(tenant.id));
  };
  const rowFor = (externalId) => TenantSubscription.findOne({ where: { externalOriginalTransactionId: externalId } });
  const reservedSlots = async () => (await GymListing.findByPk(listing.id)).reservedSlots;
  const current = () => request(app).get('/api/v1/host/subscription/current').set('Authorization', `Bearer ${token}`);

  describe('Google Play', () => {
    let truth;
    const rtdn = (messageId, purchaseToken, notificationType) =>
      request(app)
        .post('/api/v1/billing/webhooks/google').set('Authorization', fakes.rtdnAuthHeader())
        .send(fakes.rtdnBody({
          messageId,
          notification: { subscriptionNotification: { notificationType, purchaseToken, subscriptionId: plan5.androidProductId } },
        }));

    beforeEach(async () => {
      ({ truth } = fakes.installGoogleFakes({ tok: fakes.googlePurchase({ productId: plan5.androidProductId }) }));
      const res = await request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`)
        .send({ purchaseToken: 'tok' });
      expect(res.status).toBe(200);
      expect(await maxBranches()).toBe(5);
    });

    test('IN_GRACE_PERIOD → GRACE: still entitled, and the API returns the Play "manage subscription" link', async () => {
      truth.tok = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' });
      await rtdn('g-grace', 'tok', 6); // SUBSCRIPTION_IN_GRACE_PERIOD
      expect((await rowFor('tok')).status).toBe('GRACE');
      expect(await maxBranches()).toBe(5);
      expect(await reservedSlots()).toBe(3);

      const res = await current();
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('GRACE');
      expect(res.body.data.paymentIssue).toEqual({
        provider: 'ANDROID',
        manageUrl: `https://play.google.com/store/account/subscriptions?sku=${plan5.androidProductId}&package=com.gymsera.test`,
      });
    });

    test('ON_HOLD → not entitled (0, not the legacy package); slots trimmed; recovery → entitled again', async () => {
      truth.tok = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_ON_HOLD', expiresInDays: -1 });
      await rtdn('g-hold', 'tok', 5); // SUBSCRIPTION_ON_HOLD
      expect((await rowFor('tok')).status).toBe('ON_HOLD');
      expect(await maxBranches()).toBe(0);
      expect(await reservedSlots()).toBe(0);
      expect((await current()).status).toBe(404);

      truth.tok = fakes.googlePurchase({
        productId: plan5.androidProductId, latestOrderId: 'GPA.0000-0000-0000-00001..1',
      });
      await rtdn('g-recovered', 'tok', 1); // SUBSCRIPTION_RECOVERED
      expect((await rowFor('tok')).status).toBe('ACTIVE');
      expect(await maxBranches()).toBe(5);
    });

    test('PAUSED → not entitled; resumed → entitled', async () => {
      truth.tok = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_PAUSED' });
      await rtdn('g-paused', 'tok', 10); // SUBSCRIPTION_PAUSED
      expect((await rowFor('tok')).status).toBe('PAUSED');
      expect(await maxBranches()).toBe(0);

      truth.tok = fakes.googlePurchase({ productId: plan5.androidProductId, latestOrderId: 'GPA.0000-0000-0000-00001..2' });
      await rtdn('g-resumed', 'tok', 1);
      expect((await rowFor('tok')).status).toBe('ACTIVE');
      expect(await maxBranches()).toBe(5);
    });

    test('CANCELED (auto-renew turned off, still paid) → stays entitled until the period ends, autoRenew=false', async () => {
      const cancelled = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_CANCELED' });
      cancelled.lineItems[0].autoRenewingPlan.autoRenewEnabled = false;
      truth.tok = cancelled;
      await rtdn('g-cancel', 'tok', 3); // SUBSCRIPTION_CANCELED
      const row = await rowFor('tok');
      expect(row.status).toBe('ACTIVE');
      expect(row.autoRenew).toBe(false);
      expect(await maxBranches()).toBe(5);
    });

    test('CANCELED after the period ended → EXPIRED', async () => {
      truth.tok = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_CANCELED', expiresInDays: -1 });
      await rtdn('g-cancel-late', 'tok', 3);
      expect((await rowFor('tok')).status).toBe('EXPIRED');
    });

    test('an unknown subscription state is never treated as ACTIVE — the event fails and nothing changes', async () => {
      truth.tok = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_SOMETHING_NEW' });
      await expect(googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok', tenantId: tenant.id })).rejects.toThrow(/state/);
      expect((await rowFor('tok')).status).toBe('ACTIVE');
    });

    test('a first-seen purchase that is already on hold is recorded as ON_HOLD, never created ACTIVE', async () => {
      truth.tok2 = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_ON_HOLD', expiresInDays: -1 });
      await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok2', tenantId: tenant.id });
      expect((await rowFor('tok2')).status).toBe('ON_HOLD');
      // The tenant's real entitlement (the first purchase) is untouched.
      expect((await rowFor('tok')).status).toBe('ACTIVE');
      expect(await maxBranches()).toBe(5);
    });
  });

  describe('Apple', () => {
    let truth;
    const notify = (uuid, notificationType, subtype) =>
      request(app).post('/api/v1/billing/webhooks/apple')
        .send(fakes.appleNotificationBody({ notificationUUID: uuid, notificationType, subtype, transaction: truth['4000001'] }));

    beforeEach(async () => {
      ({ truth } = fakes.installAppleFakes({
        4000001: fakes.appleTransaction({ originalTransactionId: '4000001', productId: plan5.iosMonthlyProductId }),
      }));
      await request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId: '4000001' });
      expect(await maxBranches()).toBe(5);
    });

    test('billing grace period (status 4) → GRACE, entitled, Apple "manage subscriptions" link', async () => {
      truth['4000001'] = { ...truth['4000001'], subscriptionStatus: 4 };
      await notify('a-grace', 'DID_FAIL_TO_RENEW', 'GRACE_PERIOD');
      expect((await rowFor('4000001')).status).toBe('GRACE');
      expect(await maxBranches()).toBe(5);
      const res = await current();
      expect(res.body.data.paymentIssue).toEqual({ provider: 'IOS', manageUrl: 'https://apps.apple.com/account/subscriptions' });
    });

    test('billing retry without grace (status 3) → ON_HOLD, not entitled; renewal → ACTIVE', async () => {
      truth['4000001'] = { ...truth['4000001'], subscriptionStatus: 3 };
      await notify('a-retry', 'DID_FAIL_TO_RENEW');
      expect((await rowFor('4000001')).status).toBe('ON_HOLD');
      expect(await maxBranches()).toBe(0);

      truth['4000001'] = { ...fakes.appleTransaction({ originalTransactionId: '4000001', transactionId: '4000001-2', productId: plan5.iosMonthlyProductId }), subscriptionStatus: 1 };
      await notify('a-renew', 'DID_RENEW', 'BILLING_RECOVERY');
      expect((await rowFor('4000001')).status).toBe('ACTIVE');
      expect(await maxBranches()).toBe(5);
    });

    test('auto-renew turned off (renewalInfo.autoRenewStatus 0) → still ACTIVE, autoRenew=false', async () => {
      truth['4000001'] = { ...truth['4000001'], subscriptionStatus: 1, renewalInfo: { autoRenewStatus: 0, autoRenewProductId: plan5.iosMonthlyProductId } };
      await notify('a-autorenew-off', 'DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED');
      const row = await rowFor('4000001');
      expect(row.status).toBe('ACTIVE');
      expect(row.autoRenew).toBe(false);
    });

    test('Apple status lookup returns the subscription status and renewal info with the transaction', async () => {
      jest.restoreAllMocks();
      const axios = require('axios');
      const tx = fakes.appleTransaction({ originalTransactionId: '4000009', productId: plan5.iosMonthlyProductId });
      jest.spyOn(appleBilling.appleApi, 'getTransactionInfo').mockResolvedValue(tx);
      jest.spyOn(appleBilling.appleApi, 'verifyAndDecode').mockImplementation((jws) => JSON.parse(jws));
      jest.spyOn(axios, 'get').mockResolvedValue({
        data: { data: [{ lastTransactions: [{
          originalTransactionId: '4000009', status: 4,
          signedTransactionInfo: JSON.stringify(tx),
          signedRenewalInfo: JSON.stringify({ autoRenewStatus: 1, autoRenewProductId: plan5.iosMonthlyProductId }),
        }] }] },
      });
      // Throwaway key generated for this run only — never a real Apple key.
      const { privateKey } = require('crypto').generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const keyPath = require('path').join(require('os').tmpdir(), `gymsera-test-apple-${process.pid}.p8`);
      require('fs').writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      process.env.APPLE_IAP_KEY_ID = 'k'; process.env.APPLE_IAP_ISSUER_ID = 'i'; process.env.APPLE_IAP_BUNDLE_ID = 'b';
      process.env.APPLE_IAP_PRIVATE_KEY_PATH = keyPath;
      try {
        const latest = await appleBilling.appleApi.getLatestTransaction('4000009');
        expect(latest.subscriptionStatus).toBe(4);
        expect(latest.renewalInfo).toEqual({ autoRenewStatus: 1, autoRenewProductId: plan5.iosMonthlyProductId });
      } finally {
        for (const k of ['APPLE_IAP_KEY_ID', 'APPLE_IAP_ISSUER_ID', 'APPLE_IAP_BUNDLE_ID', 'APPLE_IAP_PRIVATE_KEY_PATH']) process.env[k] = '';
        require('fs').rmSync(keyPath, { force: true });
      }
    });
  });

  describe('Stripe', () => {
    let truth;
    const updated = (id) =>
      request(app).post('/api/v1/billing/webhooks/stripe')
        .send({ id, type: 'customer.subscription.updated', data: { object: { id: 'sub_s' } } });

    beforeEach(async () => {
      ({ truth } = fakes.installStripeFakes({
        subscriptions: { sub_s: fakes.stripeSubscription({ id: 'sub_s', priceId: 'price_5m', tenantId: tenant.id }) },
      }));
      await updated('evt_s_start');
      expect(await maxBranches()).toBe(5);
    });

    test('past_due → GRACE, entitled, link to our Stripe billing-portal endpoint (never a raw URL)', async () => {
      truth.subscriptions.sub_s = { ...truth.subscriptions.sub_s, status: 'past_due' };
      await updated('evt_s_pastdue');
      expect((await rowFor('sub_s')).status).toBe('GRACE');
      expect(await maxBranches()).toBe(5);
      const res = await current();
      expect(res.body.data.paymentIssue).toEqual({ provider: 'STRIPE', manageUrl: null, portalSessionPath: '/api/v1/billing/stripe/portal-session' });
    });

    test('unpaid → ON_HOLD (not entitled); paused → PAUSED (not entitled)', async () => {
      truth.subscriptions.sub_s = { ...truth.subscriptions.sub_s, status: 'unpaid' };
      await updated('evt_s_unpaid');
      expect((await rowFor('sub_s')).status).toBe('ON_HOLD');
      expect(await maxBranches()).toBe(0);

      truth.subscriptions.sub_s = { ...truth.subscriptions.sub_s, status: 'paused' };
      await updated('evt_s_paused');
      expect((await rowFor('sub_s')).status).toBe('PAUSED');
      expect(await maxBranches()).toBe(0);
    });

    test('incomplete (first payment not done) grants nothing and writes no row', async () => {
      truth.subscriptions.sub_new = fakes.stripeSubscription({ id: 'sub_new', priceId: 'price_5m', tenantId: tenant.id, status: 'incomplete' });
      await request(app).post('/api/v1/billing/webhooks/stripe')
        .send({ id: 'evt_incomplete', type: 'customer.subscription.created', data: { object: { id: 'sub_new' } } });
      expect(await rowFor('sub_new')).toBeNull();
      expect((await rowFor('sub_s')).status).toBe('ACTIVE');
    });
  });

  test('a GRACE row is the tenant\'s one entitling row: a new purchase supersedes it (never two entitling rows)', async () => {
    const { truth } = fakes.installGoogleFakes({ 'tok-a': fakes.googlePurchase({ productId: plan5.androidProductId }) });
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-a', tenantId: tenant.id });
    truth['tok-a'] = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' });
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-a', tenantId: tenant.id });
    expect((await rowFor('tok-a')).status).toBe('GRACE');

    truth['tok-b'] = fakes.googlePurchase({ productId: plan5.androidProductId, latestOrderId: 'GPA.9' });
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-b', tenantId: tenant.id });
    expect((await rowFor('tok-b')).status).toBe('ACTIVE');
    expect((await rowFor('tok-a')).status).toBe('PENDING_CANCEL');
    expect(await TenantSubscription.count({ where: { tenantId: tenant.id, status: ['ACTIVE', 'GRACE'] } })).toBe(1);

    // The superseded one recovering at Google does not become a second entitling row.
    truth['tok-a'] = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', latestOrderId: 'GPA.10' });
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-a', tenantId: tenant.id });
    expect((await rowFor('tok-a')).status).toBe('PENDING_CANCEL');
  });
});
