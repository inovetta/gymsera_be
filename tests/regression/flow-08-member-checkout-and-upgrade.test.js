/**
 * FLOW-08 (non-gateway part) — member checkout and plan upgrade.
 *
 *  - An upgrade keeps the old plan until its payment is verified (or the host
 *    approves a staff upgrade request). Reject → the old plan simply continues.
 *  - Money is integer minor units; the client never sets a price
 *    (POST /me/payment-request used to store the client's `amount`).
 *  - Walk-in enrollment no longer sums prices with parseFloat.
 *
 * Rows are created through the real services and models (no raw INSERTs).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { createUser } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');
const { UserGymMembership } = require('../../src/models/platform');
const subscriptionService = require('../../src/services/subscription.service');
const paymentService = require('../../src/services/payment.service');
const gymService = require('../../src/services/gym.service');

describe('FLOW-08: member checkout and upgrade wait for verified money', () => {
  let personas;
  let ctx;
  let basic;
  let premium;
  let n = 0;

  const newMember = async () => {
    n += 1;
    const user = await createUser({ role: 'MEMBER', email: `flow08.m${n}@gymsera.test`, fullName: `Flow08 Member ${n}` });
    const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true });
    return { user, token };
  };

  const activeMember = async () => {
    const m = await newMember();
    const { subscription, payment } = await subscriptionService.subscribe(m.user.id, {
      planId: basic.id, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id,
    });
    await paymentService.verifyPayment(ctx.tenant1Db, payment.id, personas.owner.user.id, null);
    return { ...m, subscription };
  };

  const callAs = (token) => {
    const request = require('supertest');
    const server = require('../harness/personas').personaManager.server;
    return {
      post: (path, body) => request(server).post(`/api/v1${path}`)
        .set('Authorization', `Bearer ${token}`).set('Accept', 'application/json').send(body),
    };
  };

  beforeAll(async () => {
    const h = await setupTestDatabases();
    personas = await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    const { MembershipPlan } = ctx.tenant1Db.models;
    basic = await MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'Flow08 Basic',
      price: '1000.05', durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
    });
    premium = await MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'Flow08 Premium',
      price: '1500.10', durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('1. member upgrade does NOT switch the plan; it creates a server-priced PENDING payment', async () => {
    const m = await activeMember();
    const res = await callAs(m.token).post(`/member/subscriptions/${m.subscription.id}/upgrade`, { newPlanId: premium.id });
    expect(res.status).toBe(200);
    expect(res.body.data.amountToPay).toBe('500.05');
    expect(res.body.data.applied).toBe(false);

    const { MemberSubscription, Payment } = ctx.tenant1Db.models;
    const sub = await MemberSubscription.findByPk(m.subscription.id);
    expect(sub.membershipPlanId).toBe(basic.id);
    expect(sub.status).toBe('ACTIVE');
    const index = await UserGymMembership.findOne({ where: { subscriptionId: m.subscription.id } });
    expect(index.planName).toBe('Flow08 Basic');

    const payment = await Payment.findByPk(res.body.data.paymentId);
    expect(payment.status).toBe('PENDING');
    expect(String(payment.amount)).toBe('500.05');
  });

  test('2. a second upgrade while one is awaiting verification → 409, no second payment', async () => {
    const m = await activeMember();
    const first = await callAs(m.token).post(`/member/subscriptions/${m.subscription.id}/upgrade`, { newPlanId: premium.id });
    expect(first.status).toBe(200);
    const second = await callAs(m.token).post(`/member/subscriptions/${m.subscription.id}/upgrade`, { newPlanId: premium.id });
    expect(second.status).toBe(409);
    const count = await ctx.tenant1Db.models.Payment.count({ where: { referenceEntityId: m.subscription.id, status: 'PENDING' } });
    expect(count).toBe(1);
  });

  test('3. host verifies the upgrade payment → the new plan applies (subscription and index)', async () => {
    const m = await activeMember();
    const res = await callAs(m.token).post(`/member/subscriptions/${m.subscription.id}/upgrade`, { newPlanId: premium.id });
    await paymentService.verifyPayment(ctx.tenant1Db, res.body.data.paymentId, personas.owner.user.id, null);

    const sub = await ctx.tenant1Db.models.MemberSubscription.findByPk(m.subscription.id);
    expect(sub.membershipPlanId).toBe(premium.id);
    expect(sub.status).toBe('ACTIVE');
    const index = await UserGymMembership.findOne({ where: { subscriptionId: m.subscription.id } });
    expect(index.planName).toBe('Flow08 Premium');
  });

  test('4. host rejects the upgrade payment → the old plan simply continues', async () => {
    const m = await activeMember();
    const res = await callAs(m.token).post(`/member/subscriptions/${m.subscription.id}/upgrade`, { newPlanId: premium.id });
    await paymentService.verifyOrRejectPayment(ctx.tenant1Db, res.body.data.paymentId, personas.owner.user.id, 'GYM_HOST', {
      action: 'reject', rejectedReason: 'not received',
    });
    const sub = await ctx.tenant1Db.models.MemberSubscription.findByPk(m.subscription.id);
    expect(sub.membershipPlanId).toBe(basic.id);
    expect(sub.status).toBe('ACTIVE');
  });

  test('5. host-approved staff upgrade applies at once (the "host approves it" path)', async () => {
    const m = await activeMember();
    const result = await subscriptionService.upgradeSubscription(m.user.id, m.subscription.id, premium.id, { approvedByHost: true });
    expect(result.applied).toBe(true);
    const sub = await ctx.tenant1Db.models.MemberSubscription.findByPk(m.subscription.id);
    expect(sub.membershipPlanId).toBe(premium.id);
    const payment = await ctx.tenant1Db.models.Payment.findByPk(result.paymentId);
    expect(payment.pendingChangeJson).toBeNull();
  });

  test('5b. an approved staff upgrade through the approval engine applies at once', async () => {
    const m = await activeMember();
    const commands = require('../../src/services/commands');
    await commands.get('subscriptions.plan.change').execute({ tenantDb: ctx.tenant1Db }, {
      memberUserId: m.user.id, subscriptionId: m.subscription.id, newPlanId: premium.id, isUpgrade: true,
    });
    const sub = await ctx.tenant1Db.models.MemberSubscription.findByPk(m.subscription.id);
    expect(sub.membershipPlanId).toBe(premium.id);
  });

  test('6. upgrading a membership that was never paid → 409', async () => {
    const m = await newMember();
    const { subscription } = await subscriptionService.subscribe(m.user.id, {
      planId: basic.id, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id,
    });
    const res = await callAs(m.token).post(`/member/subscriptions/${subscription.id}/upgrade`, { newPlanId: premium.id });
    expect(res.status).toBe(409);
  });

  test('7. POST /me/payment-request keeps the server price whatever amount the client sends', async () => {
    const m = await newMember();
    const { subscription, payment } = await subscriptionService.subscribe(m.user.id, {
      planId: basic.id, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id,
    });
    expect(String(payment.amount)).toBe('1000.05');

    const res = await callAs(m.token).post('/me/payment-request', {
      subscriptionId: subscription.id, method: 'BANK_TRANSFER', amount: 1.0,
    });
    expect(res.status).toBe(201);
    expect(String(res.body.data.payment.amount)).toBe('1000.05');
    const stored = await ctx.tenant1Db.models.Payment.findByPk(payment.id);
    expect(String(stored.amount)).toBe('1000.05');
  });

  test('8. payment request after a rejected first payment → new payment at the server price', async () => {
    const m = await newMember();
    const { subscription, payment } = await subscriptionService.subscribe(m.user.id, {
      planId: basic.id, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id,
    });
    await paymentService.verifyOrRejectPayment(ctx.tenant1Db, payment.id, personas.owner.user.id, 'GYM_HOST', { action: 'reject' });

    const res = await callAs(m.token).post('/me/payment-request', {
      subscriptionId: subscription.id, method: 'BANK_TRANSFER', amount: 5,
    });
    expect(res.status).toBe(201);
    expect(String(res.body.data.payment.amount)).toBe('1000.05');
  });

  test('9. payment request for an active membership with nothing due → 409 (no free-floating payment)', async () => {
    const m = await activeMember();
    const res = await callAs(m.token).post('/me/payment-request', {
      subscriptionId: m.subscription.id, method: 'BANK_TRANSFER', amount: 10,
    });
    expect(res.status).toBe(409);
  });

  test('10. walk-in enrollment totals are exact (no float sum)', async () => {
    const { MembershipPlan } = ctx.tenant1Db.models;
    const cents = await MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'Flow08 Cents',
      price: '0.10', joiningFee: '0.20', securityFee: 0, durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
    });
    const enrolled = await gymService.enrollMember(
      ctx.tenant1Db,
      ctx.tenant1.id,
      { fullName: 'Walk In Cents', email: 'flow08.walkin@gymsera.test', phone: '+923001110808', branchId: ctx.branch1.id, planId: cents.id, paymentMethod: 'CASH' },
      { role: 'GYM_HOST', id: personas.owner.user.id },
      null
    );
    expect(String(enrolled.payment.amount)).toBe('0.30');
    expect(String(enrolled.invoice.totalAmount)).toBe('0.30');
  });
});
