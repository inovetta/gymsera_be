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

  const totalAmount = parseFloat(payment.amount);
  const subtotal = Math.min(parseFloat(plan.price), totalAmount);
  const remaining = Math.max(0, totalAmount - subtotal);
  
  const security = Math.min(parseFloat(plan.securityFee || 0), remaining);
  const joining = Math.max(0, remaining - security);

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

  if (!autoComplete && creatorRole !== 'GYM_HOST') {
    try {
      const { Tenant, User } = require('../models/platform');
      const notificationsService = require('./notifications.service');
      const tenant = await Tenant.findByPk(tenantDb.tenantId);

      const staffUser = await User.findByPk(staffUserId);
      const staffName = staffUser ? staffUser.fullName : 'Staff';

      const memberUser = await User.findByPk(data.userId);
      const memberName = memberUser ? memberUser.fullName : 'Member';

      const branch = await tenantDb.models.Branch.findByPk(data.branchId);
      const branchName = branch ? branch.branchName : 'Branch';

      const isUpgrade = data.notes && data.notes.startsWith('Upgrade to ');
      let actionText = 'add member';
      if (isUpgrade) actionText = 'upgrade';
      else if (data.notes && data.notes.toLowerCase().includes('renew')) actionText = 'renew';

      if (tenant && tenant.ownerUserId) {
        await notificationsService.createNotification({
          userId: tenant.ownerUserId,
          role: 'host',
          type: 'staff_action_pending',
          title: 'Pending Staff Action',
          message: `${staffName} requested to ${actionText} for ${memberName} at ${branchName} — needs your approval.`,
          deepLink: '/host/subscriptions',
          metadataJson: { subscriptionId: data.referenceEntityId, branchId: data.branchId },
        });
      }
    } catch (notifErr) {
      console.warn('[Notification Error] Failed to create staff action pending notification:', notifErr.message);
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

  // Enrich with User details from Platform DB
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const users = userIds.length
    ? await User.findAll({
        where: { id: userIds },
        attributes: ['id', 'fullName', 'email', 'phone', 'profileImageUrl'],
      })
    : [];
  const userMap = Object.fromEntries(users.map((u) => [u.id, u.toJSON()]));

  const payments = rows.map((r) => ({
    ...r.toJSON(),
    user: userMap[r.userId] || null,
  }));

  return { payments, pagination: buildPagination(count, page, limit) };
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
const verifyPayment = async (tenantDb, paymentId, verifiedByUserId, notes, waiveJoiningFee = false) => {
  const { Payment, Invoice, MemberSubscription, MembershipPlan } = tenantDb.models;

  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw createError('Payment not found', 404);

  const verifiableStatuses = [PaymentStatus.PENDING, PaymentStatus.STAFF_COLLECTED];
  if (!verifiableStatuses.includes(payment.status)) {
    throw createError(`Payment is already ${payment.status.toLowerCase()}`, 409);
  }

  let finalAmount = parseFloat(payment.amount);
  if (payment.referenceEntityId && payment.paymentFor === 'MEMBERSHIP' && (waiveJoiningFee === true || waiveJoiningFee === 'true')) {
    const subscription = await MemberSubscription.findByPk(payment.referenceEntityId);
    if (subscription) {
      const plan = await MembershipPlan.findByPk(subscription.membershipPlanId);
      if (plan && parseFloat(plan.joiningFee) > 0) {
        const joining = parseFloat(plan.joiningFee);
        finalAmount = Math.max(0, finalAmount - joining);
      }
    }
  }

  await payment.update({
    status:     PaymentStatus.COMPLETED,
    amount:     finalAmount,
    paidAt:     new Date(),
    verifiedAt: new Date(),
    verifiedBy: verifiedByUserId,
    notes:      notes || payment.notes,
  });

  if (payment.referenceEntityId) {
    await Invoice.update(
      { status: InvoiceStatus.PAID, paidAt: new Date(), totalAmount: finalAmount },
      { where: { referenceEntityId: payment.referenceEntityId, status: InvoiceStatus.ISSUED } }
    );
    if (payment.paymentFor === 'MEMBERSHIP') {
      await _activateSubscription(tenantDb, payment.referenceEntityId);
    }
  }

  // Create unified in-app notifications
  try {
    const { Tenant, User } = require('../models/platform');
    const notificationsService = require('./notifications.service');
    const tenant = await Tenant.findByPk(tenantDb.tenantId);

    // Load helper objects to construct friendly notification texts
    const travelerUser = await User.findByPk(payment.userId);
    const memberName = travelerUser ? travelerUser.fullName : 'Member';

    let planName = 'Membership';
    let branchName = 'Branch';
    if (payment.referenceEntityId) {
      const subscription = await MemberSubscription.findByPk(payment.referenceEntityId);
      if (subscription) {
        const plan = await MembershipPlan.findByPk(subscription.membershipPlanId);
        if (plan) planName = plan.name;
        const branch = await tenantDb.models.Branch.findByPk(subscription.branchId || payment.branchId);
        if (branch) branchName = branch.branchName;
      }
    }

    const isUpgrade = payment.notes && payment.notes.startsWith('Upgrade to ');

    // 1. Recipient: Traveler
    await notificationsService.createNotification({
      userId: payment.userId,
      role: 'traveler',
      type: isUpgrade ? 'subscription_upgrade_activated' : 'subscription_activated',
      title: isUpgrade ? 'Upgrade Active' : 'Subscription Activated',
      message: isUpgrade
        ? `Your upgrade to ${planName} is now active!`
        : `Your subscription to ${planName} is now active!`,
      deepLink: '/traveler/subscriptions',
      metadataJson: { subscriptionId: payment.referenceEntityId },
    });

    // 2. Recipient: Host (keep current notification)
    if (tenant && tenant.ownerUserId) {
      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'payment_update',
        title: 'Payment Verification Successful',
        message: `Payment of PKR ${finalAmount} has been successfully verified.`,
        deepLink: '/host/subscriptions',
        metadataJson: { subscriptionId: payment.referenceEntityId },
      });
    }

    // 3. Recipient: Admin (Oversight/Audit)
    if (tenant) {
      const hostUser = await User.findByPk(tenant.ownerUserId);
      const hostName = hostUser ? hostUser.fullName : 'Host';
      const admins = await User.findAll({ where: { role: 'PLATFORM_ADMIN' } });
      for (const admin of admins) {
        await notificationsService.createNotification({
          userId: admin.id,
          role: 'admin',
          type: 'subscription_verified_audit',
          title: 'Subscription Verified',
          message: `Subscription verified: ${memberName} → ${planName} at ${branchName} (Host: ${hostName}).`,
          deepLink: `/admin/tenants/${tenant.id}`,
          metadataJson: { subscriptionId: payment.referenceEntityId, tenantId: tenant.id },
        });
      }
    }

    // 4. Recipient: Staff (if this payment was recorded by staff)
    if (payment.createdBy && tenant && payment.createdBy !== tenant.ownerUserId) {
      let actionText = 'add member';
      if (isUpgrade) actionText = 'upgrade';
      else if (payment.notes && payment.notes.toLowerCase().includes('renew')) actionText = 'renew';

      await notificationsService.createNotification({
        userId: payment.createdBy,
        role: 'staff',
        type: 'staff_action_approved',
        title: 'Request Approved',
        message: `Your request to ${actionText} for ${memberName} was approved.`,
        deepLink: '/staff/dashboard',
        metadataJson: { subscriptionId: payment.referenceEntityId },
      });
    }
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create payment verification notifications:', notifErr.message);
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
const verifyOrRejectPayment = async (tenantDb, paymentId, actorUserId, actorRole, { action, notes, rejectedReason, waiveJoiningFee }) => {
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
    return verifyPayment(tenantDb, paymentId, actorUserId, notes, waiveJoiningFee);

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

    try {
      const { Tenant, User, MemberSubscription, MembershipPlan } = require('../models/platform');
      const notificationsService = require('./notifications.service');
      const tenant = await Tenant.findByPk(tenantDb.tenantId);

      const travelerUser = await User.findByPk(payment.userId);
      const memberName = travelerUser ? travelerUser.fullName : 'Member';

      let planName = 'Membership';
      if (payment.referenceEntityId) {
        const subscription = await MemberSubscription.findByPk(payment.referenceEntityId);
        if (subscription) {
          const plan = await MembershipPlan.findByPk(subscription.membershipPlanId);
          if (plan) planName = plan.name;
        }
      }

      const isUpgrade = payment.notes && payment.notes.startsWith('Upgrade to ');

      // 1. Recipient: Traveler
      await notificationsService.createNotification({
        userId: payment.userId,
        role: 'traveler',
        type: 'payment_rejected',
        title: 'Payment Verification Failed',
        message: `Your payment for ${planName} was not verified. Please review and resubmit.`,
        deepLink: '/traveler/subscriptions',
        metadataJson: { subscriptionId: payment.referenceEntityId },
      });

      // 2. Recipient: Host (keep current notification)
      if (tenant && tenant.ownerUserId) {
        await notificationsService.createNotification({
          userId: tenant.ownerUserId,
          role: 'host',
          type: 'payment_update',
          title: 'Payment Verification Rejected',
          message: `Payment of PKR ${payment.amount} was rejected. Reason: ${rejectedReason || 'None'}`,
          deepLink: '/host/subscriptions',
          metadataJson: { subscriptionId: payment.referenceEntityId },
        });
      }

      // 3. Recipient: Staff (if this payment was recorded by staff)
      if (payment.createdBy && tenant && payment.createdBy !== tenant.ownerUserId) {
        let actionText = 'add member';
        if (isUpgrade) actionText = 'upgrade';
        else if (payment.notes && payment.notes.toLowerCase().includes('renew')) actionText = 'renew';

        await notificationsService.createNotification({
          userId: payment.createdBy,
          role: 'staff',
          type: 'staff_action_rejected',
          title: 'Request Rejected',
          message: `Your request to ${actionText} for ${memberName} was rejected.`,
          deepLink: '/staff/dashboard',
          metadataJson: { subscriptionId: payment.referenceEntityId },
        });
      }
    } catch (notifErr) {
      console.warn('[Notification Error] Failed to create payment rejection notifications:', notifErr.message);
    }

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
