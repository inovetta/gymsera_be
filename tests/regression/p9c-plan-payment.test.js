/**
 * Phase 7 P9c item D (decision R-95) — a host pays for a GymsEra plan by bank transfer in the CMS;
 * a platform admin approves (the plan is granted) or rejects.
 *
 * Before: GET-only billing page ("a plan cannot be requested here, email support");
 * POST /host/subscription/upgrade answers 410 (NEW-06: it used to grant without payment).
 * Now: GET /host/plan-payments, POST /host/plan-payments (owner only, receipt required),
 * GET/POST /admin/plan-payments/... — granted only through applyVerifiedSubscription.
 */
const sharp = require('sharp');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { createBillingPlan, createTenantSubscription } = require('../harness/factories');
const { TenantSubscription, PlanPaymentRequest, PlatformAuditLog } = require('../../src/models/platform');
const { ENTITLING_STATUSES } = require('../../src/services/subscription-quota.service');
const planPaymentService = require('../../src/services/plan-payment.service');

const BANK_ENV = {
  BANK_TRANSFER_BANK_NAME: 'Test Bank',
  BANK_TRANSFER_ACCOUNT_TITLE: 'GymsEra Test',
  BANK_TRANSFER_ACCOUNT_NUMBER: '000111222333',
};
const today = () => new Date().toISOString().split('T')[0];
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];

