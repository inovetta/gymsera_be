/**
 * BILL-14 — The Stripe return page must not trust the browser (spec §12.1).
 *
 * GET /billing/stripe/session/:id asks Stripe (server-side) about the
 * Checkout Session and reports whether the webhook-driven entitlement exists.
 * The `?checkout=success` query parameter is never proof of anything.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
const app = require('../../app');
const { signToken } = require('../../src/utils/jwt.utils');
const { City, TenantSubscription } = require('../../src/models/platform');
const stripeBilling = require('../../src/services/stripe-billing.service');

describe('BILL-14: Stripe return is verified server-side', () => {
  let dbHarness;
  let tenant;
  let otherTenant;
  let token;
  let sessions;

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
    otherTenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant2.encryptedConnStr });
    await factories.createGymListing(tenant.id);
    await factories.createBillingPlan({ branchCount: 3, stripeMonthlyPriceId: 'price_3m' });
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });

    sessions = {
      cs_paid: { id: 'cs_paid', status: 'complete', payment_status: 'paid', subscription: 'sub_paid', metadata: { tenantId: tenant.id } },
      cs_open: { id: 'cs_open', status: 'open', payment_status: 'unpaid', subscription: null, metadata: { tenantId: tenant.id } },
      cs_other: { id: 'cs_other', status: 'complete', payment_status: 'paid', subscription: 'sub_other', metadata: { tenantId: otherTenant.id } },
    };
    jest.spyOn(stripeBilling.stripeApi, 'retrieveCheckoutSession').mockImplementation(async (id) => {
      if (!sessions[id]) throw Object.assign(new Error('No such checkout.session'), { statusCode: 404 });
      return sessions[id];
    });
  });

  const check = (id, auth = token) => {
    const req = request(app).get(`/api/v1/billing/stripe/session/${id}`);
    return auth ? req.set('Authorization', `Bearer ${auth}`) : req;
  };

  test('requires authentication', async () => {
    expect((await check('cs_paid', null)).status).toBe(401);
  });

  test('an unpaid session is not confirmed and grants nothing', async () => {
    const res = await check('cs_open');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ confirmed: false, entitled: false });
    expect(await TenantSubscription.count()).toBe(0);
  });

  test('paid at Stripe but webhook not processed yet → confirmed, not yet entitled; the GET itself writes nothing', async () => {
    const res = await check('cs_paid');
    expect(res.body.data).toMatchObject({ confirmed: true, entitled: false });
    expect(await TenantSubscription.count()).toBe(0);
  });

  test('once the webhook has created the subscription → entitled', async () => {
    const live = fakes.stripeSubscription({ id: 'sub_paid', priceId: 'price_3m', tenantId: tenant.id });
    fakes.installStripeFakes({ subscriptions: { sub_paid: live } });
    await request(app).post('/api/v1/billing/webhooks/stripe')
      .send({ id: 'evt_done', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_paid' } } });

    const res = await check('cs_paid');
    expect(res.body.data).toMatchObject({ confirmed: true, entitled: true });
  });

  test('another tenant’s session, or an unknown id, is not found', async () => {
    expect((await check('cs_other')).status).toBe(404);
    expect((await check('cs_made_up')).status).toBe(404);
  });
});
