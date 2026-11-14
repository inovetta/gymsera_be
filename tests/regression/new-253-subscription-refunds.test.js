/**
 * NEW-253 (R-103): refunds on subscription cancellation.
 *
 *  A. Staff cancel with refund: POST /subscriptions/staff/:id/cancel { refund: true, refundAmount?, refundReason? }.
 *     Owner (payments.refund DIRECT): cancel + PAY-07 refund in one transaction. Manager (REQUEST): cancel
 *     now, refund to the approval inbox. Front desk (refund OFF): 403, nothing changes.
 *  B. Member: cancel first, then GET / POST /subscriptions/:id/refund-request; a DIRECT refunder decides
 *     (POST /subscriptions/staff/refund-requests/:requestId/decide).
 *  C. Policy per gym: GET / PUT /subscriptions/staff/refund-policy (off by default; window in days).
 *
 * Covers success, duplicate (sequential and at the same time), wrong tenant, policy off, window closed,
 * not approved, partial and over-the-balance amounts, ledger totals, audit history and device sync.
 */
const request = require('supertest');
const { QueryTypes } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { personaManager } = require('../harness/personas');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { daysFromToday } = require('../harness/dates');
const { UserGymMembership, GymListing } = require('../../src/models/platform');
const registry = require('../../src/services/devices/device-registry.service');
const triggers = require('../../src/services/devices/device-triggers');
const payoutService = require('../../src/services/payout.service');

let app; let personas; let ctx; let db1; let plan; let tenant2Plan; let gym1;
let seq = 0;
const T1 = () => personas.owner.tenantId;

const makeSub = async ({ status = 'ACTIVE', branch = ctx.branch1, db = db1, tenantId = T1(), planRow = plan, user = null, pay = '3000.00', paidDaysAgo = 0 } = {}) => {
  const member = user || await factories.createUser({ email: `n253-${++seq}@new253.test`, fullName: `N253 Member ${seq}`, role: 'MEMBER' });
  const sub = await db.models.MemberSubscription.create({
    userId: member.id, membershipPlanId: planRow.id, branchId: branch.id, status,
    startDate: daysFromToday(-1), endDate: daysFromToday(29),
  });
  const listing = await GymListing.findOne({ where: { tenantId } });
  await UserGymMembership.create({
    userId: member.id, tenantId, gymListingId: listing.id, subscriptionId: sub.id,
    gymName: listing.title, planName: planRow.name, startDate: sub.startDate, endDate: sub.endDate, status,
  });
  let payment = null;
  if (pay) {
    payment = await db.models.Payment.create({
      userId: member.id, branchId: branch.id, paymentFor: 'MEMBERSHIP', referenceEntityId: sub.id,
      amount: pay, currency: 'PKR', method: 'CASH', status: 'COMPLETED',
      paidAt: new Date(Date.now() - paidDaysAgo * 86400000), businessDate: daysFromToday(-paidDaysAgo),
    });
  }
  return { sub, member, payment };
};

const as = (persona, method, path, body, { tenantId = T1(), key = null } = {}) => {
  let r = request(app)[method](`/api/v1/subscriptions/${path}`).set('Authorization', `Bearer ${persona.token}`);
  if (tenantId) r = r.set('X-Tenant-Id', tenantId);
  if (key) r = r.set('Idempotency-Key', key);
  return method === 'get' ? r : r.send(body || {});
};
const cancelWithRefund = (persona, sub, extra = {}, opts) => as(persona, 'post', `staff/${sub.id}/cancel`, { refund: true, ...extra }, opts);
const memberCall = (member, method, sub, body) => as(member, method, `${sub.id}/refund-request`, body, { tenantId: null });
const reversalsOf = (payment) => db1.models.LedgerAdjustment.findAll({ where: { relatedPaymentId: payment.id, type: 'REVERSAL' } });
const setPolicy = (refundsAllowed, refundWindowDays = null) => gym1.update({ refundsAllowed, refundWindowDays });
const expectedSuggestion = (q) => Math.floor((300000 * q.unusedDays) / q.periodDays) / 100;

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  ctx = personaManager.context;
  db1 = ctx.tenant1Db;
  app = await startTestServer();
  plan = await db1.models.MembershipPlan.create({
    gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'Standard 253', price: 3000,
    durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
  });
  tenant2Plan = await ctx.tenant2Db.models.MembershipPlan.create({
    gymId: ctx.branch2.gymId, branchId: ctx.branch2.id, name: 'Tenant2 253', price: 3000,
    durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
  });
  gym1 = (ctx.branch1.gymId && await db1.models.Gym.findByPk(ctx.branch1.gymId)) || await db1.models.Gym.findOne({ order: [['createdAt', 'ASC']] });
  await setPolicy(true);
});

