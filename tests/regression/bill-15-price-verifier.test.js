/**
 * BILL-15: read-only Play Console price check.
 * Google is faked (injected `play`); nothing here talks to the network. The job must: do nothing without
 * credentials, record VERIFIED / MISMATCH / UNVERIFIABLE per plan, alert on mismatch with ids and counts
 * only, and never change a plan.
 */
const fs = require('fs');
const path = require('path');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, setupPersonas, asPersona } = require('../harness');
const { BillingPlan, BillingPlanPrice, BillingPlanPriceCheck, Notification } = require('../../src/models/platform');
const alertService = require('../../src/services/alert.service');
const googlePlay = require('../../src/services/google-play-billing.service');
const {
  runPriceVerification, comparePlan, describeVerification, moneyToMinor, STALE_AFTER_MS,
} = require('../../src/services/price-verification.service');

const money = (currencyCode, units, nanos = 0) => ({ currencyCode, units: String(units), nanos });
const basePlan = (basePlanId, { period, regional = [], usd } = {}) => ({
  basePlanId,
  state: 'ACTIVE',
  autoRenewingBasePlanType: { billingPeriodDuration: period },
  regionalConfigs: regional.map((price) => ({ regionCode: 'XX', price })),
  ...(usd && { otherRegionsConfig: { usdPrice: usd } }),
});
/** A Play subscription that agrees with a plan priced PKR 1,500 monthly / 15,000 annual. */
const matchingProduct = (over = {}) => ({
  productId: 'branches_1',
  basePlans: [
    basePlan('monthly', { period: 'P1M', regional: [money('PKR', 1500)] }),
    basePlan('annual', { period: 'P1Y', regional: [money('PKR', 15000)] }),
  ],
  ...over,
});

let personas;
beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
});
afterAll(teardownTestDatabases);

