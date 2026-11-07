'use strict';

/**
 * Phase 7 P9d, NEW-225 (P1) and NEW-224 (P3), decision R-96.
 *
 * The app asks POST /billing/purchase-intent before it opens the Apple or Google purchase sheet.
 * The server alone decides; the app only shows the answer.
 *  - 409 store_plan_active: another store's plan entitles and renews (Apple vs Google), same wording
 *    as the P9c bank-transfer refusal (plan-payment.service.js storeBlock);
 *  - 409 bank_plan_active: a PAID bank-transfer plan with days left, and the plan asked for does
 *    not have more branches (catalog branchCount; an equal limit is not bigger);
 *  - 409 same_plan_active: the same plan (and cycle) already renews on this store;
 *  - 200 with a server-written warning and the unused-days count: a bigger plan over a paid bank
 *    plan (the days are lost, NEW-224), requiresConfirmation true;
 *  - 200 unchanged: nothing entitling, a cancelled or ended plan, an unpaid pay-later plan.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { createBillingPlan, createTenantSubscription } = require('../harness/factories');
const { TenantSubscription, PlatformPackage } = require('../../src/models/platform');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];

describe('P9d: purchase-intent is the server check before every store purchase (NEW-225, NEW-224, R-96)', () => {
  let ctx;
  let plan1;
  let plan3;
  let plan3b; // another catalog plan with the same branch limit as plan3
  let plan5;
  const tenantId = () => ctx.tenant1.id;

  const reset = async (rows = []) => {
    await TenantSubscription.destroy({ where: { tenantId: tenantId() } });
    for (const r of rows) await createTenantSubscription(tenantId(), r);
  };
  const ask = (plan, platform, extra = {}) =>
    asPersona('owner').post('/billing/purchase-intent', { planId: plan ? plan.id : undefined, platform, ...extra });

  const apple = (plan, o = {}) => ({
    platform: 'IOS', billingPlanId: plan.id, branchCount: plan.branchCount, autoRenew: true,
    paymentStatus: 'PAID', externalOriginalTransactionId: `apple-${Date.now()}-${Math.random()}`, ...o,
  });
  const google = (plan, o = {}) => ({
    platform: 'ANDROID', billingPlanId: plan.id, branchCount: plan.branchCount, autoRenew: true,
    paymentStatus: 'PAID', externalOriginalTransactionId: `gpa-${Date.now()}-${Math.random()}`, ...o,
  });
  const bank = (plan, o = {}) => ({
    platform: 'MANUAL', billingPlanId: plan.id, branchCount: plan.branchCount, autoRenew: false,
    paymentStatus: 'PAID', startDate: day(-10), endDate: day(20), ...o,
  });

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    plan1 = await createBillingPlan({ branchCount: 1, monthlyPrice: 2000, annualPrice: 20000, sortOrder: 1 });
    plan3 = await createBillingPlan({ branchCount: 3, monthlyPrice: 4990, annualPrice: 49900, sortOrder: 3 });
    plan3b = await createBillingPlan({
      branchCount: 3, monthlyPrice: 5990, annualPrice: 59900, sortOrder: 4,
      iosMonthlyProductId: 'com.gymsera.plan.3b2.monthly', iosAnnualProductId: 'com.gymsera.plan.3b2.annual',
      androidProductId: 'plan_3b2',
    });
    plan5 = await createBillingPlan({ branchCount: 5, monthlyPrice: 7990, annualPrice: 79900, sortOrder: 5 });
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('another store plan renews (Apple vs Google)', () => {
    test.each([
      ['IOS', 'ANDROID', 'Apple', 'apps.apple.com'],
      ['ANDROID', 'IOS', 'Google Play', 'play.google.com'],
    ])('%s renewing → buying on %s is refused with 409 store_plan_active', async (current, target, name, url) => {
      await reset([current === 'IOS' ? apple(plan1) : google(plan1)]);
      const res = await ask(plan3, target.toLowerCase());
      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('store_plan_active');
      expect(res.body.message).toContain(`Your plan is billed by ${name} and renews automatically.`);
      expect(res.body.data.action).toBe('blocked');
      expect(res.body.data.platform).toBe(current);
      expect(res.body.data.manageUrl).toContain(url);
    });

    test.each([
      ['cancelled (auto-renew off)', { autoRenew: false }],
      ['ended (EXPIRED)', { status: 'EXPIRED', endDate: day(-1) }],
    ])('Apple %s → Google Play is allowed', async (_label, o) => {
      await reset([apple(plan1, o)]);
      const res = await ask(plan3, 'android');
      expect(res.status).toBe(200);
      expect(res.body.data.action).not.toBe('blocked');
      expect(res.body.data.warning).toBeNull();
    });
  });

  describe('the same plan already active', () => {
    test('the same plan and cycle renewing on the same store is refused with 409 same_plan_active', async () => {
      await reset([apple(plan3, { billingCycle: 'MONTHLY' })]);
      const res = await ask(plan3, 'ios', { billingCycle: 'MONTHLY' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('same_plan_active');
      expect(res.body.message).toMatch(/already/i);
    });

    test('the same plan on another cycle (monthly → annual) on the same store is allowed', async () => {
      await reset([apple(plan3, { billingCycle: 'MONTHLY' })]);
      const res = await ask(plan3, 'ios', { billingCycle: 'YEARLY' });
      expect(res.status).toBe(200);
    });

    test('the same plan whose auto-renew is off may be bought again', async () => {
      await reset([google(plan3, { autoRenew: false })]);
      const res = await ask(plan3, 'android', { billingCycle: 'MONTHLY' });
      expect(res.status).toBe(200);
    });

    test('a bigger plan on the same store is still an upgrade', async () => {
      await reset([apple(plan1)]);
      const res = await ask(plan3, 'ios');
      expect(res.status).toBe(200);
      expect(res.body.data.action).toBe('upgrade');
    });
  });

  describe('a PAID bank-transfer plan with days left (R-96)', () => {
    test('the same plan is refused with 409 bank_plan_active', async () => {
      await reset([bank(plan3)]);
      const res = await ask(plan3, 'ios');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('bank_plan_active');
      expect(res.body.data.action).toBe('blocked');
      expect(res.body.data.unusedDays).toBe(20);
      expect(res.body.message).toContain('20 paid days');
    });

    test('a smaller plan is refused with 409', async () => {
      await reset([bank(plan3)]);
      const res = await ask(plan1, 'android');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('bank_plan_active');
    });

    test('another plan with the same branch limit is not bigger: refused with 409', async () => {
      await reset([bank(plan3)]);
      const res = await ask(plan3b, 'ios');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('bank_plan_active');
    });

    test('a bigger plan is allowed, with the unused days and the warning from the server', async () => {
      await reset([bank(plan3)]);
      const res = await ask(plan5, 'ios');
      expect(res.status).toBe(200);
      expect(res.body.data.action).not.toBe('blocked');
      expect(res.body.data.requiresConfirmation).toBe(true);
      expect(res.body.data.warning).toEqual({
        code: 'bank_days_lost',
        unusedDays: 20,
        endDate: day(20),
        title: expect.any(String),
        message: expect.stringContaining('20 unused paid days'),
      });
    });

    test('"bigger" is the catalog limit, not what the app says: a client branch count is ignored', async () => {
      await reset([bank(plan3)]);
      const res = await ask(plan1, 'ios', { branchCount: 99 });
      expect(res.status).toBe(409);
    });

    test('without a plan the server cannot compare: 400, nothing allowed', async () => {
      await reset([bank(plan3)]);
      const res = await ask(null, 'ios');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('plan_required');
    });

    test('an unknown plan id: 404, nothing allowed', async () => {
      await reset([bank(plan3)]);
      const res = await ask({ id: '00000000-0000-4000-8000-000000000000' }, 'ios');
      expect(res.status).toBe(404);
    });

    test('a legacy package row (paid, no branchCount) compares on the package limit', async () => {
      const pkg = await PlatformPackage.create({ name: 'Starter', price: 4999, billingCycle: 'MONTHLY', maxBranches: 1, maxOrganizations: 1 });
      await reset([bank(plan1, { billingPlanId: null, branchCount: null, platformPackageId: pkg.id })]);
      expect((await ask(plan1, 'ios')).status).toBe(409);
      const bigger = await ask(plan3, 'ios');
      expect(bigger.status).toBe(200);
      expect(bigger.body.data.warning.unusedDays).toBe(20);
    });
  });

  describe('a host with no paid bank days is unaffected', () => {
    test('nothing active: new purchase, no warning', async () => {
      await reset([]);
      const res = await ask(plan1, 'ios');
      expect(res.status).toBe(200);
      expect(res.body.data.action).toBe('new');
      expect(res.body.data.warning).toBeNull();
      expect(res.body.data.requiresConfirmation).toBe(false);
    });

    test('pay-later grace (unpaid): any plan, no warning', async () => {
      await reset([bank(plan3, { status: 'GRACE', paymentStatus: 'PENDING' })]);
      const res = await ask(plan1, 'ios');
      expect(res.status).toBe(200);
      expect(res.body.data.warning).toBeNull();
    });

    test('a bank plan that ends today has no paid day left: allowed, no warning', async () => {
      await reset([bank(plan3, { endDate: day(0) })]);
      const res = await ask(plan1, 'android');
      expect(res.status).toBe(200);
      expect(res.body.data.warning).toBeNull();
    });

    test('a bank plan that has ended: allowed, no warning', async () => {
      await reset([bank(plan3, { status: 'EXPIRED', endDate: day(-2) })]);
      const res = await ask(plan3, 'ios');
      expect(res.status).toBe(200);
      expect(res.body.data.warning).toBeNull();
    });
  });
});
