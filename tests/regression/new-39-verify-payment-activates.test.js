/**
 * NEW-39 — verifying a member payment must activate the subscription and mark
 * its invoice PAID.
 *
 * The PAY-02 change (80054e4) renamed `finalAmount` to `finalAmountMinor` in
 * verifyPayment but left two uses of the old name. Every verify of a payment
 * with a referenceEntityId threw `ReferenceError: finalAmount is not defined`
 * right after the payment row was set COMPLETED, so the subscription stayed
 * PENDING, the invoice stayed ISSUED and the caller got a 500.
 *
 * Rows are created through the real services and models (no raw INSERTs).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { UserGymMembership } = require('../../src/models/platform');
const subscriptionService = require('../../src/services/subscription.service');
const paymentService = require('../../src/services/payment.service');

describe('NEW-39: verifyPayment completes the whole member checkout', () => {
  let dbHarness;
  let personas;
  let ctx;
  let plan;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    const { personaManager } = require('../harness/personas');
    ctx = personaManager.context;

    plan = await ctx.tenant1Db.models.MembershipPlan.create({
      gymId: ctx.branch1.gymId,
      branchId: ctx.branch1.id,
      name: 'NEW-39 Monthly',
      price: '3000.10',
      joiningFee: '500.20',
      securityFee: 0,
      durationType: 'MONTHLY',
      durationValue: 1,
      status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('member subscribe → host verify → subscription ACTIVE, invoice PAID, index ACTIVE', async () => {
    const member = personas.member.user;
    const { subscription, payment } = await subscriptionService.subscribe(member.id, {
      planId: plan.id,
      gymListingId: ctx.listing1.id,
      branchId: ctx.branch1.id,
    });
    expect(subscription.status).toBe('PENDING');
    expect(payment.status).toBe('PENDING');
    expect(String(payment.amount)).toBe('3500.30');

    const verified = await paymentService.verifyPayment(
      ctx.tenant1Db, payment.id, personas.owner.user.id, null
    );
    expect(verified.status).toBe('COMPLETED');

    const { MemberSubscription, Invoice } = ctx.tenant1Db.models;
    const sub = await MemberSubscription.findByPk(subscription.id);
    expect(sub.status).toBe('ACTIVE');

    const invoices = await Invoice.findAll({ where: { referenceEntityId: subscription.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].status).toBe('PAID');
    expect(String(invoices[0].totalAmount)).toBe('3500.30');

    const index = await UserGymMembership.findOne({ where: { subscriptionId: subscription.id } });
    expect(index.status).toBe('ACTIVE');
  });

  test('waived joining fee: invoice total equals the verified amount', async () => {
    const { createUser } = require('../harness/factories');
    const member2 = await createUser({ role: 'MEMBER', email: 'new39.m2@gymsera.test', fullName: 'New39 Two' });
    const { subscription, payment } = await subscriptionService.subscribe(member2.id, {
      planId: plan.id,
      gymListingId: ctx.listing1.id,
      branchId: ctx.branch1.id,
    });

    const verified = await paymentService.verifyPayment(
      ctx.tenant1Db, payment.id, personas.owner.user.id, null, true
    );
    expect(String(verified.amount)).toBe('3000.10');

    const invoice = await ctx.tenant1Db.models.Invoice.findOne({ where: { referenceEntityId: subscription.id } });
    expect(invoice.status).toBe('PAID');
    expect(String(invoice.totalAmount)).toBe('3000.10');
  });
});
