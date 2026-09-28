/**
 * BILL-05 — the subscriber price mirrors what the provider actually charges
 * (spec §7.2 "Three prices", §7.5.3, §12.1).
 *
 *   - A verified renewal carrying a different provider price (a store price
 *     increase, another country's price, a Stripe price migration) updates
 *     TenantSubscription.amount and .currency.
 *   - A catalog (BillingPlan) price edit never changes a subscriber's amount.
 *   - A renewal where the provider reports no price leaves the amount alone.
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
const { City, TenantSubscription } = require('../../src/models/platform');
const catalog = require('../../src/services/billing-plan-catalog.service');
const appleBilling = require('../../src/services/apple-billing.service');
const googlePlayBilling = require('../../src/services/google-play-billing.service');

describe('BILL-05: subscriber price follows the provider\'s actual charge', () => {
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
    await factories.createGymListing(tenant.id);
    plan5 = await factories.createBillingPlan({
      branchCount: 5, sortOrder: 5, monthlyPrice: 4999, annualPrice: 49999, stripeMonthlyPriceId: 'price_5m',
    });
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
  });

  const rowFor = (externalId) => TenantSubscription.findOne({ where: { externalOriginalTransactionId: externalId } });

  test('Apple: a renewal at a higher store price updates amount and currency; a catalog edit does not', async () => {
    const first = fakes.appleTransaction({
      originalTransactionId: '5000001', productId: plan5.iosMonthlyProductId, price: 4999000, currency: 'PKR',
    });
    const { truth } = fakes.installAppleFakes({ 5000001: first });
    await request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId: '5000001' });
    let row = await rowFor('5000001');
    expect(Number(row.amount)).toBe(4999);
    expect(row.currency).toBe('PKR');

    // Admin edits the catalog: the subscriber's amount must not move.
    await catalog.updatePlan(plan5.id, { monthlyPrice: 3999 });
    await appleBilling.syncFromApple({ transactionId: '5000001', tenantId: tenant.id });
    row = await rowFor('5000001');
    expect(Number(row.amount)).toBe(4999);

    // Apple renews at a raised store price: the mirror tells the truth.
    truth['5000001'] = fakes.appleTransaction({
      originalTransactionId: '5000001', transactionId: '5000001-2', productId: plan5.iosMonthlyProductId,
      price: 5499000, currency: 'PKR',
    });
    await request(app).post('/api/v1/billing/webhooks/apple')
      .send(fakes.appleNotificationBody({ notificationUUID: 'renew-up', notificationType: 'DID_RENEW', transaction: truth['5000001'] }));
    row = await rowFor('5000001');
    expect(Number(row.amount)).toBe(5499);
    expect(row.currency).toBe('PKR');
  });

  test('Apple: a renewal in another storefront currency records that currency', async () => {
    const { truth } = fakes.installAppleFakes({
      5000002: fakes.appleTransaction({ originalTransactionId: '5000002', productId: plan5.iosMonthlyProductId, price: 4999000, currency: 'PKR' }),
    });
    await appleBilling.syncFromApple({ transactionId: '5000002', tenantId: tenant.id });
    truth['5000002'] = fakes.appleTransaction({
      originalTransactionId: '5000002', transactionId: '5000002-2', productId: plan5.iosMonthlyProductId, price: 19990, currency: 'USD',
    });
    await appleBilling.syncFromApple({ transactionId: '5000002', tenantId: tenant.id });
    const row = await rowFor('5000002');
    expect(Number(row.amount)).toBe(19.99);
    expect(row.currency).toBe('USD');
  });

  test('Google: the recurring price Play reports is written on renewal', async () => {
    const { truth } = fakes.installGoogleFakes({
      'tok-p': fakes.googlePurchase({ productId: plan5.androidProductId, recurringPrice: { currencyCode: 'PKR', units: '4999', nanos: 0 } }),
    });
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-p', tenantId: tenant.id });
    expect(Number((await rowFor('tok-p')).amount)).toBe(4999);

    truth['tok-p'] = fakes.googlePurchase({
      productId: plan5.androidProductId, latestOrderId: 'GPA.2', recurringPrice: { currencyCode: 'PKR', units: '5499', nanos: 500000000 },
    });
    await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-p', tenantId: tenant.id });
    const row = await rowFor('tok-p');
    expect(Number(row.amount)).toBe(5499.5);
    expect(row.currency).toBe('PKR');
  });

  test('Stripe: a price migration on the same subscription updates the amount from Stripe', async () => {
    const { truth } = fakes.installStripeFakes({
      subscriptions: { sub_p: fakes.stripeSubscription({ id: 'sub_p', priceId: 'price_5m', tenantId: tenant.id, unitAmount: 499900 }) },
    });
    const send = (id) => request(app).post('/api/v1/billing/webhooks/stripe')
      .send({ id, type: 'customer.subscription.updated', data: { object: { id: 'sub_p' } } });
    await send('evt_p1');
    expect(Number((await rowFor('sub_p')).amount)).toBe(4999);
    expect((await rowFor('sub_p')).currency).toBe('PKR');

    truth.subscriptions.sub_p = fakes.stripeSubscription({ id: 'sub_p', priceId: 'price_5m', tenantId: tenant.id, unitAmount: 549900 });
    await send('evt_p2');
    expect(Number((await rowFor('sub_p')).amount)).toBe(5499);
  });

  test('a renewal where the provider reports no price leaves the amount as it was (never the edited catalog price)', async () => {
    const { truth } = fakes.installAppleFakes({
      5000003: fakes.appleTransaction({ originalTransactionId: '5000003', productId: plan5.iosMonthlyProductId }),
    });
    await appleBilling.syncFromApple({ transactionId: '5000003', tenantId: tenant.id });
    let row = await rowFor('5000003');
    expect(Number(row.amount)).toBe(4999); // catalog price at purchase, the only number available
    expect(row.currency).toBe('PKR'); // the catalog's currency

    await catalog.updatePlan(plan5.id, { monthlyPrice: 3999 });
    truth['5000003'] = fakes.appleTransaction({ originalTransactionId: '5000003', transactionId: '5000003-2', productId: plan5.iosMonthlyProductId });
    await appleBilling.syncFromApple({ transactionId: '5000003', tenantId: tenant.id });
    row = await rowFor('5000003');
    expect(Number(row.amount)).toBe(4999);
  });
});
