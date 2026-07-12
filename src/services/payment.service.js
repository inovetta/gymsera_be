const crypto = require('crypto');
const { Op } = require('sequelize');
const { createError, buildPagination } = require('../utils/response.utils');
const { PaymentStatus, InvoiceStatus } = require('../constants/payment-status');
const { notificationsQueue } = require('../jobs/queues');
const { User, UserGymMembership } = require('../models/platform');

// ── Helpers ───────────────────────────────────────────────────────────────────

const _invoiceNo = () => {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `INV-${date}-${rand}`;
};

const _createInvoice = async (models, { userId, payment, subscription, plan }) => {
  const { Invoice } = models;

  const subtotal   = parseFloat(plan.price);
  const joining    = parseFloat(plan.joiningFee  || 0);
  const security   = parseFloat(plan.securityFee || 0);
  const totalAmount = subtotal + joining + security;

  return Invoice.create({
    userId,
    invoiceNo:         _invoiceNo(),
    invoiceType:       'MEMBERSHIP',
    referenceEntityId: subscription.id,
    subtotal,
    discountAmount: 0,
    taxAmount:      0,
    totalAmount,
    dueDate:  new Date().toISOString().split('T')[0],
    paidAt:   payment.status === PaymentStatus.COMPLETED ? new Date() : null,
    status:   payment.status === PaymentStatus.COMPLETED
                ? InvoiceStatus.PAID
                : InvoiceStatus.ISSUED,
  });
};

/**
 * Activate a PENDING subscription after tenant gives final payment approval.
 * Non-fatal — logs a warning rather than rolling back the payment on failure.
 */
const _activateSubscription = async (tenantDb, subscriptionId) => {
  try {
    const { MemberSubscription } = tenantDb.models;
    const sub = await MemberSubscription.findByPk(subscriptionId);
    if (sub && sub.status === 'PENDING') {
      const qrCode = sub.qrCode || `GE-${crypto.randomBytes(20).toString('hex').toUpperCase()}`;
      await sub.update({ status: 'ACTIVE', qrCode });
      await UserGymMembership.update({ status: 'ACTIVE' }, { where: { subscriptionId } });
    }
  } catch (err) {
    console.warn('[Payment] Failed to activate subscription after payment:', err.message);
  }
};

// ── POST /payments ─────────────────────────────────────────────────────────────
/**
 * Record a payment.
 *
 * Auto-complete rules (→ COMPLETED immediately, subscription activated):
 *   - creator role is GYM_HOST (tenant owner recording their own payment)
 *   - method is TEST (dev/QA only)
 *
 * All other cases → PENDING (enters the collect-box for 2-step verification):
 *   Step 1: Staff marks as STAFF_COLLECTED (cash received in hand)
 *   Step 2: Tenant (GYM_HOST) gives final approval → COMPLETED
 */
const recordPayment = async (tenantDb, staffUserId, creatorRole, data) => {
  const { Payment, MemberSubscription, MembershipPlan } = tenantDb.models;

  const autoComplete = creatorRole === 'GYM_HOST' || data.method === 'TEST';

  const payment = await Payment.create({
    userId:               data.userId,
    paymentFor:           data.paymentFor   || 'MEMBERSHIP',
    referenceEntityId:    data.referenceEntityId || null,
    branchId:             data.branchId || null,
    method:               data.method,
    gatewayName:          data.method === 'TEST' ? 'TEST_GATEWAY' : (data.gatewayName || null),
    gatewayTransactionId: data.method === 'TEST'
      ? `TEST-${Date.now()}`
      : (data.gatewayTransactionId || null),
    amount:               data.amount,
    currency:             data.currency || 'PKR',
    status:               autoComplete ? PaymentStatus.COMPLETED : PaymentStatus.PENDING,
    paidAt:               autoComplete ? new Date() : null,
    notes:                data.notes || null,
    createdBy:            staffUserId,
    createdByRole:        creatorRole,
  });

  let invoice = null;

  if (data.paymentFor === 'MEMBERSHIP' && data.referenceEntityId) {
    const subscription = await MemberSubscription.findByPk(data.referenceEntityId);
    if (subscription) {
      const plan = await MembershipPlan.findByPk(subscription.membershipPlanId);
      if (plan) {
        invoice = await _createInvoice(tenantDb.models, { userId: data.userId, payment, subscription, plan });
      }
      if (autoComplete) {
        await _activateSubscription(tenantDb, data.referenceEntityId);
      }
    }
  }

  return { payment, invoice };
};

