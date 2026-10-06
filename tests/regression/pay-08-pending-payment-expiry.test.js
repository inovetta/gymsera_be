/**
 * PAY-08 (non-gateway part) — online/member pending payments.
 *
 *  - A payment a member starts (checkout, upgrade, renewal) gets a deadline
 *    (MEMBER_PAYMENT_PENDING_TTL_HOURS, default 168 h). Staff-recorded ones get none.
 *  - The daily job marks overdue ones EXPIRED, only when
 *    MEMBER_PAYMENT_EXPIRY_ENABLED=true. Nothing is activated: an unpaid
 *    first checkout ends CANCELLED; an upgrade/renewal leaves the old plan.
 *  - An EXPIRED payment can never be verified.
 *  - No member/client request can make a payment COMPLETED; no method
 *    auto-completes for a recorder without the direct grant.
 *
 * Rows are created through the real services and models (no raw INSERTs).
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { createUser } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');
const { UserGymMembership } = require('../../src/models/platform');
const subscriptionService = require('../../src/services/subscription.service');
const paymentService = require('../../src/services/payment.service');
const { runExpiryCheck } = require('../../src/jobs/subscription-expiry.cron');

describe('PAY-08: pending member payments expire; only the verified server path completes', () => {
  let personas;
  let ctx;
  let basic;
  let premium;
  let n = 0;
  const savedEnv = {};

  const server = () => require('../harness/personas').personaManager.server;
  const member = async () => {
    n += 1;
    const user = await createUser({ role: 'MEMBER', email: `pay08.m${n}@gymsera.test`, fullName: `Pay08 Member ${n}` });
    const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true });
    const { subscription, payment, invoice } = await subscriptionService.subscribe(user.id, {
      planId: basic.id, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id,
    });
    return { user, token, subscription, payment, invoice };
  };
  const as = (token) => ({
    post: (path, body, headers = {}) => {
      const req = request(server()).post(`/api/v1${path}`)
        .set('Authorization', `Bearer ${token}`).set('Accept', 'application/json')
        .set('X-Tenant-Id', ctx.tenant1.id);
      for (const [k, v] of Object.entries(headers)) req.set(k, v);
      return req.send(body);
    },
  });
  const later = (hours) => new Date(Date.now() + hours * 3600 * 1000);
  const models = () => ctx.tenant1Db.models;

  beforeAll(async () => {
    for (const k of ['MEMBER_PAYMENT_PENDING_TTL_HOURS', 'MEMBER_PAYMENT_EXPIRY_ENABLED']) savedEnv[k] = process.env[k];
    delete process.env.MEMBER_PAYMENT_PENDING_TTL_HOURS;
    delete process.env.MEMBER_PAYMENT_EXPIRY_ENABLED;

    const h = await setupTestDatabases();
    personas = await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    basic = await models().MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'Pay08 Basic',
      price: '1200.00', durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
    });
    premium = await models().MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'Pay08 Premium',
      price: '1800.00', durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await teardownTestDatabases();
  });

  test('1. member checkout gets a 168 h deadline by default; the TTL is configurable', async () => {
    const before = Date.now();
    const m = await member();
    const expiresAt = new Date(m.payment.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 168 * 3600 * 1000 - 2000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 168 * 3600 * 1000 + 2000);

    process.env.MEMBER_PAYMENT_PENDING_TTL_HOURS = '2';
    try {
      const m2 = await member();
      expect(new Date(m2.payment.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 2 * 3600 * 1000 + 2000);
    } finally {
      delete process.env.MEMBER_PAYMENT_PENDING_TTL_HOURS;
    }
  });

  test('2. staff-recorded pending payments have no deadline and are never expired', async () => {
    const someone = await createUser({ role: 'MEMBER', email: 'pay08.walkin@gymsera.test', fullName: 'Pay08 Walkin' });
    const { payment } = await paymentService.recordPayment(ctx.tenant1Db, personas.frontDesk.user.id, 'BRANCH_MANAGER', {
      userId: someone.id, branchId: ctx.branch1.id, amount: '500.00', method: 'CASH', paymentFor: 'OTHER',
    }, false);
    expect(payment.status).toBe('PENDING');
    expect(payment.expiresAt == null).toBe(true);

    await paymentService.expireStalePendingPayments(ctx.tenant1Db, { now: later(24 * 365) });
    expect((await models().Payment.findByPk(payment.id)).status).toBe('PENDING');
  });

  test('3. overdue first checkout → payment EXPIRED, membership CANCELLED, invoice CANCELLED, nothing active', async () => {
    const m = await member();
    const res = await paymentService.expireStalePendingPayments(ctx.tenant1Db, { now: later(169) });
    expect(res.expired).toBeGreaterThanOrEqual(1);

    expect((await models().Payment.findByPk(m.payment.id)).status).toBe('EXPIRED');
    const sub = await models().MemberSubscription.findByPk(m.subscription.id);
    expect(sub.status).toBe('CANCELLED');
    expect(sub.qrCode).toBeNull();
    expect((await models().Invoice.findByPk(m.invoice.id)).status).toBe('CANCELLED');
    expect((await UserGymMembership.findOne({ where: { subscriptionId: m.subscription.id } })).status).toBe('CANCELLED');
  });

  test('4. an EXPIRED payment cannot be verified, nor take a proof', async () => {
    const m = await member();
    await paymentService.expireStalePendingPayments(ctx.tenant1Db, { now: later(169) });
    await expect(paymentService.verifyPayment(ctx.tenant1Db, m.payment.id, personas.owner.user.id, null))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(paymentService.uploadPaymentProof(ctx.tenant1Db, m.payment.id, '/uploads/x.jpg'))
      .rejects.toMatchObject({ statusCode: 400 });
    expect((await models().MemberSubscription.findByPk(m.subscription.id)).status).toBe('CANCELLED');
  });

  test('5. a payment with an uploaded proof waits for the host instead of expiring', async () => {
    const m = await member();
    await subscriptionService.uploadSubscriptionProof(m.user.id, m.subscription.id, '/uploads/proof.jpg');
    await paymentService.expireStalePendingPayments(ctx.tenant1Db, { now: later(169) });
    expect((await models().Payment.findByPk(m.payment.id)).status).toBe('PENDING');
    expect((await models().MemberSubscription.findByPk(m.subscription.id)).status).toBe('PENDING');
  });

  test('6. overdue upgrade payment → EXPIRED, old plan continues, a new upgrade is allowed', async () => {
    const m = await member();
    await paymentService.verifyPayment(ctx.tenant1Db, m.payment.id, personas.owner.user.id, null);
    const up = await subscriptionService.upgradeSubscription(m.user.id, m.subscription.id, premium.id);
    expect(up.applied).toBe(false);

    await paymentService.expireStalePendingPayments(ctx.tenant1Db, { now: later(169) });
    expect((await models().Payment.findByPk(up.paymentId)).status).toBe('EXPIRED');
    expect((await models().Invoice.findByPk(up.invoiceId)).status).toBe('CANCELLED');
    const sub = await models().MemberSubscription.findByPk(m.subscription.id);
    expect(sub.status).toBe('ACTIVE');
    expect(sub.membershipPlanId).toBe(basic.id);

    const again = await subscriptionService.upgradeSubscription(m.user.id, m.subscription.id, premium.id);
    expect(again.paymentId).not.toBe(up.paymentId);
  });

  test('7. the daily job expires nothing unless MEMBER_PAYMENT_EXPIRY_ENABLED=true', async () => {
    const m = await member();
    const p = await models().Payment.findByPk(m.payment.id);
    await p.update({ expiresAt: new Date(Date.now() - 60 * 1000) });

    await runExpiryCheck();
    expect((await models().Payment.findByPk(m.payment.id)).status).toBe('PENDING');

    process.env.MEMBER_PAYMENT_EXPIRY_ENABLED = 'true';
    try {
      await runExpiryCheck();
    } finally {
      delete process.env.MEMBER_PAYMENT_EXPIRY_ENABLED;
    }
    expect((await models().Payment.findByPk(m.payment.id)).status).toBe('EXPIRED');
    expect((await models().MemberSubscription.findByPk(m.subscription.id)).status).toBe('CANCELLED');
  });

  describe('8. a member/client request can never make a payment COMPLETED', () => {
    let m;
    beforeAll(async () => {
      m = await member();
    });
    const stillPending = async () => {
      const p = await models().Payment.findByPk(m.payment.id);
      expect(p.status).toBe('PENDING');
      expect((await models().MemberSubscription.findByPk(m.subscription.id)).status).toBe('PENDING');
    };

    test('POST /payments as the member (a "callback" claiming ONLINE + COMPLETED) is refused', async () => {
      const res = await as(m.token).post('/payments', {
        userId: m.user.id, branchId: ctx.branch1.id, amount: '1200.00', method: 'ONLINE',
        paymentFor: 'MEMBERSHIP', referenceEntityId: m.subscription.id,
        status: 'COMPLETED', gatewayName: 'ANY', gatewayTransactionId: 'client-says-paid',
      }, { 'Idempotency-Key': `pay08-cb-${Date.now()}` });
      expect([403, 404]).toContain(res.status);
      expect(await models().Payment.count({ where: { gatewayTransactionId: 'client-says-paid' } })).toBe(0);
      await stillPending();
    });

    test('POST /payments/:id/verify and /action verify as the member are refused', async () => {
      const v = await as(m.token).post(`/payments/${m.payment.id}/verify`, {});
      expect([403, 404]).toContain(v.status);
      const a = await as(m.token).post(`/payments/${m.payment.id}/action`, { action: 'verify' });
      expect([403, 404]).toContain(a.status);
      await stillPending();
    });

    test('POST /me/payment-request ignores status/paidAt sent by the client', async () => {
      const res = await as(m.token).post('/me/payment-request', {
        subscriptionId: m.subscription.id, method: 'ONLINE', status: 'COMPLETED', paidAt: new Date().toISOString(),
      });
      expect(res.status).toBe(201);
      expect(res.body.data.payment.status).toBe('PENDING');
      await stillPending();
    });

    test('proof upload does not change the status', async () => {
      await subscriptionService.uploadSubscriptionProof(m.user.id, m.subscription.id, '/uploads/p.jpg');
      await stillPending();
    });
  });

  test('9. no payment method auto-completes for a recorder without the direct grant', async () => {
    const someone = await createUser({ role: 'MEMBER', email: 'pay08.methods@gymsera.test', fullName: 'Pay08 Methods' });
    for (const method of ['CASH', 'BANK_TRANSFER', 'CARD', 'WALLET', 'ONLINE', 'POS']) {
      const { payment } = await paymentService.recordPayment(ctx.tenant1Db, personas.frontDesk.user.id, 'BRANCH_MANAGER', {
        userId: someone.id, branchId: ctx.branch1.id, amount: '100.00', method, paymentFor: 'OTHER',
        gatewayTransactionId: method === 'ONLINE' ? 'gw-claimed' : undefined,
      }, false);
      expect([method, payment.status]).toEqual([method, 'PENDING']);
    }
  });
});
