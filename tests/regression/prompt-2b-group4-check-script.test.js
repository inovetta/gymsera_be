/**
 * Read-only check script for Prompt 2B group 4 (rule 5): runs against databases
 * built by the real migration runners, finds every seeded legacy shape, and
 * changes nothing (CHECKSUM TABLE before/after, so updates are caught too).
 *
 * Legacy shapes are produced through the real services/models, the way the
 * old code left them.
 */
const { QueryTypes } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { createUser } = require('../harness/factories');
const subscriptionService = require('../../src/services/subscription.service');
const paymentService = require('../../src/services/payment.service');
const { runGroup4Check } = require('../../src/scripts/gymsera-prompt-2b-group4-check');

describe('gymsera-prompt-2b-group4-check.js (read-only)', () => {
  let h;
  let personas;
  let ctx;
  let basic;
  let premium;
  const ids = {};

  const subscribe = async (tag) => {
    const user = await createUser({ role: 'MEMBER', email: `g4check.${tag}@gymsera.test`, fullName: `G4 ${tag}` });
    const r = await subscriptionService.subscribe(user.id, { planId: basic.id, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id });
    return { user, ...r };
  };

  beforeAll(async () => {
    h = await setupTestDatabases();
    personas = await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    const { MembershipPlan, Payment } = ctx.tenant1Db.models;
    basic = await MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'G4 Basic',
      price: '1000.00', durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
    });
    premium = await MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'G4 Premium',
      price: '1500.00', durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
    });

    // NEW-39: payment COMPLETED, membership left PENDING (old verify crashed after the payment update)
    const a = await subscribe('new39');
    await a.payment.update({ status: 'COMPLETED', paidAt: new Date() });
    ids.new39 = a.payment.id;

    // FLOW-08: plan switched immediately, upgrade payment still PENDING (old upgradeSubscription)
    const b = await subscribe('flow08');
    await paymentService.verifyPayment(ctx.tenant1Db, b.payment.id, personas.owner.user.id, null);
    const upg = await Payment.create({
      userId: b.user.id, paymentFor: 'MEMBERSHIP', referenceEntityId: b.subscription.id, branchId: ctx.branch1.id,
      method: 'CASH', amount: '500.00', currency: 'PKR', status: 'PENDING', notes: 'Upgrade to G4 Premium',
    });
    await (await ctx.tenant1Db.models.MemberSubscription.findByPk(b.subscription.id)).update({ membershipPlanId: premium.id });
    ids.flow08 = upg.id;

    // FLOW-08: member-sent amount stored over the server price (old /me/payment-request)
    const c = await subscribe('client-amount');
    await c.payment.update({ amount: '1.00' });
    ids.clientAmount = c.payment.id;

    // NEW-40: membership ACTIVE with no payment ever completed (old free self-renew of an unpaid one)
    const d = await subscribe('new40');
    await (await ctx.tenant1Db.models.MemberSubscription.findByPk(d.subscription.id)).update({ status: 'ACTIVE' });
    ids.new40 = d.subscription.id;

    // PAY-08: member-started pending payment, no proof, 10 days old
    const e = await subscribe('stale');
    const stale = await Payment.create({
      userId: e.user.id, paymentFor: 'MEMBERSHIP', referenceEntityId: e.subscription.id, branchId: ctx.branch1.id,
      method: 'BANK_TRANSFER', amount: '1000.00', currency: 'PKR', status: 'PENDING',
      createdAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
    });
    ids.stale = stale.id;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  const checksums = async () => {
    const t = await h.tenant1.sequelize.query(
      'CHECKSUM TABLE payments, invoices, member_subscriptions, membership_plans, schema_migrations',
      { type: QueryTypes.SELECT }
    );
    const p = await h.platform.sequelize.query('CHECKSUM TABLE user_gym_memberships, tenants', { type: QueryTypes.SELECT });
    return JSON.stringify([...t, ...p]);
  };

  test('finds every seeded case, prints no personal data, writes nothing', async () => {
    const before = await checksums();
    const logs = [];
    const r = await runGroup4Check({ platformSeq: h.platform.sequelize, logger: (m) => logs.push(m) });
    const after = await checksums();

    expect(after).toBe(before);

    const has = (name, key, id) => r[name].byTenant.some((t) => t.sample.some((row) => row[key] === id));
    expect(has('completedPaymentPendingSubscription', 'paymentId', ids.new39)).toBe(true);
    expect(has('upgradeAppliedBeforePayment', 'paymentId', ids.flow08)).toBe(true);
    expect(has('clientAmountDiffersFromInvoice', 'paymentId', ids.clientAmount)).toBe(true);
    expect(has('activeWithoutCompletedPayment', 'subscriptionId', ids.new40)).toBe(true);
    expect(has('stalePendingMemberPayments', 'paymentId', ids.stale)).toBe(true);
    expect(r.floatMoneyColumns.count).toBe(0);

    const out = logs.join('\n');
    expect(out).not.toMatch(/@gymsera\.test/);
    expect(out).not.toMatch(/G4 (new39|flow08|client-amount|new40|stale)/);
    expect(out).toMatch(/0 writes performed/);
  });

  test('a fresh member checkout (new code) is not reported', async () => {
    const f = await subscribe('fresh');
    const r = await runGroup4Check({ platformSeq: h.platform.sequelize, logger: () => {} });
    const all = Object.values(r).flatMap((x) => x.byTenant.flatMap((t) => t.sample));
    expect(all.some((row) => row.paymentId === f.payment.id || row.subscriptionId === f.subscription.id)).toBe(false);
  });
});
