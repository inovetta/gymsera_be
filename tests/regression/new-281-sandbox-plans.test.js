/**
 * NEW-281 (decision R-114, owner 2026-11-19): a store test purchase (environment SANDBOX) never
 * stands in the way of a real plan on the production server.
 *
 * Before: a renewing SANDBOX Apple / Google row blocked the bank-transfer form and its approval
 * (409 store_plan_active), was closed PENDING_CANCEL "cancel it yourself", extended the paid
 * period from its own end date, and a later sandbox renewal flagged duplicateBilling. A gym whose
 * only plan is SANDBOX is invisible to travellers (R-87), so the owner's real gym and the App
 * Review demo gym must be able to move to a MANUAL plan.
 *
 * Now: SANDBOX rows are ignored by storeBlock (form and approval) and by periodFor; a real plan
 * (MANUAL, or a PRODUCTION store purchase) closes a SANDBOX row CANCELLED "Test purchase replaced
 * … no action needed"; a later sandbox renewal keeps it superseded without duplicateBilling.
 * A real (PRODUCTION or unknown environment) store plan still blocks exactly as before.
 */
const sharp = require('sharp');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { createBillingPlan, createTenantSubscription } = require('../harness/factories');
const { TenantSubscription, PlanPaymentRequest } = require('../../src/models/platform');
const { ENTITLING_STATUSES } = require('../../src/services/subscription-quota.service');
const planPaymentService = require('../../src/services/plan-payment.service');
const subscriptionMigration = require('../../src/services/subscription-migration.service');

const BANK_ENV = {
  BANK_TRANSFER_BANK_NAME: 'Test Bank',
  BANK_TRANSFER_ACCOUNT_TITLE: 'GymsEra Test',
  BANK_TRANSFER_ACCOUNT_NUMBER: '000111222333',
};
const today = () => new Date().toISOString().split('T')[0];
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];

describe('NEW-281: SANDBOX store plans never block or extend a real plan (R-114)', () => {
  let ctx;
  let plan2;
  let jpeg;
  const saved = {};
  const tenantId = () => ctx.tenant1.id;

  const submit = () => {
    const req = asPersona('owner').post('/host/plan-payments');
    req.field('billingPlanId', plan2.id).field('billingCycle', 'MONTHLY');
    req.attach('proof', jpeg, { filename: 'receipt.jpg', contentType: 'image/jpeg' });
    return req;
  };
  const approve = (id) => asPersona('platformAdmin').post(`/admin/plan-payments/${id}/approve`, {});
  const entitling = () => TenantSubscription.findAll({ where: { tenantId: tenantId(), status: ENTITLING_STATUSES } });
  const resetTenant = async (rows = []) => {
    await PlanPaymentRequest.destroy({ where: {} });
    await TenantSubscription.destroy({ where: { tenantId: tenantId() } });
    for (const r of rows) await createTenantSubscription(tenantId(), r);
  };

  beforeAll(async () => {
    for (const k of Object.keys(BANK_ENV)) { saved[k] = process.env[k]; process.env[k] = BANK_ENV[k]; }
    const h = await setupTestDatabases();
    await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    plan2 = await createBillingPlan({ branchCount: 2, monthlyPrice: 2999, annualPrice: 29990, sortOrder: 2 });
    jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg().toBuffer();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await teardownTestDatabases();
  });

  describe.each([['IOS'], ['ANDROID']])('%s', (platform) => {
    const storeRow = (overrides) => ({
      platform, branchCount: 1, billingPlanId: null, externalOriginalTransactionId: `${platform}-sbx-${Math.random().toString(36).slice(2)}`,
      paymentStatus: 'PAID', status: 'ACTIVE', autoRenew: true, startDate: plusDays(-5), endDate: plusDays(25), ...overrides,
    });

    test('a renewing SANDBOX plan does not block the bank-transfer form or its approval; approval closes it, no action needed', async () => {
      await resetTenant([storeRow({ environment: 'SANDBOX', externalOriginalTransactionId: `${platform}-sandbox` })]);

      const view = await asPersona('owner').get('/host/plan-payments');
      expect(view.body.data.blocked).toBeNull();
      expect(view.body.data.canSubmit).toBe(true);

      const sent = await submit();
      expect(sent.status).toBe(201);
      const ok = await approve(sent.body.data.request.id);
      expect(ok.status).toBe(200);

      expect((await entitling()).map((r) => r.platform)).toEqual(['MANUAL']);
      const sandbox = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: `${platform}-sandbox` } });
      expect(sandbox.status).toBe('CANCELLED');
      expect(sandbox.statusNote).toMatch(/Test purchase replaced .* no action needed/);
      expect(sandbox.duplicateBilling).toBeFalsy();
    });

    test('the paid period is never extended from a SANDBOX plan\'s end date', async () => {
      await resetTenant([storeRow({ environment: 'SANDBOX', endDate: plusDays(25) })]);
      const sent = await submit();
      const ok = await approve(sent.body.data.request.id);
      const sub = await TenantSubscription.findByPk(ok.body.data.subscription.id);
      expect(String(sub.startDate)).toBe(today());
      expect(String(sub.endDate)).toBe(planPaymentService.addMonths(today(), 1));
    });

    test('a real (PRODUCTION) store plan that renews still blocks: 409 store_plan_active', async () => {
      await resetTenant([storeRow({ environment: 'PRODUCTION' })]);
      const res = await submit();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('store_plan_active');
    });

    test('a later sandbox renewal of the replaced row keeps it closed, without duplicateBilling', async () => {
      await resetTenant([storeRow({ environment: 'SANDBOX', externalOriginalTransactionId: `${platform}-renews` })]);
      const ok = await approve((await submit()).body.data.request.id);
      expect(ok.status).toBe(200);

      await subscriptionMigration.applyVerifiedSubscription(tenantId(), {
        platform, externalOriginalTransactionId: `${platform}-renews`, externalTransactionId: `${platform}-renews-2`,
        environment: 'SANDBOX', status: 'ACTIVE', branchCount: 1, billingPlanId: null, productId: null,
        startDate: today(), endDate: plusDays(30), autoRenew: true, paymentStatus: 'PAID', lastVerifiedAt: new Date(),
      }, { idempotencyPrefix: `${platform}-renews-2`, logLabel: 'test' });

      const row = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: `${platform}-renews` } });
      expect(row.status).toBe('CANCELLED');
      expect(row.duplicateBilling).toBeFalsy();
      expect((await entitling()).map((r) => r.platform)).toEqual(['MANUAL']);
    });

    test('a real store purchase (PRODUCTION) replacing a SANDBOX plan closes it, no action needed', async () => {
      await resetTenant([storeRow({ environment: 'SANDBOX', externalOriginalTransactionId: `${platform}-old-sandbox` })]);

      await subscriptionMigration.applyVerifiedSubscription(tenantId(), {
        platform, externalOriginalTransactionId: `${platform}-real-1`, externalTransactionId: `${platform}-real-1`,
        environment: 'PRODUCTION', status: 'ACTIVE', branchCount: 2, billingPlanId: plan2.id, productId: null,
        startDate: today(), endDate: plusDays(30), autoRenew: true, paymentStatus: 'PAID', lastVerifiedAt: new Date(),
        amount: 2999, currency: 'PKR', billingCycle: 'MONTHLY',
      }, { idempotencyPrefix: `${platform}-real-1`, logLabel: 'test' });

      const old = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: `${platform}-old-sandbox` } });
      expect(old.status).toBe('CANCELLED');
      expect(old.statusNote).toMatch(/Test purchase replaced .* no action needed/);
    });
  });
});
