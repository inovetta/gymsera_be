/**
 * Phase 7 P9c item E — channel matrix (runbook: docs/runbooks/billing-channels.md).
 *
 * Every plan, whatever the channel, is written by applyVerifiedSubscription (Apple / Google sync
 * and webhooks after the store verified it; a bank transfer after an admin approved it). These
 * tests drive that path the way each channel does and check, after every step, that the tenant has
 * exactly ONE entitling row, what the host is told, and that the duplicate_billing marker appears
 * when a store keeps billing a superseded plan.
 *
 * Already covered elsewhere (not repeated): purchase-intent block and same-store upgrade intent
 * (bill-07-09-intent-and-duplicate.test.js), Apple deferred downgrade with the keep-list
 * (billing-downgrade.test.js), store → bank refusal and cancelled/ended store → bank for Apple and
 * Google (p9c-plan-payment.test.js).
 */
const sharp = require('sharp');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { createBillingPlan, createTenantSubscription } = require('../harness/factories');
const { TenantSubscription, PlanPaymentRequest } = require('../../src/models/platform');
const { ENTITLING_STATUSES } = require('../../src/services/subscription-quota.service');
const { applyVerifiedSubscription } = require('../../src/services/subscription-migration.service');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];
const STORE = { IOS: 'Apple', ANDROID: 'Google Play' };

