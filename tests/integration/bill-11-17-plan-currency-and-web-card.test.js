/**
 * BILL-11: per-currency catalog prices — GET /billing/plans?currency=USD returns USD prices and the Stripe
 *          checkout session uses the USD Price ID.
 * BILL-17 / R-7: new web card payments are refused unless WEB_CARD_PAYMENTS_ENABLED=true.
 */
const mockStripe = {
  customers: { search: jest.fn(async () => ({ data: [{ id: 'cus_test' }] })), create: jest.fn() },
  checkout: { sessions: { create: jest.fn(async () => ({ id: 'cs_test', url: 'https://stripe.test/pay' })) } },
};
jest.mock('stripe', () => jest.fn().mockImplementation(() => mockStripe));

const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { BillingPlan, BillingPlanPrice } = require('../../src/models/platform');

describe('BILL-11 / BILL-17: plan currencies and the web card switch', () => {
  let app;
  let personas;
  let plan;

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
    const h = await setupTestDatabases();
    personas = await setupPersonas(h);
    app = await startTestServer();
    plan = await BillingPlan.create({
      branchCount: 3, monthlyPrice: '5000.00', annualPrice: '50000.00', currency: 'PKR',
      stripeMonthlyPriceId: 'price_pkr_m', stripeAnnualPriceId: 'price_pkr_y', sortOrder: 3,
    });
  });
  afterAll(async () => {
    delete process.env.WEB_CARD_PAYMENTS_ENABLED;
    await teardownTestDatabases();
  });

  const admin = () => ({ Authorization: `Bearer ${personas.platformAdmin.token}` });
  const owner = () => ({ Authorization: `Bearer ${personas.owner.token}` });

  test('admin sets a USD price; amounts are stored as integer cents', async () => {
    const res = await request(app).put(`/api/v1/admin/billing-plans/${plan.id}/prices/usd`).set(admin())
      .send({ monthlyPrice: '19.99', annualPrice: '199.90', stripeMonthlyPriceId: 'price_usd_m', stripeAnnualPriceId: 'price_usd_y' });
    expect(res.status).toBe(200);
    const row = await BillingPlanPrice.findOne({ where: { billingPlanId: plan.id, currency: 'USD' } });
    expect(Number(row.monthlyMinor)).toBe(1999);
    expect(Number(row.annualMinor)).toBe(19990);
  });

  test('the default currency cannot be added as an extra price, nor an unsupported one', async () => {
    const same = await request(app).put(`/api/v1/admin/billing-plans/${plan.id}/prices/PKR`).set(admin())
      .send({ monthlyPrice: '1.00', annualPrice: '10.00' });
    expect(same.status).toBe(409);
    const bad = await request(app).put(`/api/v1/admin/billing-plans/${plan.id}/prices/KWD`).set(admin())
      .send({ monthlyPrice: '1.00', annualPrice: '10.00' });
    expect(bad.status).toBe(400);
  });

  test('GET /billing/plans?currency=USD returns the USD price; no currency or an unpriced one returns PKR', async () => {
    const usd = await request(app).get('/api/v1/billing/plans?currency=USD&platform=web');
    expect(usd.status).toBe(200);
    const p = usd.body.data.plans.find((x) => x.id === plan.id);
    expect(p).toMatchObject({ currency: 'USD', monthlyPrice: 19.99, annualPrice: 199.9, monthlyPriceId: 'price_usd_m', annualPriceId: 'price_usd_y' });

    const none = await request(app).get('/api/v1/billing/plans');
    expect(none.body.data.plans.find((x) => x.id === plan.id)).toMatchObject({ currency: 'PKR', monthlyPrice: 5000 });

    const eur = await request(app).get('/api/v1/billing/plans?currency=EUR');
    expect(eur.body.data.plans.find((x) => x.id === plan.id)).toMatchObject({ currency: 'PKR', monthlyPrice: 5000 });
  });

  test('changing a currency price clears the Stripe Price IDs created for the old amount', async () => {
    await request(app).put(`/api/v1/admin/billing-plans/${plan.id}/prices/USD`).set(admin())
      .send({ monthlyPrice: '24.99', annualPrice: '249.90' });
    const row = await BillingPlanPrice.findOne({ where: { billingPlanId: plan.id, currency: 'USD' } });
    expect(Number(row.monthlyMinor)).toBe(2499);
    expect(row.stripeMonthlyPriceId).toBeNull();
    await row.update({ stripeMonthlyPriceId: 'price_usd_m2', stripeAnnualPriceId: 'price_usd_y2' });
  });

  test('BILL-17: checkout is refused while WEB_CARD_PAYMENTS_ENABLED is off, and Stripe is never called', async () => {
    delete process.env.WEB_CARD_PAYMENTS_ENABLED;
    const res = await request(app).post('/api/v1/billing/stripe/checkout-session').set(owner())
      .send({ billingPlanId: plan.id, billingCycle: 'MONTHLY', successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no' });
    expect(res.status).toBe(403);
    expect(res.body.code || res.body.error?.code).toBe('web_card_payments_disabled');
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('BILL-11 + BILL-17: with the switch on, a USD checkout uses the USD price ID; no currency uses PKR', async () => {
    process.env.WEB_CARD_PAYMENTS_ENABLED = 'true';
    const body = { billingPlanId: plan.id, billingCycle: 'MONTHLY', successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no' };

    const usd = await request(app).post('/api/v1/billing/stripe/checkout-session').set(owner()).send({ ...body, currency: 'USD' });
    expect(usd.status).toBe(200);
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].line_items[0].price).toBe('price_usd_m2');

    const pkr = await request(app).post('/api/v1/billing/stripe/checkout-session').set(owner()).send(body);
    expect(pkr.status).toBe(200);
    expect(mockStripe.checkout.sessions.create.mock.calls[1][0].line_items[0].price).toBe('price_pkr_m');

    const missing = await request(app).post('/api/v1/billing/stripe/checkout-session').set(owner()).send({ ...body, currency: 'EUR' });
    expect(missing.status).toBe(400);
    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
  });

  test('plans response tells clients whether web card payments are on', async () => {
    process.env.WEB_CARD_PAYMENTS_ENABLED = 'true';
    expect((await request(app).get('/api/v1/billing/plans')).body.data.webCardPaymentsEnabled).toBe(true);
    delete process.env.WEB_CARD_PAYMENTS_ENABLED;
    expect((await request(app).get('/api/v1/billing/plans')).body.data.webCardPaymentsEnabled).toBe(false);
  });
});