describe('BILL-15: price verification', () => {
  const savedEnv = { ...process.env };
  let plan;
  const play = (impl) => ({ getSubscriptionProduct: jest.fn(impl) });

  beforeEach(async () => {
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = '{"client_email":"x","private_key":"y"}';
    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.example.app';
    await BillingPlanPriceCheck.destroy({ where: {} });
    await BillingPlanPrice.destroy({ where: {} });
    await BillingPlan.update({ isActive: false }, { where: {} });
    plan = await BillingPlan.create({
      branchCount: 91, monthlyPrice: 1500, annualPrice: 15000, currency: 'PKR', isActive: true, sortOrder: 91,
      androidProductId: 'branches_1', androidMonthlyBasePlanId: 'monthly', androidAnnualBasePlanId: 'annual',
      androidSyncStatus: 'SYNCED', iosSyncStatus: 'SYNCED',
    });
  });
  afterEach(() => { process.env = { ...savedEnv }; jest.restoreAllMocks(); });

  test('inert without Google credentials: nothing is called or stored', async () => {
    delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    const p = play(async () => matchingProduct());
    expect(await runPriceVerification({ play: p })).toEqual({ skipped: true, reason: 'not_configured' });
    expect(p.getSubscriptionProduct).not.toHaveBeenCalled();
    expect(await BillingPlanPriceCheck.count()).toBe(0);
  });

  test('matching prices: VERIFIED, one row, no alert, and the plan is untouched', async () => {
    const before = (await BillingPlan.findByPk(plan.id)).toJSON();
    const raise = jest.spyOn(alertService, 'raise');
    const res = await runPriceVerification({ play: play(async () => matchingProduct()) });
    expect(res).toMatchObject({ checkedCount: 1, verifiedCount: 1, mismatchCount: 0, failureCount: 0 });
    const rows = await BillingPlanPriceCheck.findAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ billingPlanId: plan.id, provider: 'GOOGLE', status: 'VERIFIED', mismatchCount: 0 });
    expect(raise).not.toHaveBeenCalled();
    expect((await BillingPlan.findByPk(plan.id)).toJSON()).toEqual(before); // prices, statuses, updatedAt
  });

  test('a different amount is a MISMATCH: alert with the count and the plan id, no amounts', async () => {
    const product = matchingProduct({ basePlans: [
      basePlan('monthly', { period: 'P1M', regional: [money('PKR', 1999)] }),
      basePlan('annual', { period: 'P1Y', regional: [money('PKR', 15000)] }),
    ] });
    const raise = jest.spyOn(alertService, 'raise');
    const res = await runPriceVerification({ play: play(async () => product) });
    expect(res).toMatchObject({ mismatchCount: 1, mismatchPlanIds: [plan.id] });
    expect(raise).toHaveBeenCalledWith('BILLING_PRICE_MISMATCH', { mismatchCount: 1, planIds: [plan.id] });
    const row = await BillingPlanPriceCheck.findOne();
    expect(row.status).toBe('MISMATCH');
    expect(row.detailsJson.find((d) => d.result === 'MISMATCH')).toMatchObject({ cadence: 'monthly', expectedMinor: 150000, googleMinor: [199900] });
    // what reached the admins: ids and counts, never a price
    const notes = await Notification.findAll({ where: { type: 'PLATFORM_ALERT' } });
    expect(JSON.stringify(notes.map((n) => [n.title, n.message, n.metadataJson]))).not.toMatch(/1999|199900|1500|150000/);
    // and the plan still has the admin's price
    expect(Number((await BillingPlan.findByPk(plan.id)).monthlyPrice)).toBe(1500);
  });

  test('a wrong billing period is a mismatch even when the amount agrees', async () => {
    const product = matchingProduct({ basePlans: [
      basePlan('monthly', { period: 'P1Y', regional: [money('PKR', 1500)] }),
      basePlan('annual', { period: 'P1Y', regional: [money('PKR', 15000)] }),
    ] });
    const res = await runPriceVerification({ play: play(async () => product) });
    expect(res.mismatchCount).toBe(1);
    expect((await BillingPlanPriceCheck.findOne()).detailsJson.find((d) => d.reason === 'billing_period')).toBeTruthy();
  });

  test('a product that is not in Play Console is UNVERIFIABLE, stays admin-attested and raises no alert', async () => {
    const raise = jest.spyOn(alertService, 'raise');
    const res = await runPriceVerification({ play: play(async () => { const e = new Error('not found'); e.response = { status: 404 }; throw e; }) });
    expect(res).toMatchObject({ unverifiableCount: 1, mismatchCount: 0, failureCount: 0 });
    expect(raise).not.toHaveBeenCalled();
    const check = await BillingPlanPriceCheck.findOne();
    expect(check.status).toBe('UNVERIFIABLE');
    expect(describeVerification([check]).android.status).toBe('ADMIN_ATTESTED');
  });

  test('a Google error is counted, alerted as a failed check, and the previous result is kept', async () => {
    await runPriceVerification({ play: play(async () => matchingProduct()) });
    const raise = jest.spyOn(alertService, 'raise');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await runPriceVerification({ play: play(async () => { const e = new Error('forbidden'); e.response = { status: 403 }; throw e; }) });
    expect(res).toMatchObject({ failureCount: 1, checkedCount: 0 });
    expect(raise).toHaveBeenCalledWith('BILLING_PRICE_CHECK_FAILED', { failureCount: 1 });
    expect((await BillingPlanPriceCheck.findOne()).status).toBe('VERIFIED');
  });

  test('fixing the price flips MISMATCH back to VERIFIED in the same row', async () => {
    const bad = matchingProduct({ basePlans: [basePlan('monthly', { period: 'P1M', regional: [money('PKR', 1)] }), basePlan('annual', { period: 'P1Y', regional: [money('PKR', 15000)] })] });
    await runPriceVerification({ play: play(async () => bad) });
    expect((await BillingPlanPriceCheck.findOne()).status).toBe('MISMATCH');
    await runPriceVerification({ play: play(async () => matchingProduct()) });
    const rows = await BillingPlanPriceCheck.findAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('VERIFIED');
  });

  test('extra currencies: USD is compared with Google\'s USD price; a currency Google does not list is skipped', async () => {
    await BillingPlanPrice.create({ billingPlanId: plan.id, currency: 'USD', monthlyMinor: 999, annualMinor: 9999 });
    await BillingPlanPrice.create({ billingPlanId: plan.id, currency: 'EUR', monthlyMinor: 899, annualMinor: 8999 });
    const ok = matchingProduct({ basePlans: [
      basePlan('monthly', { period: 'P1M', regional: [money('PKR', 1500)], usd: money('USD', 9, 990000000) }),
      basePlan('annual', { period: 'P1Y', regional: [money('PKR', 15000)], usd: money('USD', 99, 990000000) }),
    ] });
    expect((await runPriceVerification({ play: play(async () => ok) })).verifiedCount).toBe(1);

    const wrongUsd = matchingProduct({ basePlans: [
      basePlan('monthly', { period: 'P1M', regional: [money('PKR', 1500)], usd: money('USD', 12) }),
      basePlan('annual', { period: 'P1Y', regional: [money('PKR', 15000)], usd: money('USD', 99, 990000000) }),
    ] });
    expect((await runPriceVerification({ play: play(async () => wrongUsd) })).mismatchCount).toBe(1);
  });

  test('the default currency missing from Google makes the plan UNVERIFIABLE, not a mismatch', async () => {
    const eurOnly = matchingProduct({ basePlans: [basePlan('monthly', { period: 'P1M', regional: [money('EUR', 9)] }), basePlan('annual', { period: 'P1Y', regional: [money('EUR', 90)] })] });
    const res = await runPriceVerification({ play: play(async () => eurOnly) });
    expect(res).toMatchObject({ unverifiableCount: 1, mismatchCount: 0 });
  });

  test('plans without an Android product, and inactive plans, are not checked', async () => {
    await BillingPlan.create({ branchCount: 92, monthlyPrice: 1, annualPrice: 1, currency: 'PKR', isActive: true, sortOrder: 92 });
    await BillingPlan.create({ branchCount: 93, monthlyPrice: 1, annualPrice: 1, currency: 'PKR', isActive: false, sortOrder: 93, androidProductId: 'x', androidMonthlyBasePlanId: 'monthly', androidAnnualBasePlanId: 'annual' });
    const p = play(async () => matchingProduct());
    await runPriceVerification({ play: p });
    expect(p.getSubscriptionProduct).toHaveBeenCalledTimes(1);
  });

  describe('money conversion', () => {
    test('units and nanos become minor units using the currency\'s own digits', () => {
      expect(moneyToMinor(money('PKR', 1500))).toEqual({ currency: 'PKR', minor: 150000 });
      expect(moneyToMinor(money('USD', 9, 990000000))).toEqual({ currency: 'USD', minor: 999 });
      expect(moneyToMinor(money('JPY', 500))).toEqual({ currency: 'JPY', minor: 500 });
      expect(moneyToMinor(null)).toBeNull();
    });
  });

  describe('badge', () => {
    const check = (status, ageMs, mismatchCount = 0) => ({ provider: 'GOOGLE', status, checkedAt: new Date(Date.now() - ageMs), mismatchCount });
    test('fresh VERIFIED and MISMATCH are shown; stale, UNVERIFIABLE and missing are admin-attested', () => {
      expect(describeVerification([check('VERIFIED', 1000)]).android.status).toBe('VERIFIED');
      expect(describeVerification([check('MISMATCH', 1000, 2)]).android).toMatchObject({ status: 'MISMATCH', mismatchCount: 2 });
      expect(describeVerification([check('VERIFIED', STALE_AFTER_MS + 60000)]).android.status).toBe('ADMIN_ATTESTED');
      expect(describeVerification([check('UNVERIFIABLE', 1000)]).android.status).toBe('ADMIN_ATTESTED');
      expect(describeVerification([]).android.status).toBe('ADMIN_ATTESTED');
    });
    test('iOS is always admin-attested', () => {
      expect(describeVerification([check('VERIFIED', 1000)]).ios.status).toBe('ADMIN_ATTESTED');
    });
  });

  describe('admin API', () => {
    test('GET /admin/billing-plans carries priceVerification; GET /:id too; non-admins are refused', async () => {
      await runPriceVerification({ play: play(async () => matchingProduct()) });
      const list = await asPersona('platformAdmin').get('/admin/billing-plans');
      expect(list.status).toBe(200);
      const row = list.body.data.find((p) => p.id === plan.id);
      expect(row.priceVerification.android.status).toBe('VERIFIED');
      expect(row.priceVerification.ios.status).toBe('ADMIN_ATTESTED');
      const one = await asPersona('platformAdmin').get(`/admin/billing-plans/${plan.id}`);
      expect(one.body.data.priceVerification.android.status).toBe('VERIFIED');
      expect([401, 403]).toContain((await asPersona('owner').get('/admin/billing-plans')).status);
    });
  });
});