afterAll(async () => {
  await triggers.settled();
  await stopTestServer();
  await teardownTestDatabases();
});

describe('NEW-253 C: refund policy', () => {
  test('off by default on a new gym (migration default), on after PUT by the owner, audited', async () => {
    await setPolicy(false);
    const before = await as(personas.owner, 'get', 'staff/refund-policy');
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ refundsAllowed: false, refundWindowDays: null });

    const put = await as(personas.owner, 'put', 'staff/refund-policy', { branchId: ctx.branch1.id, refundsAllowed: true, refundWindowDays: 30 });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ refundsAllowed: true, refundWindowDays: 30 });
    const audit = await db1.models.AuditLog.findOne({ where: { action: 'refunds.policy.update' }, order: [['createdAt', 'DESC']] });
    expect(audit.actorUserId).toBe(personas.owner.user.id);
    expect(audit.afterState).toMatchObject({ refundsAllowed: true, refundWindowDays: 30 });

    const clear = await as(personas.owner, 'put', 'staff/refund-policy', { branchId: ctx.branch1.id, refundWindowDays: null });
    expect(clear.body.data).toMatchObject({ refundsAllowed: true, refundWindowDays: null });
  });

  test('a manager (refund through approval) and a front desk cannot change it; a bad window is 422', async () => {
    expect((await as(personas.manager, 'put', 'staff/refund-policy', { branchId: ctx.branch1.id, refundsAllowed: false })).status).toBe(403);
    expect((await as(personas.frontDesk, 'put', 'staff/refund-policy', { branchId: ctx.branch1.id, refundsAllowed: false })).status).toBe(403);
    expect((await as(personas.owner, 'put', 'staff/refund-policy', { branchId: ctx.branch1.id, refundWindowDays: 0 })).status).toBe(422);
    expect((await as(personas.owner, 'put', 'staff/refund-policy', { branchId: ctx.branch1.id, refundsAllowed: 'yes' })).status).toBe(422);
    await gym1.reload();
    expect(gym1.refundsAllowed).toBe(true);
  });
});