describe('P9c E: channel matrix — one entitlement, clear messages, duplicate_billing marker', () => {
  let ctx;
  let plan1;
  let plan3;
  let jpeg;
  let seq = 0;
  const saved = {};
  const tenantId = () => ctx.tenant1.id;

  const entitling = () => TenantSubscription.findAll({ where: { tenantId: tenantId(), status: ENTITLING_STATUSES } });
  const expectOneEntitlement = async (platform) => {
    const rows = await entitling();
    expect(rows.map((r) => r.platform)).toEqual([platform]);
    return rows[0];
  };
  const reset = async (rows = []) => {
    await PlanPaymentRequest.destroy({ where: {} });
    await TenantSubscription.destroy({ where: { tenantId: tenantId() } });
    await ctx.tenant1Db.models.Branch.update({ billingLockedAt: null, billingLockReason: null }, { where: {} });
    for (const r of rows) await createTenantSubscription(tenantId(), r);
  };
  /** What a verified store purchase / renewal writes (apple-billing / google-play-billing → this). */
  const storeSync = (platform, origId, plan, overrides = {}, opts = {}) =>
    applyVerifiedSubscription(
      tenantId(),
      {
        platform,
        externalOriginalTransactionId: origId,
        externalTransactionId: `${origId}-tx-${++seq}`,
        billingPlanId: plan.id,
        branchCount: plan.branchCount,
        productId: `p.${plan.branchCount}`,
        startDate: day(0),
        endDate: day(30),
        amount: plan.monthlyPrice,
        currency: 'PKR',
        billingCycle: 'MONTHLY',
        status: 'ACTIVE',
        autoRenew: true,
        paymentStatus: 'PAID',
        lastVerifiedAt: new Date(),
        ...overrides,
      },
      { idempotencyPrefix: `test:${origId}:${seq}`, logLabel: 'Test', ...opts }
    );
  const bankPay = async (plan, cycle = 'MONTHLY') => {
    const req = asPersona('owner').post('/host/plan-payments');
    req.field('billingPlanId', plan.id).field('billingCycle', cycle);
    req.attach('proof', jpeg, { filename: 'r.jpg', contentType: 'image/jpeg' });
    const sent = await req;
    expect(sent.status).toBe(201);
    const ok = await asPersona('platformAdmin').post(`/admin/plan-payments/${sent.body.data.request.id}/approve`, {});
    expect(ok.status).toBe(200);
    return ok.body.data.subscription;
  };
  const current = async () => (await asPersona('owner').get('/host/subscription/current')).body.data;
  const intent = async (platform, plan) =>
    (await asPersona('owner').post('/billing/purchase-intent', { planId: plan.id, platform })).body.data;

  beforeAll(async () => {
    for (const [k, v] of Object.entries({ BANK_TRANSFER_ACCOUNT_NUMBER: '000111', BANK_TRANSFER_BANK_NAME: 'Test Bank' })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const h = await setupTestDatabases();
    await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    plan1 = await createBillingPlan({ branchCount: 1, monthlyPrice: 2000, annualPrice: 20000, sortOrder: 1 });
    plan3 = await createBillingPlan({ branchCount: 3, monthlyPrice: 4990, annualPrice: 49900, sortOrder: 3 });
    jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 1, b: 1 } } }).jpeg().toBuffer();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await teardownTestDatabases();
  });

  test('IOS → IOS upgrade: the same subscription (originalTransactionId) changes plan at once, one row', async () => {
    await reset();
    await storeSync('IOS', 'IOS-up', plan1);
    await storeSync('IOS', 'IOS-up', plan3);
    const row = await expectOneEntitlement('IOS');
    expect(row.branchCount).toBe(3);
    expect(await TenantSubscription.count({ where: { tenantId: tenantId() } })).toBe(1);
    expect((await current()).duplicateBilling).toBe(false);
  });

  test('ANDROID → ANDROID upgrade: a new purchase token linked to the old one; the old row is closed, no action needed', async () => {
    await reset();
    await storeSync('ANDROID', 'ANDROID-up-1', plan1);
    // Google answers linkedPurchaseToken = the old token (google-play-billing.service.js → supersededExternalId).
    await storeSync('ANDROID', 'ANDROID-up-2', plan3, {}, { supersededExternalId: 'ANDROID-up-1' });
    const row = await expectOneEntitlement('ANDROID');
    expect(row.branchCount).toBe(3);
    const old = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: 'ANDROID-up-1' } });
    expect(old.status).toBe('CANCELLED');
    expect(old.statusNote).toMatch(/no action needed/);
    expect((await current()).duplicateBilling).toBe(false);
  });

  test.each([
    ['IOS', 'ANDROID'],
    ['ANDROID', 'IOS'],
  ])('%s then %s: the app is told to cancel first; a purchase that still arrives supersedes, and a later store renewal is marked duplicate_billing', async (first, second) => {
    await reset();
    await storeSync(first, `${first}-x`, plan1);

    // 1. The app asks before buying: blocked while the first store renews, with its manage link.
    const asked = await intent(second, plan3);
    expect(asked).toMatchObject({ action: 'blocked', reason: 'active_subscription_other_provider', currentPlatform: first });

    // 2. A purchase that arrives anyway (old app, second device) is the one entitlement; the first is
    //    superseded with an instruction to cancel it at its store.
    await storeSync(second, `${second}-x`, plan3);
    await expectOneEntitlement(second);
    const old = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: `${first}-x` } });
    expect(old.status).toBe('PENDING_CANCEL');
    expect(old.statusNote).toMatch(new RegExp(`cancel the ${STORE[first]} subscription yourself`));

    // 3. The first store renews anyway: never resurrected; marked duplicate_billing; the host is told.
    await storeSync(first, `${first}-x`, plan1, { startDate: day(30), endDate: day(60) });
    await expectOneEntitlement(second);
    expect((await old.reload()).duplicateBilling).toBe(true);
    const view = await current();
    expect(view).toMatchObject({ platform: second, duplicateBilling: true, duplicateBillingPlatform: first });
    expect(view.duplicateBillingManageUrl).toMatch(first === 'IOS' ? /apps\.apple\.com/ : /play\.google\.com/);
  });

  test.each(['IOS', 'ANDROID'])('bank transfer then %s: allowed; the bank plan is closed with "no action needed", one entitlement, no duplicate marker', async (platform) => {
    await reset();
    await bankPay(plan1);
    const asked = await intent(platform, plan3);
    expect(asked.action).not.toBe('blocked');
    await storeSync(platform, `${platform}-after-bank`, plan3);
    await expectOneEntitlement(platform);
    const bank = await TenantSubscription.findOne({ where: { tenantId: tenantId(), platform: 'MANUAL' } });
    expect(bank.status).toBe('CANCELLED');
    expect(bank.statusNote).toMatch(new RegExp(`Replaced by a new ${STORE[platform]} subscription .* no action needed`));
    expect((await current()).duplicateBilling).toBe(false);
  });

  test('bank transfer then bank transfer (renewal): extends, one entitlement', async () => {
    await reset();
    const first = await bankPay(plan1);
    const second = await bankPay(plan1);
    await expectOneEntitlement('MANUAL');
    expect(String(second.endDate) > String(first.endDate)).toBe(true);
  });

  describe.each(['IOS', 'ANDROID', 'BANK'])('expired, then renewed by %s', (channel) => {
    test('the lapse is shown, branches locked; the renewal entitles again and unlocks them', async () => {
      await reset([{ platform: 'IOS', branchCount: 1, status: 'EXPIRED', autoRenew: false, paymentStatus: 'PAID', startDate: day(-40), endDate: day(-10), externalOriginalTransactionId: `expired-${channel}` }]);
      await ctx.tenant1Db.models.Branch.update({ billingLockedAt: new Date(Date.now() - 86400000), billingLockReason: 'lapsed' }, { where: { id: ctx.branch1.id } });

      const before = await current();
      expect(before.entitled).toBe(false);
      expect(before.lapse).toBeTruthy();
      expect((await entitling()).length).toBe(0);

      if (channel === 'BANK') {
        const view = (await asPersona('owner').get('/host/plan-payments')).body.data;
        expect(view.blocked).toBeNull(); // an ended store plan never blocks
        await bankPay(plan1);
      } else {
        expect((await intent(channel, plan1)).action).not.toBe('blocked');
        await storeSync(channel, `${channel}-renewed`, plan1);
      }

      await expectOneEntitlement(channel === 'BANK' ? 'MANUAL' : channel);
      const after = await current();
      expect(after.entitled).toBe(true);
      const branch = await ctx.tenant1Db.models.Branch.findByPk(ctx.branch1.id);
      expect(branch.billingLockedAt).toBeNull();
    });
  });
});
