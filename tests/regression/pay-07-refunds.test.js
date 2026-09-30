const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  asPersona,
} = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { PaymentStatus } = require('../../src/constants/payment-status');
const { SubscriptionStatus } = require('../../src/constants/subscription-status');
const { UserGymMembership } = require('../../src/models/platform');

describe('PAY-07: Member Payment Refunds (spec §6.3, §12)', () => {
  let dbHarness;
  let personas;
  let tenant1;
  let branchId;
  let memberUserId;
  let Payment;
  let LedgerAdjustment;
  let MemberSubscription;
  let MembershipPlan;
  let appServer;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant1 = dbHarness.tenant1;
    personas = await setupPersonas(dbHarness);
    appServer = await startTestServer();

    Payment = tenant1.models.Payment;
    LedgerAdjustment = tenant1.models.LedgerAdjustment;
    MemberSubscription = tenant1.models.MemberSubscription;
    MembershipPlan = tenant1.models.MembershipPlan;

    const { Branch } = tenant1.models;
    const branch = await Branch.findOne({ where: { status: 'ACTIVE' } });
    branchId = branch.id;
    memberUserId = personas.member.user.id;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('POST /payments/:id/refund without Idempotency-Key returns 400 idempotency_key_required', async () => {
    const payment = await Payment.create({
      userId: memberUserId,
      branchId,
      amount: '3000.00',
      currency: 'PKR',
      method: 'CASH',
      status: PaymentStatus.COMPLETED,
      paidAt: new Date(),
      businessDate: '2026-09-30',
    });

    const res = await asPersona('owner').post(`/payments/${payment.id}/refund`, {
      amount: 1000,
      reason: 'Overcharged',
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('idempotency_key_required');
  });

  test('Refund amount > payment amount returns 422 refund_exceeds_refundable', async () => {
    const payment = await Payment.create({
      userId: memberUserId,
      branchId,
      amount: '2000.00',
      currency: 'PKR',
      method: 'CASH',
      status: PaymentStatus.COMPLETED,
      paidAt: new Date(),
      businessDate: '2026-09-30',
    });

    const res = await asPersona('owner', { 'Idempotency-Key': 'ref-excess-' + Date.now() })
      .post(`/payments/${payment.id}/refund`, {
        amount: 3000, // exceeds 2000
        reason: 'Customer request',
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('refund_exceeds_refundable');
  });

  test('Attempting to refund a PENDING payment returns 422 payment_not_refundable', async () => {
    const payment = await Payment.create({
      userId: memberUserId,
      branchId,
      amount: '1500.00',
      currency: 'PKR',
      method: 'CASH',
      status: PaymentStatus.PENDING,
      businessDate: '2026-09-30',
    });

    const res = await asPersona('owner', { 'Idempotency-Key': 'ref-pending-' + Date.now() })
      .post(`/payments/${payment.id}/refund`, {
        amount: 1500,
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('payment_not_refundable');
  });

  test('Host (DIRECT tier) issuing full refund reverses ledger, flips status to REFUNDED, and cancels subscription', async () => {
    const { Branch } = tenant1.models;
    const branch = await Branch.findByPk(branchId);
    const plan = await MembershipPlan.create({
      gymId: branch.gymId,
      branchId,
      name: 'Monthly Gold',
      price: '5000.00',
      durationType: 'MONTHLY',
      durationValue: 1,
      status: 'ACTIVE',
    });

    const sub = await MemberSubscription.create({
      userId: memberUserId,
      branchId,
      membershipPlanId: plan.id,
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      status: 'ACTIVE',
    });

    await UserGymMembership.create({
      userId: memberUserId,
      tenantId: personas.owner.tenantId,
      gymListingId: branch.gymListingId,
      subscriptionId: sub.id,
      status: 'ACTIVE',
      planName: plan.name,
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    });

    const payment = await Payment.create({
      userId: memberUserId,
      branchId,
      paymentFor: 'MEMBERSHIP',
      referenceEntityId: sub.id,
      amount: '5000.00',
      currency: 'PKR',
      method: 'CASH',
      status: PaymentStatus.COMPLETED,
      paidAt: new Date(),
      businessDate: '2026-09-30',
    });

    // 2. Perform full refund
    const res = await asPersona('owner', { 'Idempotency-Key': 'ref-full-' + Date.now() })
      .post(`/payments/${payment.id}/refund`, {
        reason: 'Customer cancelled membership early',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isFullRefund).toBe(true);
    expect(res.body.data.refundedAmount).toBe('5000.00');

    // 3. Verify Payment row
    await payment.reload();
    expect(payment.status).toBe(PaymentStatus.REFUNDED);
    expect(payment.notes).toMatch(/Refunded Rs 5000\.00/);

    // 4. Verify reversing LedgerAdjustment
    const adjustment = await LedgerAdjustment.findOne({
      where: { relatedPaymentId: payment.id, type: 'REVERSAL' },
    });
    expect(adjustment).not.toBeNull();
    expect(Number(adjustment.amount)).toBe(-5000);

    // 5. Verify MemberSubscription and platform UserGymMembership are cancelled
    await sub.reload();
    expect(sub.status).toBe('CANCELLED');

    const platformMembership = await UserGymMembership.findOne({
      where: { subscriptionId: sub.id },
    });
    expect(platformMembership.status).toBe('CANCELLED');
  });

  test('Partial refunds track remaining balance and prevent over-refund', async () => {
    const payment = await Payment.create({
      userId: memberUserId,
      branchId,
      amount: '6000.00',
      currency: 'PKR',
      method: 'CASH',
      status: PaymentStatus.COMPLETED,
      paidAt: new Date(),
      businessDate: '2026-09-30',
    });

    // First partial refund of 2500
    const res1 = await asPersona('owner', { 'Idempotency-Key': 'ref-part1-' + Date.now() })
      .post(`/payments/${payment.id}/refund`, {
        amount: 2500,
        reason: 'Partial return of equipment fee',
      });

    expect(res1.status).toBe(200);
    expect(res1.body.data.remainingRefundable).toBe('3500.00');
    expect(res1.body.data.isFullRefund).toBe(false);

    await payment.reload();
    expect(payment.status).toBe(PaymentStatus.COMPLETED); // Remains COMPLETED for partial

    // Second partial refund of 3500 (completing the refund)
    const res2 = await asPersona('owner', { 'Idempotency-Key': 'ref-part2-' + Date.now() })
      .post(`/payments/${payment.id}/refund`, {
        amount: 3500,
        reason: 'Remaining fee refunded',
      });

    expect(res2.status).toBe(200);
    expect(res2.body.data.remainingRefundable).toBe('0.00');
    expect(res2.body.data.isFullRefund).toBe(true);

    await payment.reload();
    expect(payment.status).toBe(PaymentStatus.REFUNDED);

    // Third attempt of 1 PKR: must be rejected with 422 payment_already_refunded
    const res3 = await asPersona('owner', { 'Idempotency-Key': 'ref-part3-' + Date.now() })
      .post(`/payments/${payment.id}/refund`, {
        amount: 1,
      });

    expect(res3.status).toBe(422);
    expect(res3.body.code).toBe('payment_already_refunded');
  });

  test('Manager (REQUEST tier) submitting refund creates PENDING approval request (202 Accepted)', async () => {
    const payment = await Payment.create({
      userId: memberUserId,
      branchId,
      amount: '4000.00',
      currency: 'PKR',
      method: 'CASH',
      status: PaymentStatus.COMPLETED,
      paidAt: new Date(),
      businessDate: '2026-09-30',
    });

    const res = await asPersona('manager', { 'Idempotency-Key': 'ref-mgr-' + Date.now() })
      .post(`/payments/${payment.id}/refund`, {
        amount: 1000,
        reason: 'Manager requesting customer goodwill refund',
      });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.approvalRequestId).toBeDefined();

    // Verify payment has NOT been altered
    await payment.reload();
    expect(payment.status).toBe(PaymentStatus.COMPLETED);
    const adjustments = await LedgerAdjustment.findAll({ where: { relatedPaymentId: payment.id } });
    expect(adjustments.length).toBe(0);
  });

  test('Cleaner (OFF tier) submitting refund is rejected with 403 Forbidden', async () => {
    const payment = await Payment.create({
      userId: memberUserId,
      branchId,
      amount: '1000.00',
      currency: 'PKR',
      method: 'CASH',
      status: PaymentStatus.COMPLETED,
      paidAt: new Date(),
      businessDate: '2026-09-30',
    });

    const res = await asPersona('cleaner', { 'Idempotency-Key': 'ref-cleaner-' + Date.now() })
      .post(`/payments/${payment.id}/refund`, {
        amount: 500,
      });

    expect(res.status).toBe(403);
  });
});