describe('NEW-253 A: staff cancel with refund', () => {
  beforeEach(() => setPolicy(true));

  test('quote: prorated suggestion, refundable balance and the caller\'s tier', async () => {
    const { sub } = await makeSub();
    const res = await as(personas.owner, 'get', `staff/${sub.id}/refund-quote`);
    expect(res.status).toBe(200);
    const q = res.body.data;
    expect(q).toMatchObject({ eligible: true, refundsAllowed: true, remainingRefundable: '3000.00', currency: 'PKR', method: 'CASH', refundTier: 'DIRECT' });
    expect(q.periodDays).toBe(30);
    expect(q.unusedDays).toBeGreaterThanOrEqual(28);
    expect(Number(q.suggestedAmount)).toBeCloseTo(expectedSuggestion(q), 2);
    expect((await as(personas.manager, 'get', `staff/${sub.id}/refund-quote`)).body.data.refundTier).toBe('REQUEST');
    expect((await as(personas.frontDesk, 'get', `staff/${sub.id}/refund-quote`)).body.data.refundTier).toBe('OFF');
  });

  test('owner: cancel + suggested refund in one go; REVERSAL, payment note, audit, payout balance', async () => {
    const { sub, payment } = await makeSub();
    const quote = (await as(personas.owner, 'get', `staff/${sub.id}/refund-quote`)).body.data;
    const balanceBefore = await payoutService.getPayoutBalance(db1, ctx.branch1.id);

    const res = await cancelWithRefund(personas.owner, sub, { refundReason: 'Moved city' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('EXECUTED');
    expect(res.body.data.subscription.status).toBe('CANCELLED');
    expect(res.body.data.refund).toMatchObject({ status: 'EXECUTED', refundedAmount: quote.suggestedAmount, isFullRefund: false });

    expect((await sub.reload()).status).toBe('CANCELLED');
    const rev = await reversalsOf(payment);
    expect(rev).toHaveLength(1);
    expect(Number(rev[0].amount)).toBeCloseTo(-Number(quote.suggestedAmount), 2);
    expect(rev[0].createdBy).toBe(personas.owner.user.id);
    expect(rev[0].reason).toBe('Moved city');
    await payment.reload();
    expect(payment.status).toBe('COMPLETED');
    expect(payment.notes).toMatch(/Refunded PKR .*: Moved city/);

    const audits = await db1.models.AuditLog.findAll({ where: { action: ['payments.refund', 'subscriptions.cancel'], actorUserId: personas.owner.user.id } });
    const refundAudit = audits.find((a) => a.action === 'payments.refund' && a.afterState?.payload?.paymentId === payment.id);
    expect(refundAudit.afterState.payload).toMatchObject({ amount: quote.suggestedAmount, reason: 'Moved city', subscriptionId: sub.id });
    expect(audits.some((a) => a.action === 'subscriptions.cancel' && a.targetId === sub.id)).toBe(true);

    const balanceAfter = await payoutService.getPayoutBalance(db1, ctx.branch1.id);
    expect(Number(balanceAfter.totalRefunded) - Number(balanceBefore.totalRefunded)).toBeCloseTo(Number(quote.suggestedAmount), 2);
    expect(Number(balanceBefore.availableBalance) - Number(balanceAfter.availableBalance)).toBeCloseTo(Number(quote.suggestedAmount), 2);
  });

  test('owner: a full amount makes the payment REFUNDED; a partial amount leaves the rest refundable', async () => {
    const { sub, payment } = await makeSub();
    const res = await cancelWithRefund(personas.owner, sub, { refundAmount: 3000 });
    expect(res.status).toBe(200);
    expect(res.body.data.refund.isFullRefund).toBe(true);
    expect((await payment.reload()).status).toBe('REFUNDED');

    const { sub: sub2, payment: pay2 } = await makeSub();
    const part = await cancelWithRefund(personas.owner, sub2, { refundAmount: 1000.5 });
    expect(part.status).toBe(200);
    expect(part.body.data.refund).toMatchObject({ refundedAmount: '1000.50', remainingRefundable: '1999.50', isFullRefund: false });
    expect((await pay2.reload()).status).toBe('COMPLETED');
  });

  test('more than the refundable balance: 422, and nothing is cancelled (one transaction)', async () => {
    const { sub, payment } = await makeSub();
    const res = await cancelWithRefund(personas.owner, sub, { refundAmount: 3000.01 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('refund_exceeds_refundable');
    expect((await sub.reload()).status).toBe('ACTIVE');
    expect(await reversalsOf(payment)).toHaveLength(0);
  });

  test('duplicate: sequential repeat is 409; two at the same time refund once', async () => {
    const { sub, payment } = await makeSub();
    expect((await cancelWithRefund(personas.owner, sub)).status).toBe(200);
    expect((await cancelWithRefund(personas.owner, sub)).status).toBe(409);
    expect(await reversalsOf(payment)).toHaveLength(1);

    const { sub: raced, payment: racedPay } = await makeSub();
    const [a, b] = await Promise.all([cancelWithRefund(personas.owner, raced), cancelWithRefund(personas.owner, raced)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await reversalsOf(racedPay)).toHaveLength(1);
  });

  test('manager (refund REQUEST): cancelled now, refund waits for approval; no ledger entry until approved', async () => {
    const { sub, payment } = await makeSub();
    const res = await cancelWithRefund(personas.manager, sub, { refundAmount: 500 }, { key: `n253-mgr-${sub.id}` });
    expect(res.status).toBe(200);
    expect(res.body.data.subscription.status).toBe('CANCELLED');
    expect(res.body.data.refund.status).toBe('PENDING');
    expect(await reversalsOf(payment)).toHaveLength(0);
    const approval = await db1.models.ApprovalRequest.findByPk(res.body.data.refund.requestId);
    expect(approval).toMatchObject({ actionKey: 'payments.refund', status: 'PENDING' });

    const ok = await request(app).post(`/api/v1/approvals/${approval.id}/approve`)
      .set('Authorization', `Bearer ${personas.owner.token}`).set('X-Tenant-Id', T1()).send({});
    expect(ok.status).toBe(200);
    const rev = await reversalsOf(payment);
    expect(rev).toHaveLength(1);
    expect(Number(rev[0].amount)).toBe(-500);
  });

  test('front desk (no refund): 403 refund_not_permitted, nothing cancelled', async () => {
    const { sub, payment } = await makeSub();
    const res = await cancelWithRefund(personas.frontDesk, sub);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('refund_not_permitted');
    expect((await sub.reload()).status).toBe('ACTIVE');
    expect(await reversalsOf(payment)).toHaveLength(0);
  });

  test('policy off: quote says so; cancel with refund is 422 refunds_disabled and cancels nothing; plain cancel unchanged', async () => {
    await setPolicy(false);
    const { sub, payment } = await makeSub();
    const q = (await as(personas.owner, 'get', `staff/${sub.id}/refund-quote`)).body.data;
    expect(q).toMatchObject({ eligible: false, refundsAllowed: false, reasonCode: 'refunds_disabled' });
    const res = await cancelWithRefund(personas.owner, sub);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('refunds_disabled');
    expect((await sub.reload()).status).toBe('ACTIVE');
    const plain = await as(personas.owner, 'post', `staff/${sub.id}/cancel`, {});
    expect(plain.status).toBe(200);
    expect(plain.body.data.refund).toBeUndefined();
    expect(await reversalsOf(payment)).toHaveLength(0);
  });

  test('window closed (7 days, paid 10 days ago): 422 refund_window_closed', async () => {
    await setPolicy(true, 7);
    const { sub } = await makeSub({ paidDaysAgo: 10 });
    const res = await cancelWithRefund(personas.owner, sub);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('refund_window_closed');
    expect((await sub.reload()).status).toBe('ACTIVE');
    const { sub: inside } = await makeSub({ paidDaysAgo: 3 });
    expect((await cancelWithRefund(personas.owner, inside)).status).toBe(200);
  });

  test('no completed payment: 422 no_refundable_payment', async () => {
    const { sub } = await makeSub({ pay: null });
    const res = await cancelWithRefund(personas.owner, sub);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('no_refundable_payment');
  });

  test('another tenant\'s subscription: 404, untouched', async () => {
    const { sub } = await makeSub({ db: ctx.tenant2Db, branch: ctx.branch2, planRow: tenant2Plan, tenantId: ctx.tenant2.id });
    expect((await cancelWithRefund(personas.owner, sub)).status).toBe(404);
    expect((await as(personas.owner, 'get', `staff/${sub.id}/refund-quote`)).status).toBe(404);
    expect((await sub.reload()).status).toBe('ACTIVE');
  });

  test('cancel with refund queues the device sync for the member', async () => {
    await registry.createDevice({
      tenantId: T1(), tenantDb: db1, branchId: ctx.branch1.id, organizationId: ctx.branch1.gymId || null,
      name: 'N253 Door', direction: 'in', importFirst: false, createdBy: personas.owner.user.id,
    });
    const { sub, member } = await makeSub();
    await triggers.settled();
    expect((await cancelWithRefund(personas.owner, sub, { refundAmount: 3000 })).status).toBe(200);
    await triggers.settled();
    const rows = await db1.sequelize.query(
      'SELECT payload_json FROM capacity_outbox WHERE event_type = \'DEVICE_RECONCILE\' AND JSON_CONTAINS(payload_json, JSON_QUOTE(?), \'$.memberIds\')',
      { replacements: [member.id], type: QueryTypes.SELECT }
    );
    const reasons = rows.map((r) => (typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json).reason);
    expect(reasons).toContain('subscription_cancelled');
  });
});

describe('NEW-253 B: member asks for a refund', () => {
  beforeEach(() => setPolicy(true));
  const memberSub = (opts = {}) => makeSub({ user: personas.member.user, ...opts });
  const memberCancel = (sub) => request(app).post(`/api/v1/subscriptions/${sub.id}/cancel`).set('Authorization', `Bearer ${personas.member.token}`).send({});

  test('before cancelling: not offered (not_cancelled), POST 409', async () => {
    const { sub } = await memberSub();
    const st = await memberCall(personas.member, 'get', sub);
    expect(st.status).toBe(200);
    expect(st.body.data).toMatchObject({ refundsAllowed: true, canRequest: false, reasonCode: 'not_cancelled' });
    const res = await memberCall(personas.member, 'post', sub, {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_cancelled');
  });

  test('after cancelling: offered; request 201 PENDING, repeat answers the same request; audited; no money moves yet', async () => {
    const { sub, payment } = await memberSub();
    expect((await memberCancel(sub)).status).toBe(200);
    const st = (await memberCall(personas.member, 'get', sub)).body.data;
    expect(st).toMatchObject({ canRequest: true, reasonCode: null, currency: 'PKR' });
    expect(Number(st.suggestedAmount)).toBeGreaterThan(0);

    const first = await memberCall(personas.member, 'post', sub, { reason: 'Injury' });
    expect(first.status).toBe(201);
    expect(first.body.data.request).toMatchObject({ status: 'PENDING', subscriptionId: sub.id, paymentId: payment.id, reason: 'Injury' });
    const again = await memberCall(personas.member, 'post', sub, {});
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    expect(again.body.data.request.id).toBe(first.body.data.request.id);
    expect(await db1.models.RefundRequest.count({ where: { subscriptionId: sub.id } })).toBe(1);
    expect(await reversalsOf(payment)).toHaveLength(0);
    const audit = await db1.models.AuditLog.findOne({ where: { action: 'refunds.request.create', targetId: first.body.data.request.id } });
    expect(audit.actorUserId).toBe(personas.member.user.id);
    expect((await memberCall(personas.member, 'get', sub)).body.data).toMatchObject({ canRequest: false, reasonCode: 'already_requested', request: { status: 'PENDING' } });
  });

  test('two requests at the same time keep one row', async () => {
    const { sub } = await memberSub();
    await memberCancel(sub);
    const [a, b] = await Promise.all([memberCall(personas.member, 'post', sub, {}), memberCall(personas.member, 'post', sub, {})]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await db1.models.RefundRequest.count({ where: { subscriptionId: sub.id } })).toBe(1);
  });

  test('policy off: not offered (refunds_disabled) and POST 422', async () => {
    const { sub } = await memberSub();
    await memberCancel(sub);
    await setPolicy(false);
    expect((await memberCall(personas.member, 'get', sub)).body.data).toMatchObject({ refundsAllowed: false, canRequest: false, reasonCode: 'refunds_disabled' });
    const res = await memberCall(personas.member, 'post', sub, {});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('refunds_disabled');
  });

  test('someone else\'s subscription: 404', async () => {
    const { sub } = await makeSub({ status: 'CANCELLED' });
    expect((await memberCall(personas.member, 'get', sub)).status).toBe(404);
    expect((await memberCall(personas.member, 'post', sub, {})).status).toBe(404);
  });

  test('decide: listed for the owner; a manager cannot decide; owner approves a lower amount once; ledger and audit follow', async () => {
    const { sub, payment } = await memberSub();
    await memberCancel(sub);
    const reqId = (await memberCall(personas.member, 'post', sub, { reason: 'Travel' })).body.data.request.id;

    const list = await as(personas.owner, 'get', 'staff/refund-requests?status=PENDING');
    expect(list.status).toBe(200);
    expect(list.body.data.requests.map((r) => r.id)).toContain(reqId);

    const mgr = await as(personas.manager, 'post', `staff/refund-requests/${reqId}/decide`, { decision: 'APPROVE' });
    expect(mgr.status).toBe(403);
    expect(await reversalsOf(payment)).toHaveLength(0);

    const over = await as(personas.owner, 'post', `staff/refund-requests/${reqId}/decide`, { decision: 'APPROVE', amount: 5000 });
    expect(over.status).toBe(422);
    expect((await db1.models.RefundRequest.findByPk(reqId)).status).toBe('PENDING');

    const ok = await as(personas.owner, 'post', `staff/refund-requests/${reqId}/decide`, { decision: 'APPROVE', amount: 1200, reason: 'Approved at the desk' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.request).toMatchObject({ status: 'APPROVED', approvedAmount: '1200.00', decidedBy: personas.owner.user.id });
    const rev = await reversalsOf(payment);
    expect(rev).toHaveLength(1);
    expect(Number(rev[0].amount)).toBe(-1200);
    expect(ok.body.data.request.ledgerAdjustmentId).toBe(rev[0].id);

    const again = await as(personas.owner, 'post', `staff/refund-requests/${reqId}/decide`, { decision: 'APPROVE' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('refund_request_decided');
    expect(await reversalsOf(payment)).toHaveLength(1);

    const audit = await db1.models.AuditLog.findOne({ where: { action: 'refunds.request.approve', targetId: reqId } });
    expect(audit.actorUserId).toBe(personas.owner.user.id);
    expect(audit.afterState).toMatchObject({ status: 'APPROVED', amount: '1200.00', reason: 'Approved at the desk' });
    expect((await memberCall(personas.member, 'get', sub)).body.data.request.status).toBe('APPROVED');
  });

  test('two approvals at the same time refund once', async () => {
    const { sub, payment } = await memberSub();
    await memberCancel(sub);
    const reqId = (await memberCall(personas.member, 'post', sub, {})).body.data.request.id;
    const [a, b] = await Promise.all([
      as(personas.owner, 'post', `staff/refund-requests/${reqId}/decide`, { decision: 'APPROVE' }),
      as(personas.owner, 'post', `staff/refund-requests/${reqId}/decide`, { decision: 'APPROVE' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await reversalsOf(payment)).toHaveLength(1);
  });

  test('reject: no money moves; the member cannot ask again', async () => {
    const { sub, payment } = await memberSub();
    await memberCancel(sub);
    const reqId = (await memberCall(personas.member, 'post', sub, {})).body.data.request.id;
    const res = await as(personas.owner, 'post', `staff/refund-requests/${reqId}/decide`, { decision: 'REJECT', reason: 'Outside policy' });
    expect(res.status).toBe(200);
    expect(res.body.data.request).toMatchObject({ status: 'REJECTED', decisionReason: 'Outside policy' });
    expect(await reversalsOf(payment)).toHaveLength(0);
    const repeat = await memberCall(personas.member, 'post', sub, {});
    expect(repeat.status).toBe(409);
    expect(repeat.body.code).toBe('refund_already_requested');
  });

  test('approval after the owner turned refunds off: 422, request stays pending', async () => {
    const { sub } = await memberSub();
    await memberCancel(sub);
    const reqId = (await memberCall(personas.member, 'post', sub, {})).body.data.request.id;
    await setPolicy(false);
    const res = await as(personas.owner, 'post', `staff/refund-requests/${reqId}/decide`, { decision: 'APPROVE' });
    expect(res.status).toBe(422);
    expect((await db1.models.RefundRequest.findByPk(reqId)).status).toBe('PENDING');
  });

  test('another tenant cannot see or decide the request', async () => {
    const { sub } = await memberSub();
    await memberCancel(sub);
    const reqId = (await memberCall(personas.member, 'post', sub, {})).body.data.request.id;
    const other = await as(personas.owner, 'post', `staff/refund-requests/${reqId}/decide`, { decision: 'APPROVE' }, { tenantId: ctx.tenant2.id });
    expect([403, 404]).toContain(other.status);
    expect((await db1.models.RefundRequest.findByPk(reqId)).status).toBe('PENDING');
  });
});
