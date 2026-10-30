/**
 * P7c item 3 (NEW-172, P1; owner decision R-82).
 *
 * The daily expiry pass marks any ACTIVE row past its end date EXPIRED, store rows included
 * (subscription-expiry.cron.js#_processPlatformSubscriptions). When the store re-fetch that
 * runs just before it fails (provider outage), a renewed, paying host's row is expired, and
 * before P7c reconcileStoreSubscriptions never looked at an EXPIRED row again
 * (billing-event.service.js, status list without EXPIRED): only a webhook could repair it.
 *
 * Now the nightly re-check also covers store rows that stopped entitling in the last 7 days.
 */
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
const { City, TenantSubscription } = require('../../src/models/platform');
const appleBilling = require('../../src/services/apple-billing.service');
const billingEvents = require('../../src/services/billing-event.service');
const { runExpiryCheck } = require('../../src/jobs/subscription-expiry.cron');

const DAY = fakes.DAY;

describe('P7c item 3: the nightly re-check covers store rows that expired in the last 7 days', () => {
  let dbHarness;
  let tenant;
  let plan5;

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
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    const listing = await factories.createGymListing(tenant.id);
    await factories.createBranch(dbHarness.tenant1, listing.id);
    plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5 });
  });

  test('a renewal the outage hid is found the next night: EXPIRED → ACTIVE', async () => {
    const { truth, latest } = fakes.installAppleFakes({
      'apple-1': fakes.appleTransaction({ originalTransactionId: 'apple-1', productId: plan5.iosMonthlyProductId }),
    });
    await appleBilling.syncFromApple({ transactionId: 'apple-1', tenantId: tenant.id });
    // The renewal webhook never arrived: the row still holds yesterday's end date.
    const row = await TenantSubscription.findOne({ where: { tenantId: tenant.id } });
    await row.update({ endDate: new Date(Date.now() - 2 * DAY).toISOString().split('T')[0] });

    // Night 1: Apple is down, so the re-fetch fails and the expiry pass expires the row.
    latest.mockRejectedValue(new Error('Apple: 503 Service Unavailable'));
    await runExpiryCheck();
    expect((await row.reload()).status).toBe('EXPIRED');

    // Night 2: Apple answers, the host had renewed.
    latest.mockReset();
    latest.mockImplementation(async () => ({
      ...fakes.appleTransaction({ originalTransactionId: 'apple-1', transactionId: 'apple-1-2', productId: plan5.iosMonthlyProductId }),
      subscriptionStatus: 1,
    }));
    const recon = await billingEvents.reconcileStoreSubscriptions();
    expect(recon.checked).toBe(1);
    expect((await row.reload()).status).toBe('ACTIVE');
    expect(truth).toBeDefined();
  });

  test('a store row that stopped entitling more than 7 days ago is not re-fetched any more', async () => {
    const { latest } = fakes.installAppleFakes({
      'apple-old': fakes.appleTransaction({ originalTransactionId: 'apple-old', productId: plan5.iosMonthlyProductId, expiresInDays: -20 }),
    });
    const row = await factories.createTenantSubscription(tenant.id, {
      platform: 'IOS', status: 'EXPIRED', externalOriginalTransactionId: 'apple-old', branchCount: 5,
    });
    await row.update({ entitlementEndedAt: new Date(Date.now() - 8 * DAY) });
    latest.mockClear();
    const recon = await billingEvents.reconcileStoreSubscriptions();
    expect(recon.checked).toBe(0);
    expect(latest).not.toHaveBeenCalled();
  });

  test('a MANUAL row is never re-fetched from a store', async () => {
    await factories.createTenantSubscription(tenant.id, { platform: 'MANUAL', status: 'EXPIRED' });
    const recon = await billingEvents.reconcileStoreSubscriptions();
    expect(recon.checked).toBe(0);
  });
});
