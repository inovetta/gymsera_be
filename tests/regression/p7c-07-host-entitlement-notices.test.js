/**
 * P7c item 7 (NEW-176, P2; owner decision R-82, spec §7.6 "notify host if entitlement changed").
 *
 * Before P7c nothing told the host when a provider put the plan on hold, refunded it or
 * applied a downgrade, and the daily expiry sent the "expires in 2 days" warning template
 * again on the day the plan expired (subscription-expiry.cron.js, sendTenantSubscriptionWarningEmail).
 *
 * Now the owner gets one push (in-app notification, role host) and one email per change:
 * on hold, refunded, downgraded, expired; expiry has its own email template. A replay of
 * the same provider state sends nothing again.
 */
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
const { City, User } = require('../../src/models/platform');
const appleBilling = require('../../src/services/apple-billing.service');
const googlePlayBilling = require('../../src/services/google-play-billing.service');
const notificationsService = require('../../src/services/notifications.service');
const emailService = require('../../src/services/email.service');
const { runExpiryCheck } = require('../../src/jobs/subscription-expiry.cron');

describe('P7c item 7: the host is told when entitlement changes', () => {
  let dbHarness;
  let tenant;
  let owner;
  let plan2;
  let plan5;
  let push;
  let changedEmail;
  let expiredEmail;
  let warningEmail;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    owner = await User.findByPk(tenant.ownerUserId);
    const listing = await factories.createGymListing(tenant.id);
    await factories.createBranch(dbHarness.tenant1, listing.id);
    plan2 = await factories.createBillingPlan({ branchCount: 2, sortOrder: 2 });
    plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5 });
    push = jest.spyOn(notificationsService, 'createNotification').mockResolvedValue({});
    changedEmail = jest.spyOn(emailService, 'sendTenantPlanChangedEmail').mockResolvedValue(undefined);
    expiredEmail = jest.spyOn(emailService, 'sendTenantSubscriptionExpiredEmail').mockResolvedValue(undefined);
    warningEmail = jest.spyOn(emailService, 'sendTenantSubscriptionWarningEmail').mockResolvedValue(undefined);
  });

  const pushes = (event) =>
    push.mock.calls.filter(([n]) => n.metadataJson?.event === event && n.userId === owner.id && n.role === 'host');

  const expectOne = (kind) => {
    expect(pushes(`host_plan_${kind}`)).toHaveLength(1);
    const [n] = pushes(`host_plan_${kind}`)[0];
    expect(n.deepLink).toBe('/host/subscriptions');
    if (kind === 'expired') {
      expect(expiredEmail).toHaveBeenCalledTimes(1);
      expect(expiredEmail.mock.calls[0][0]).toBe(owner.email);
    } else {
      expect(changedEmail).toHaveBeenCalledTimes(1);
      expect(changedEmail).toHaveBeenCalledWith(owner.email, owner.fullName, expect.objectContaining({ kind }));
    }
  };

  test('Google on hold → one "on hold" push and email; the same state again sends nothing', async () => {
    const { truth } = fakes.installGoogleFakes({ tok: fakes.googlePurchase({ productId: plan5.androidProductId }) });
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok', tenantId: tenant.id });
    expect(push).not.toHaveBeenCalled();

    truth.tok = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_ON_HOLD', expiresInDays: -1 });
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok', tenantId: tenant.id });
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok', tenantId: tenant.id });
    expectOne('on_hold');
  });

  test('Apple refund → one "refunded" push and email', async () => {
    const tx = fakes.appleTransaction({ originalTransactionId: 'a-1', productId: plan5.iosMonthlyProductId });
    const { truth } = fakes.installAppleFakes({ 'a-1': tx });
    await appleBilling.syncFromApple({ transactionId: 'a-1', tenantId: tenant.id });
    truth['a-1'] = { ...tx, revocationDate: Date.now() };
    await appleBilling.syncFromApple({ transactionId: 'a-1', tenantId: tenant.id });
    expectOne('refunded');
  });

  test('Apple applies a downgrade (5 → 2 branches) → one "downgraded" push and email', async () => {
    const tx = fakes.appleTransaction({ originalTransactionId: 'a-2', productId: plan5.iosMonthlyProductId });
    const { truth } = fakes.installAppleFakes({ 'a-2': tx });
    await appleBilling.syncFromApple({ transactionId: 'a-2', tenantId: tenant.id });
    truth['a-2'] = fakes.appleTransaction({ originalTransactionId: 'a-2', transactionId: 'a-2-2', productId: plan2.iosMonthlyProductId });
    await appleBilling.syncFromApple({ transactionId: 'a-2', tenantId: tenant.id });
    expectOne('downgraded');
    expect(changedEmail).toHaveBeenCalledWith(owner.email, owner.fullName, expect.objectContaining({ branchCount: 2 }));
  });

  test('Apple reports expired → one "expired" push and the expired template', async () => {
    const tx = fakes.appleTransaction({ originalTransactionId: 'a-3', productId: plan5.iosMonthlyProductId });
    const { truth } = fakes.installAppleFakes({ 'a-3': tx });
    await appleBilling.syncFromApple({ transactionId: 'a-3', tenantId: tenant.id });
    truth['a-3'] = { ...fakes.appleTransaction({ originalTransactionId: 'a-3', productId: plan5.iosMonthlyProductId, expiresInDays: -1 }), subscriptionStatus: 2 };
    await appleBilling.syncFromApple({ transactionId: 'a-3', tenantId: tenant.id });
    expectOne('expired');
  });

  test('the daily expiry of a MANUAL plan uses the expired template, not the "expires in 2 days" warning', async () => {
    await factories.createTenantSubscription(tenant.id, {
      platform: 'MANUAL', status: 'ACTIVE', branchCount: 5,
      startDate: new Date(Date.now() - 40 * fakes.DAY), endDate: new Date(Date.now() - 2 * fakes.DAY),
    });
    await runExpiryCheck();
    expectOne('expired');
    expect(warningEmail).not.toHaveBeenCalled();
  });
});
