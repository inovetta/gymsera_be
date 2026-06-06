const { Op } = require('sequelize');
const { createError, buildPagination } = require('../utils/response.utils');
const { PaymentStatus, InvoiceStatus } = require('../constants/payment-status');
const { notificationsQueue } = require('../jobs/queues');
const { User, UserGymMembership } = require('../models/platform');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a sequential-style invoice number:  INV-YYYYMMDD-<6 random hex>
 */
const _invoiceNo = () => {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `INV-${date}-${rand}`;
};

/**
 * Create an invoice linked to a payment + subscription.
 * Called internally after a successful payment.
 */
const _createInvoice = async (models, { userId, payment, subscription, plan }) => {
  const { Invoice } = models;

  const subtotal   = parseFloat(plan.price);
  const joining    = parseFloat(plan.joiningFee  || 0);
  const security   = parseFloat(plan.securityFee || 0);
  const totalAmount = subtotal + joining + security;

  const invoice = await Invoice.create({
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

  return invoice;
};

/**
 * Activate a PENDING subscription after payment is confirmed.
 * Updates both the tenant subscription and the platform cross-tenant index.
 * Non-fatal — logs a warning if it fails rather than rolling back the payment.
 */
const _activateSubscription = async (tenantDb, subscriptionId) => {
  try {
    const { MemberSubscription } = tenantDb.models;
    const sub = await MemberSubscription.findByPk(subscriptionId);
    if (sub && sub.status === 'PENDING') {
      await sub.update({ status: 'ACTIVE' });
      await UserGymMembership.update({ status: 'ACTIVE' }, { where: { subscriptionId } });
    }
  } catch (err) {
    console.warn('[Payment] Failed to activate subscription after payment:', err.message);
  }
};

// ── POST /payments ─────────────────────────────────────────────────────────────
/**
 * Record a payment.
 * Special methods:
 *  - CASH  → immediately COMPLETED
 *  - TEST  → immediately COMPLETED (dev/QA only, validated in controller via X-Test-Payment-Key header)
 *  - others → PENDING until verified
 */
const recordPayment = async (tenantDb, staffUserId, data) => {
  const { Payment, MemberSubscription, MembershipPlan } = tenantDb.models;

  const autoComplete = data.method === 'CASH' || data.method === 'TEST';

  const payment = await Payment.create({
    userId:               data.userId,
    paymentFor:           data.paymentFor   || 'MEMBERSHIP',
    referenceEntityId:    data.referenceEntityId || null,
    method:               data.method,
    gatewayName:          data.method === 'TEST' ? 'TEST_GATEWAY' : (data.gatewayName || null),
    gatewayTransactionId: data.method === 'TEST'
      ? `TEST-${Date.now()}`
      : (data.gatewayTransactionId || null),
    amount:               data.amount,
    currency:             data.currency || 'PKR',
    status: autoComplete ? PaymentStatus.COMPLETED : PaymentStatus.PENDING,
    paidAt: autoComplete ? new Date() : null,
    notes:  data.notes || null,
  });

  let invoice = null;

  // Auto-invoice for membership payments that have a subscription reference
  if (data.paymentFor === 'MEMBERSHIP' && data.referenceEntityId) {
    const subscription = await MemberSubscription.findByPk(data.referenceEntityId);
    if (subscription) {
      const plan = await MembershipPlan.findByPk(subscription.membershipPlanId);
      if (plan) {
        invoice = await _createInvoice(tenantDb.models, {
          userId:       data.userId,
          payment,
          subscription,
          plan,
        });
      }
      // Auto-complete (CASH/TEST) payments activate the subscription immediately
      if (autoComplete) {
        await _activateSubscription(tenantDb, data.referenceEntityId);
      }
    }
  }

  return { payment, invoice };
};

// ── GET /payments ──────────────────────────────────────────────────────────────
const listPayments = async (tenantDb, { userId, status, method, from, to, page, limit, offset }) => {
  const { Payment } = tenantDb.models;
  const where = {};

  if (userId)  where.userId = userId;
  if (status)  where.status = status;
  if (method)  where.method = method;
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
 * Staff marks a PENDING payment as COMPLETED (manual verification).
 * Also transitions linked invoice to PAID.
 */
const verifyPayment = async (tenantDb, paymentId, verifiedByUserId, notes) => {
  const { Payment, Invoice } = tenantDb.models;

  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw createError('Payment not found', 404);
  if (payment.status !== PaymentStatus.PENDING) {
    throw createError(`Payment is already ${payment.status.toLowerCase()}`, 409);
  }

  await payment.update({
    status:     PaymentStatus.COMPLETED,
    paidAt:     new Date(),
    verifiedAt: new Date(),
    verifiedBy: verifiedByUserId,
    notes:      notes || payment.notes,
  });

  // Update linked invoice if present
  if (payment.referenceEntityId) {
    await Invoice.update(
      { status: InvoiceStatus.PAID, paidAt: new Date() },
      { where: { referenceEntityId: payment.referenceEntityId, status: InvoiceStatus.ISSUED } }
    );
  }

  return payment.reload();
};

// ── GET /invoices ──────────────────────────────────────────────────────────────
const listInvoices = async (tenantDb, requestingUserId, isHost, { userId, status, from, to, page, limit, offset }) => {
  const { Invoice } = tenantDb.models;
  const where = {};

  // Members only see their own invoices
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
  // Members can only view their own invoices; hosts/managers can see any
  if (!isHost) where.userId = requestingUserId;

  const invoice = await Invoice.findOne({ where });
  if (!invoice) throw createError('Invoice not found', 404);
  return invoice;
};

// ── POST /payments/:id/fail (webhook / gateway callback) ──────────────────────
/**
 * Mark a PENDING payment as FAILED and notify the member.
 * Typically called from a payment gateway webhook handler.
 */
const markPaymentFailed = async (tenantDb, paymentId, gymName) => {
  const { Payment } = tenantDb.models;

  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw createError('Payment not found', 404);
  if (payment.status !== PaymentStatus.PENDING) {
    throw createError(`Payment is already ${payment.status.toLowerCase()}`, 409);
  }

  await payment.update({ status: PaymentStatus.FAILED });

  // Non-fatal notification
  try {
    const user = await User.findByPk(payment.userId, { attributes: ['email', 'fullName', 'fcmToken'] });
    if (user) {
      await notificationsQueue.add({
        type:     'PAYMENT_FAILED',
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

// ── POST /payments/:id/verify — verify OR reject ──────────────────────────────
/**
 * Staff verifies (approves) or rejects a pending payment.
 * action: 'verify' | 'reject'
 * Extending the original verifyPayment with an action field and rejectedReason.
 */
const verifyOrRejectPayment = async (tenantDb, paymentId, verifiedByUserId, { action, notes, rejectedReason }) => {
  const { Payment, Invoice } = tenantDb.models;

  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw createError('Payment not found', 404);
  if (payment.status !== PaymentStatus.PENDING) {
    throw createError(`Payment is already ${payment.status.toLowerCase()}`, 409);
  }

  if (action === 'verify') {
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

      // Activate the linked subscription if this was a membership payment
      if (payment.paymentFor === 'MEMBERSHIP') {
        await _activateSubscription(tenantDb, payment.referenceEntityId);
      }
    }
  } else if (action === 'reject') {
    await payment.update({
      status:         PaymentStatus.FAILED,
      verifiedAt:     new Date(),
      verifiedBy:     verifiedByUserId,
      rejectedReason: rejectedReason || null,
      notes:          notes || payment.notes,
    });
  } else {
    throw createError('action must be "verify" or "reject"', 400);
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

// ── POST /payments/collection-action — staff marks as collected ───────────────
/**
 * Batch action: staff marks one or more payments as COLLECTED (cash collected in person).
 * paymentIds: string[] — array of payment UUIDs
 */
const collectionAction = async (tenantDb, paymentIds, staffUserId) => {
  const { Payment } = tenantDb.models;

  const [updatedCount] = await Payment.update(
    {
      status:     PaymentStatus.COMPLETED,
      paidAt:     new Date(),
      verifiedAt: new Date(),
      verifiedBy: staffUserId,
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

// Re-export with new methods
module.exports = {
  recordPayment, listPayments, getPayment, verifyPayment, verifyOrRejectPayment,
  uploadPaymentProof, collectionAction,
  listInvoices, getInvoice, markPaymentFailed,
};
