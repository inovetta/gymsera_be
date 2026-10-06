/**
 * NEW-40 — a member renewing their own membership (POST /subscriptions/:id/renew,
 * the website's Renew button) got a free extension: the subscription was set
 * ACTIVE with a new end date and no payment was created — even for a
 * membership whose first payment was never made.
 *
 * Now: the member path records a PENDING renewal payment at the server price;
 * the extension applies only when that payment is verified. The host approving
 * a staff renewal request still applies at once.
 *
 * Rows are created through the real services and models (no raw INSERTs).
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { createUser } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');
const subscriptionService = require('../../src/services/subscription.service');
const paymentService = require('../../src/services/payment.service');

describe('NEW-40: member self-renew waits for a verified payment', () => {
  let personas;
  let ctx;
  let plan;
  let n = 0;

  const member = async () => {
    n += 1;
    const user = await createUser({ role: 'MEMBER', email: `new40.m${n}@gymsera.test`, fullName: `New40 Member ${n}` });
    const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true });
    const { subscription, payment } = await subscriptionService.subscribe(user.id, {
      planId: plan.id, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id,
    });
    return { user, token, subscription, payment };
  };
  const activeMember = async () => {
    const m = await member();
    await paymentService.verifyPayment(ctx.tenant1Db, m.payment.id, personas.owner.user.id, null);
    const subscription = await ctx.tenant1Db.models.MemberSubscription.findByPk(m.subscription.id);
    return { ...m, subscription };
  };
  const renewAs = (token, subscriptionId) => request(require('../harness/personas').personaManager.server)
    .post(`/api/v1/subscriptions/${subscriptionId}/renew`)
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json')
    .send({});
  const reloadSub = (id) => ctx.tenant1Db.models.MemberSubscription.findByPk(id);

  beforeAll(async () => {
    const h = await setupTestDatabases();
    personas = await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    plan = await ctx.tenant1Db.models.MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'New40 Monthly',
      price: '2000.15', joiningFee: '300.00', durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('1. renew of an active membership → PENDING payment at the plan price; dates unchanged', async () => {
    const m = await activeMember();
    const res = await renewAs(m.token, m.subscription.id);
    expect(res.status).toBe(200);

    const sub = await reloadSub(m.subscription.id);
    expect(sub.endDate).toBe(m.subscription.endDate);
    expect(sub.status).toBe('ACTIVE');

    const pending = await ctx.tenant1Db.models.Payment.findAll({ where: { referenceEntityId: sub.id, status: 'PENDING' } });
    expect(pending).toHaveLength(1);
    expect(String(pending[0].amount)).toBe('2000.15');
  });

  test('2. host verifies the renewal payment → extended by one period from the old end date', async () => {
    const m = await activeMember();
    await renewAs(m.token, m.subscription.id);
    const payment = await ctx.tenant1Db.models.Payment.findOne({ where: { referenceEntityId: m.subscription.id, status: 'PENDING' } });
    await paymentService.verifyPayment(ctx.tenant1Db, payment.id, personas.owner.user.id, null);

    const sub = await reloadSub(m.subscription.id);
    expect(sub.status).toBe('ACTIVE');
    expect(sub.startDate).toBe(m.subscription.endDate);
    expect(sub.endDate > m.subscription.endDate).toBe(true);
  });

  test('3. renew of an EXPIRED membership stays EXPIRED until the payment is verified', async () => {
    const m = await activeMember();
    const sub0 = await reloadSub(m.subscription.id);
    await sub0.update({ status: 'EXPIRED', endDate: '2026-01-31' });

    const res = await renewAs(m.token, m.subscription.id);
    expect(res.status).toBe(200);
    expect((await reloadSub(m.subscription.id)).status).toBe('EXPIRED');

    const payment = await ctx.tenant1Db.models.Payment.findOne({ where: { referenceEntityId: m.subscription.id, status: 'PENDING' } });
    await paymentService.verifyPayment(ctx.tenant1Db, payment.id, personas.owner.user.id, null);
    const sub = await reloadSub(m.subscription.id);
    expect(sub.status).toBe('ACTIVE');
    expect(sub.endDate > '2026-01-31').toBe(true);
  });

  test('4. renew of a membership whose first payment was never made → 409, still PENDING', async () => {
    const m = await member();
    const res = await renewAs(m.token, m.subscription.id);
    expect(res.status).toBe(409);
    expect((await reloadSub(m.subscription.id)).status).toBe('PENDING');
  });

  test('5. a second renew while one awaits verification → 409', async () => {
    const m = await activeMember();
    expect((await renewAs(m.token, m.subscription.id)).status).toBe(200);
    expect((await renewAs(m.token, m.subscription.id)).status).toBe(409);
  });

  test('6. host rejects the renewal payment → nothing is extended', async () => {
    const m = await activeMember();
    await renewAs(m.token, m.subscription.id);
    const payment = await ctx.tenant1Db.models.Payment.findOne({ where: { referenceEntityId: m.subscription.id, status: 'PENDING' } });
    await paymentService.verifyOrRejectPayment(ctx.tenant1Db, payment.id, personas.owner.user.id, 'GYM_HOST', { action: 'reject' });
    const sub = await reloadSub(m.subscription.id);
    expect(sub.endDate).toBe(m.subscription.endDate);
  });

  test('8. an approved staff renewal through the approval engine applies at once', async () => {
    const m = await activeMember();
    const commands = require('../../src/services/commands');
    await commands.get('subscriptions.create').execute({ tenantDb: ctx.tenant1Db }, {
      memberUserId: m.user.id, subscriptionId: m.subscription.id,
    });
    const sub = await reloadSub(m.subscription.id);
    expect(sub.status).toBe('ACTIVE');
    expect(sub.endDate > m.subscription.endDate).toBe(true);
  });

  test('7. host-approved staff renewal still applies at once', async () => {
    const m = await activeMember();
    const result = await subscriptionService.renew(m.user.id, m.subscription.id, plan.id, null, { approvedByHost: true });
    expect(result.subscription.status).toBe('ACTIVE');
    expect(result.subscription.endDate > m.subscription.endDate).toBe(true);
  });
});