describe('P9c D: host plan payment by bank transfer, approved by a platform admin (R-95)', () => {
  let ctx;
  let personas;
  let plan2;
  let jpeg;
  const saved = {};
  const tenantId = () => ctx.tenant1.id;

  const submit = (fields = {}, { persona = 'owner', withProof = true } = {}) => {
    const req = asPersona(persona).post('/host/plan-payments');
    const body = { billingPlanId: plan2.id, billingCycle: 'MONTHLY', ...fields };
    for (const [k, v] of Object.entries(body)) req.field(k, String(v));
    if (withProof) req.attach('proof', jpeg, { filename: 'receipt.jpg', contentType: 'image/jpeg' });
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
    personas = await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    plan2 = await createBillingPlan({ branchCount: 2, monthlyPrice: 2999, annualPrice: 29990, sortOrder: 2 });
    jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg().toBuffer();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await teardownTestDatabases();
  });

  describe('catalog terms: the server decides duration and price per cycle', () => {
    beforeEach(() => resetTenant());

    test('the overview offers each plan with the catalog price and duration per cycle', async () => {
      const res = await asPersona('owner').get('/host/plan-payments');
      expect(res.status).toBe(200);
      const p = res.body.data.plans.find((x) => x.id === plan2.id);
      expect(p.cycles).toEqual([
        { cycle: 'MONTHLY', months: 1, amount: 2999, currency: 'PKR' },
        { cycle: 'YEARLY', months: 12, amount: 29990, currency: 'PKR' },
      ]);
      expect(res.body.data.methods[0]).toMatchObject({ key: 'BANK_TRANSFER', requiresProof: true, available: true });
      expect(res.body.data.methods[0].instructions.accountNumber).toBe('000111222333');
      expect(res.body.data.canSubmit).toBe(true);
    });

    test('a yearly selection: the annual price, and approval grants one year', async () => {
      const sent = await submit({ billingCycle: 'YEARLY' });
      expect(sent.status).toBe(201);
      expect(sent.body.data.request).toMatchObject({ status: 'PENDING', billingCycle: 'YEARLY', amount: '29990.00', currency: 'PKR', hasProof: true });
      expect(sent.body.data.request.proofKey).toBeUndefined();

      const ok = await approve(sent.body.data.request.id);
      expect(ok.status).toBe(200);
      const sub = await TenantSubscription.findByPk(ok.body.data.subscription.id);
      expect(sub).toMatchObject({ platform: 'MANUAL', status: 'ACTIVE', paymentStatus: 'PAID', billingCycle: 'YEARLY', branchCount: 2, billingPlanId: plan2.id });
      expect(String(sub.startDate)).toBe(today());
      expect(String(sub.endDate)).toBe(planPaymentService.addMonths(today(), 12));
      expect(Number(sub.amount)).toBe(29990);
    });

    test('a monthly selection: the monthly price, and approval grants one month', async () => {
      const sent = await submit({ billingCycle: 'MONTHLY' });
      expect(sent.body.data.request.amount).toBe('2999.00');
      const ok = await approve(sent.body.data.request.id);
      const sub = await TenantSubscription.findByPk(ok.body.data.subscription.id);
      expect(String(sub.endDate)).toBe(planPaymentService.addMonths(today(), 1));
      expect(Number(sub.amount)).toBe(2999);
    });

    test('the client cannot send a price, a duration or dates; an unknown cycle is refused', async () => {
      expect((await submit({ amount: 1 })).status).toBe(422);
      expect((await submit({ endDate: '2099-01-01' })).status).toBe(422);
      expect(await PlanPaymentRequest.count()).toBe(0);
      const bad = await submit({ billingCycle: 'WEEKLY' });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('invalid_cycle');
    });

    test('a month from the 31st ends on the last day of the next month, never spills over', () => {
      expect(planPaymentService.addMonths('2027-01-31', 1)).toBe('2027-02-28');
      expect(planPaymentService.addMonths('2028-01-31', 1)).toBe('2028-02-29');
      expect(planPaymentService.addMonths('2027-03-15', 12)).toBe('2028-03-15');
    });
  });

  describe('the flow and its statuses', () => {
    beforeEach(() => resetTenant());

    test('the receipt is required; one pending request at a time; the host sees PENDING', async () => {
      const none = await submit({}, { withProof: false });
      expect(none.status).toBe(422);
      expect(none.body.code).toBe('proof_required');

      const first = await submit();
      expect(first.status).toBe(201);
      const second = await submit();
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('plan_payment_pending');

      const view = await asPersona('owner').get('/host/plan-payments');
      expect(view.body.data.pending).toMatchObject({ id: first.body.data.request.id, status: 'PENDING' });
      expect(view.body.data.canSubmit).toBe(false);
    });

    test('rejected: a reason is required, the host sees it and can pay again', async () => {
      const sent = await submit();
      const id = sent.body.data.request.id;
      const noReason = await asPersona('platformAdmin').post(`/admin/plan-payments/${id}/reject`, { reason: '' });
      expect(noReason.status).toBe(422);
      const rej = await asPersona('platformAdmin').post(`/admin/plan-payments/${id}/reject`, { reason: 'Amount not received' });
      expect(rej.status).toBe(200);

      const view = await asPersona('owner').get('/host/plan-payments');
      expect(view.body.data.requests[0]).toMatchObject({ status: 'REJECTED', rejectionReason: 'Amount not received' });
      expect(view.body.data.canSubmit).toBe(true);
      expect((await entitling()).length).toBe(0); // nothing granted
      expect((await approve(id)).status).toBe(409); // a rejected request cannot be approved later
    });

    test('approved twice: the second answers 409 and nothing is granted twice', async () => {
      const sent = await submit();
      const id = sent.body.data.request.id;
      expect((await approve(id)).status).toBe(200);
      const again = await approve(id);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('plan_payment_not_pending');
      expect((await entitling()).length).toBe(1);
      expect(await PlatformAuditLog.count({ where: { action: 'PLAN_PAYMENT_APPROVED', targetId: id } })).toBe(1);
    });

    test('a running PAID bank-transfer plan is extended from its end date; the old row is closed, never two active', async () => {
      const oldEnd = plusDays(10);
      await resetTenant([{ platform: 'MANUAL', branchCount: 1, status: 'ACTIVE', paymentStatus: 'PAID', autoRenew: false, startDate: plusDays(-20), endDate: oldEnd, externalOriginalTransactionId: 'old-manual-1' }]);
      const sent = await submit();
      const ok = await approve(sent.body.data.request.id);
      const sub = await TenantSubscription.findByPk(ok.body.data.subscription.id);
      expect(String(sub.endDate)).toBe(planPaymentService.addMonths(oldEnd, 1));
      const rows = await entitling();
      expect(rows.map((r) => r.id)).toEqual([sub.id]);
      const old = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: 'old-manual-1' } });
      expect(old.status).toBe('CANCELLED');
      expect(old.statusNote).toMatch(/Replaced by a new bank transfer subscription/);
      expect(old.statusNote).not.toMatch(/undefined/);
    });

    test('an unpaid plan (pay-later grace) is not extended: the period starts on the approval day', async () => {
      await resetTenant([{ platform: 'MANUAL', branchCount: 1, status: 'GRACE', paymentStatus: 'PENDING', autoRenew: false, endDate: plusDays(12), externalOriginalTransactionId: `pay-later:${'11111111-1111-4111-8111-111111111111'}` }]);
      const sent = await submit();
      const ok = await approve(sent.body.data.request.id);
      const sub = await TenantSubscription.findByPk(ok.body.data.subscription.id);
      expect(String(sub.endDate)).toBe(planPaymentService.addMonths(today(), 1));
    });

    test('a lapsed plan: approval grants from today and the plan entitles again', async () => {
      await resetTenant([{ platform: 'MANUAL', branchCount: 1, status: 'EXPIRED', paymentStatus: 'PAID', autoRenew: false, endDate: plusDays(-3), externalOriginalTransactionId: 'lapsed-1' }]);
      const before = await asPersona('owner').get('/host/subscription/current');
      expect(before.body.data.entitled).toBe(false);
      const sent = await submit();
      await approve(sent.body.data.request.id);
      const after = await asPersona('owner').get('/host/subscription/current');
      expect(after.body.data).toMatchObject({ entitled: true, platform: 'MANUAL', branchCount: 2, status: 'ACTIVE' });
    });
  });

  describe('who may do what', () => {
    beforeEach(() => resetTenant());

    test('owner only: team members and platform admins cannot submit; other tenants never see it', async () => {
      for (const persona of ['orgAdmin', 'manager', 'frontDesk', 'member']) {
        expect((await submit({}, { persona })).status).toBe(403);
      }
      expect((await submit({}, { persona: 'platformAdmin' })).status).toBe(403);
      expect((await submit({}, { persona: 'anonymous' })).status).toBe(401);

      const sent = await submit();
      expect(sent.status).toBe(201);
      const other = await asPersona('otherTenantOwner').get('/host/plan-payments');
      expect(other.status).toBe(200);
      expect(other.body.data.requests.map((r) => r.id)).not.toContain(sent.body.data.request.id);
    });

    test('the receipt opens for a platform admin only (audited), never on a host route', async () => {
      const sent = await submit();
      const id = sent.body.data.request.id;
      const res = await asPersona('platformAdmin').get(`/admin/plan-payments/${id}/proof`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      expect(await PlatformAuditLog.count({ where: { action: 'PLAN_PAYMENT_PROOF_ACCESSED', targetId: id } })).toBe(1);
      for (const persona of ['owner', 'otherTenantOwner', 'manager']) {
        expect((await asPersona(persona).get(`/admin/plan-payments/${id}/proof`)).status).toBe(403);
        expect((await asPersona(persona).post(`/admin/plan-payments/${id}/approve`, {})).status).toBe(403);
      }
    });

    test('no platform bank account configured: offered as unavailable, and submit answers 409', async () => {
      const keep = process.env.BANK_TRANSFER_ACCOUNT_NUMBER;
      delete process.env.BANK_TRANSFER_ACCOUNT_NUMBER;
      try {
        const view = await asPersona('owner').get('/host/plan-payments');
        expect(view.body.data.methods[0].available).toBe(false);
        expect(view.body.data.canSubmit).toBe(false);
        const res = await submit();
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('method_unavailable');
      } finally {
        process.env.BANK_TRANSFER_ACCOUNT_NUMBER = keep;
      }
    });
  });

  describe.each([
    ['IOS', 'Apple'],
    ['ANDROID', 'Google Play'],
  ])('store plan rules — %s', (platform, storeName) => {
    const storeRow = (overrides) => ({
      platform, branchCount: 1, billingPlanId: null, externalOriginalTransactionId: `${platform}-orig-${Math.random().toString(36).slice(2)}`,
      paymentStatus: 'PAID', startDate: plusDays(-5), endDate: plusDays(25), ...overrides,
    });

    test(`refused while the ${storeName} plan entitles and renews (form hidden, POST and approval 409)`, async () => {
      await resetTenant();
      // A request sent before the store purchase cannot be approved afterwards either.
      const early = await submit();
      expect(early.status).toBe(201);
      await createTenantSubscription(tenantId(), storeRow({ status: 'ACTIVE', autoRenew: true }));

      const view = await asPersona('owner').get('/host/plan-payments');
      expect(view.body.data.blocked).toMatchObject({ code: 'store_plan_active', platform });
      expect(view.body.data.blocked.message).toContain(storeName);
      expect(view.body.data.canSubmit).toBe(false);

      await PlanPaymentRequest.destroy({ where: { id: early.body.data.request.id } });
      const res = await submit();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('store_plan_active');

      const pending = await PlanPaymentRequest.create({
        tenantId: tenantId(), requestedByUserId: personas.owner.user.id,
        billingPlanId: plan2.id, branchCount: 2, billingCycle: 'MONTHLY', amount: 2999, currency: 'PKR',
      });
      const ap = await approve(pending.id);
      expect(ap.status).toBe(409);
      expect(ap.body.code).toBe('store_plan_active');
      expect((await entitling()).map((r) => r.platform)).toEqual([platform]);
    });

    test(`the same while the ${storeName} plan is in billing grace and renewing`, async () => {
      await resetTenant([storeRow({ status: 'GRACE', autoRenew: true })]);
      expect((await submit()).status).toBe(409);
    });

    test(`allowed at once when the ${storeName} plan was cancelled (auto-renew off); approval closes it with no action needed`, async () => {
      await resetTenant([storeRow({ status: 'ACTIVE', autoRenew: false, externalOriginalTransactionId: `${platform}-cancelled` })]);
      const view = await asPersona('owner').get('/host/plan-payments');
      expect(view.body.data.blocked).toBeNull();
      expect(view.body.data.canSubmit).toBe(true);

      const sent = await submit();
      expect(sent.status).toBe(201);
      const ok = await approve(sent.body.data.request.id);
      expect(ok.status).toBe(200);

      const rows = await entitling();
      expect(rows.map((r) => r.platform)).toEqual(['MANUAL']);
      const store = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: `${platform}-cancelled` } });
      expect(store.status).toBe('CANCELLED');
      expect(store.statusNote).toMatch(new RegExp(`Auto-renew was already off at ${storeName} — no action needed`));
      expect(store.duplicateBilling).toBeFalsy();
      // Paid store days are not lost: the bank-transfer period starts at the store plan's end.
      const sub = await TenantSubscription.findByPk(ok.body.data.subscription.id);
      expect(String(sub.endDate)).toBe(planPaymentService.addMonths(plusDays(25), 1));
    });

    test(`allowed at once when the ${storeName} plan has ended (EXPIRED, REVOKED)`, async () => {
      for (const status of ['EXPIRED', 'REVOKED']) {
        await resetTenant([storeRow({ status, autoRenew: false, endDate: plusDays(-1) })]);
        const sent = await submit();
        expect(sent.status).toBe(201);
        const ok = await approve(sent.body.data.request.id);
        const sub = await TenantSubscription.findByPk(ok.body.data.subscription.id);
        expect(String(sub.endDate)).toBe(planPaymentService.addMonths(today(), 1));
      }
    });
  });
});