describe('BILL-15: it only reads', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const src = fs.readFileSync(path.join(ROOT, 'src/services/price-verification.service.js'), 'utf8');

  test('the verifier never writes to a BillingPlan or a BillingPlanPrice', () => {
    expect(src).not.toMatch(/BillingPlan\.(update|create|destroy|upsert|bulkCreate)/);
    expect(src).not.toMatch(/BillingPlanPrice\.(update|create|destroy|upsert|bulkCreate)/);
    expect(src).not.toMatch(/\bplan\.(update|save|set)\(/);
    expect(src).toMatch(/BillingPlanPriceCheck\.upsert/);
  });

  test('the Play call is a GET to the subscriptions resource', () => {
    const play = fs.readFileSync(path.join(ROOT, 'src/services/google-play-billing.service.js'), 'utf8');
    const fn = play.slice(play.indexOf('const getSubscriptionProduct'), play.indexOf('const isConfigured'));
    expect(fn).toMatch(/method: 'GET'/);
    expect(fn).not.toMatch(/method: '(POST|PUT|PATCH|DELETE)'/);
  });

  test('comparePlan is pure: the same input gives the same answer and does not mutate it', () => {
    const plan = { currency: 'PKR', monthlyPrice: 1500, annualPrice: 15000, androidMonthlyBasePlanId: 'monthly', androidAnnualBasePlanId: 'annual', prices: [] };
    const product = matchingProduct();
    const snapshot = JSON.stringify([plan, product]);
    expect(comparePlan(plan, product)).toEqual(comparePlan(plan, product));
    expect(JSON.stringify([plan, product])).toBe(snapshot);
  });

  test('the module is the one the server schedules, and it is inert by default', () => {
    expect(googlePlay.isConfigured()).toBe(Boolean(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_PLAY_PACKAGE_NAME));
    expect(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')).toMatch(/price-verification/);
  });
});
