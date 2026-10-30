/**
 * P7c item 6 (NEW-175, P2; owner decision R-82).
 *
 * Apple sends REFUND_REVERSED when it reverses a refund it granted: the transaction
 * no longer carries a revocationDate. Before P7c the BILL-02 guard in
 * subscription-migration.service.js (a REVOKED row only entitles again for a newer
 * paid period) kept the row REVOKED, because Stripe and Play can hide a refund from
 * the subscription object. Apple cannot: it reports the revocation on the
 * transaction itself, so its absence is the truth and the same period entitles again.
 *
 * The guard still holds for Google (a voided purchase re-synced with the same period).
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { City, Tenant, TenantSubscription } = require('../../src/models/platform');
const quota = require('../../src/services/subscription-quota.service');
const googlePlayBilling = require('../../src/services/google-play-billing.service');

let app;
beforeAll(async () => {
  app = await startTestServer();
});

describe('P7c item 6: an Apple refund reversal makes the same period entitled again', () => {
  let dbHarness;
  let tenant;
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
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    const listing = await factories.createGymListing(tenant.id);
    await factories.createBranch(dbHarness.tenant1, listing.id);
    plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5 });
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
  });

  const maxBranches = async () => {
    const t = await Tenant.findByPk(tenant.id);
    return quota.resolveMaxBranches(t, await quota.getActiveSubscription(tenant.id));
  };
  const row = (externalId) => TenantSubscription.findOne({ where: { externalOriginalTransactionId: externalId } });
  const notify = (uuid, type, transaction) =>
    request(app).post('/api/v1/billing/webhooks/apple').send(fakes.appleNotificationBody({ notificationUUID: uuid, notificationType: type, transaction }));

  test('REFUND → REVOKED (0 branches); REFUND_REVERSED → ACTIVE for the same period (5 branches)', async () => {
    const tx = fakes.appleTransaction({ originalTransactionId: '6000001', productId: plan5.iosMonthlyProductId });
    const { truth } = fakes.installAppleFakes({ 6000001: tx });
    await request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId: '6000001' });
    const paidUntil = (await row('6000001')).endDate;

    truth['6000001'] = { ...tx, revocationDate: Date.now(), revocationReason: 0 };
    await notify('uuid-refund', 'REFUND', truth['6000001']);
    expect((await row('6000001')).status).toBe('REVOKED');
    expect(await maxBranches()).toBe(0);

    truth['6000001'] = { ...tx }; // Apple removed the revocation
    await notify('uuid-reversed', 'REFUND_REVERSED', truth['6000001']);
    const after = await row('6000001');
    expect(after.status).toBe('ACTIVE');
    expect(after.endDate).toBe(paidUntil);
    expect(await maxBranches()).toBe(5);
  });

  test('the BILL-02 guard still holds for Google: a voided purchase re-synced with the same period stays REVOKED', async () => {
    fakes.installGoogleFakes({ 'tok-void': fakes.googlePurchase({ productId: plan5.androidProductId }) });
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-void', tenantId: tenant.id });
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-void', tenantId: tenant.id, revoked: true });
    expect((await row('tok-void')).status).toBe('REVOKED');
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-void', tenantId: tenant.id });
    expect((await row('tok-void')).status).toBe('REVOKED');
  });
});