// ── GET /payments ──────────────────────────────────────────────────────────────
const listPayments = async (tenantDb, { userId, branchId, status, method, from, to, page, limit, offset }) => {
  const { Payment } = tenantDb.models;
  const where = {};

  if (userId)   where.userId   = userId;
  if (branchId) where.branchId = branchId;
  if (status)   where.status   = status;
  if (method)   where.method   = method;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt[Op.gte] = new Date(from);
    if (to)   where.createdAt[Op.lte] = new Date(to);
  }

  const { count, rows } = await Payment.findAndCountAll({
    where,
    order:  [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return { payments: rows, pagination: buildPagination(count, page, limit) };
};

// ── GET /payments/:id ─────────────────────────────────────────────────────────
const getPayment = async (tenantDb, paymentId) => {
  const { Payment } = tenantDb.models;
  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw createError('Payment not found', 404);
  return payment;
};

// ── POST /payments/:id/verify ──────────────────────────────────────────────────
/**
 * Tenant (GYM_HOST) gives final approval to a PENDING or STAFF_COLLECTED payment.
 * Activates the linked subscription and marks the invoice as PAID.
 */
const verifyPayment = async (tenantDb, paymentId, verifiedByUserId, notes) => {
  const { Payment, Invoice } = tenantDb.models;

  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw createError('Payment not found', 404);

  const verifiableStatuses = [PaymentStatus.PENDING, PaymentStatus.STAFF_COLLECTED];
  if (!verifiableStatuses.includes(payment.status)) {
    throw createError(`Payment is already ${payment.status.toLowerCase()}`, 409);
  }

  await payment.update({
    status:     PaymentStatus.COMPLETED,
    paidAt:     new Date(),
    verifiedAt: new Date(),
    verifiedBy: verifiedByUserId,
    notes:      notes || payment.notes,
  });

  if (payment.referenceEntityId) {
    await Invoice.update(
      { status: InvoiceStatus.PAID, paidAt: new Date() },
      { where: { referenceEntityId: payment.referenceEntityId, status: InvoiceStatus.ISSUED } }
    );
    if (payment.paymentFor === 'MEMBERSHIP') {
      await _activateSubscription(tenantDb, payment.referenceEntityId);
    }
  }

  return payment.reload();
};

// ── POST /payments/:id/action ──────────────────────────────────────────────────
/**
 * Unified action endpoint.
 *
 * Actions:
 *  collect  → BRANCH_MANAGER or GYM_HOST: PENDING → STAFF_COLLECTED (step 1)
 *  verify   → GYM_HOST ONLY: (PENDING | STAFF_COLLECTED) → COMPLETED (step 2)
 *  reject   → BRANCH_MANAGER or GYM_HOST: (PENDING | STAFF_COLLECTED) → FAILED
 */
const verifyOrRejectPayment = async (tenantDb, paymentId, actorUserId, actorRole, { action, notes, rejectedReason }) => {
  const { Payment, Invoice } = tenantDb.models;

  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw createError('Payment not found', 404);

  if (action === 'collect') {
    if (payment.status !== PaymentStatus.PENDING) {
      throw createError(`Cannot collect a payment that is already ${payment.status.toLowerCase()}`, 409);
    }
    await payment.update({
      status:           PaymentStatus.STAFF_COLLECTED,
      staffCollectedBy: actorUserId,
      collectedAt:      new Date(),
      notes:            notes || payment.notes,
    });

  } else if (action === 'verify') {
    if (actorRole !== 'GYM_HOST') {
      throw createError('Only the gym host can give final payment approval', 403);
    }
    const verifiableStatuses = [PaymentStatus.PENDING, PaymentStatus.STAFF_COLLECTED];
    if (!verifiableStatuses.includes(payment.status)) {
      throw createError(`Payment is already ${payment.status.toLowerCase()}`, 409);
    }
    await payment.update({
      status:     PaymentStatus.COMPLETED,
      paidAt:     new Date(),
      verifiedAt: new Date(),
      verifiedBy: actorUserId,
      notes:      notes || payment.notes,
    });
    if (payment.referenceEntityId) {
      await Invoice.update(
        { status: InvoiceStatus.PAID, paidAt: new Date() },
        { where: { referenceEntityId: payment.referenceEntityId, status: InvoiceStatus.ISSUED } }
      );
      if (payment.paymentFor === 'MEMBERSHIP') {
        await _activateSubscription(tenantDb, payment.referenceEntityId);
      }
    }

  } else if (action === 'reject') {
    const rejectableStatuses = [PaymentStatus.PENDING, PaymentStatus.STAFF_COLLECTED];
    if (!rejectableStatuses.includes(payment.status)) {
      throw createError(`Payment is already ${payment.status.toLowerCase()}`, 409);
    }
    await payment.update({
      status:         PaymentStatus.FAILED,
      verifiedAt:     new Date(),
      verifiedBy:     actorUserId,
      rejectedReason: rejectedReason || null,
      notes:          notes || payment.notes,
    });

  } else {
    throw createError('action must be "collect", "verify", or "reject"', 400);
  }

  return payment.reload();
};

// ── POST /payments/:id/proof — upload proof image ─────────────────────────────
const uploadPaymentProof = async (tenantDb, paymentId, proofUrl) => {
  const { Payment } = tenantDb.models;

  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw createError('Payment not found', 404);
  if (payment.status !== PaymentStatus.PENDING) {
    throw createError('Proof can only be uploaded for pending payments', 400);
  }

  await payment.update({ proofUrl });
  return payment.reload();
};

// ── POST /payments/collection-action — batch staff collection ─────────────────
/**
 * Staff marks multiple PENDING payments as STAFF_COLLECTED in one action.
 * The tenant (GYM_HOST) still needs to give final approval for each payment.
 */
const collectionAction = async (tenantDb, paymentIds, staffUserId) => {
  const { Payment } = tenantDb.models;

  const [updatedCount] = await Payment.update(
    {
      status:           PaymentStatus.STAFF_COLLECTED,
      staffCollectedBy: staffUserId,
      collectedAt:      new Date(),
    },
    {
      where: {
        id:     paymentIds,
        status: PaymentStatus.PENDING,
      },
    }
  );

  return { collected: updatedCount };
};

// ── POST /payments/:id/fail (webhook / gateway callback) ──────────────────────
const markPaymentFailed = async (tenantDb, paymentId, gymName) => {
  const { Payment } = tenantDb.models;

  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw createError('Payment not found', 404);
  if (payment.status !== PaymentStatus.PENDING) {
    throw createError(`Payment is already ${payment.status.toLowerCase()}`, 409);
  }

  await payment.update({ status: PaymentStatus.FAILED });

  try {
    const user = await User.findByPk(payment.userId, { attributes: ['email', 'fullName', 'fcmToken'] });
    if (user) {
      await notificationsQueue.add({
        type:     'PAYMENT_FAILED',
        userId:   payment.userId,
        email:    user.email,
        fullName: user.fullName,
        fcmToken: user.fcmToken,
        gymName:  gymName || 'your gym',
        amount:   payment.amount,
        currency: payment.currency,
      }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    }
  } catch (err) {
    console.warn('[Notification] Failed to enqueue PAYMENT_FAILED:', err.message);
  }

  return payment.reload();
};

// ── GET /invoices ──────────────────────────────────────────────────────────────
const listInvoices = async (tenantDb, requestingUserId, isHost, { userId, status, from, to, page, limit, offset }) => {
  const { Invoice } = tenantDb.models;
  const where = {};

  if (!isHost) {
    where.userId = requestingUserId;
  } else if (userId) {
    where.userId = userId;
  }

  if (status) where.status = status;

  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt[Op.gte] = new Date(`${from}T00:00:00.000Z`);
    if (to)   where.createdAt[Op.lte] = new Date(`${to}T23:59:59.999Z`);
  }

  const { count, rows } = await Invoice.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return { invoices: rows, pagination: buildPagination(count, page, limit) };
};

// ── GET /invoices/:id ──────────────────────────────────────────────────────────
const getInvoice = async (tenantDb, invoiceId, requestingUserId, isHost) => {
  const { Invoice } = tenantDb.models;
  const where = { id: invoiceId };
  if (!isHost) where.userId = requestingUserId;

  const invoice = await Invoice.findOne({ where });
  if (!invoice) throw createError('Invoice not found', 404);
  return invoice;
};

module.exports = {
  recordPayment, listPayments, getPayment, verifyPayment, verifyOrRejectPayment,
  uploadPaymentProof, collectionAction, markPaymentFailed,
  listInvoices, getInvoice,
};
