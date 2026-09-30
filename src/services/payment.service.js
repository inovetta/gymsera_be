const crypto = require('crypto');
const { Op } = require('sequelize');
const { createError, buildPagination } = require('../utils/response.utils');
const { PaymentStatus, InvoiceStatus } = require('../constants/payment-status');
const { toMinorUnits, fromMinorUnits } = require('../utils/money.utils');
const notificationsService = require('./notifications.service');
const emailService = require('./email.service');
const { User, UserGymMembership } = require('../models/platform');

// ── Helpers ───────────────────────────────────────────────────────────────────

const _invoiceNo = () => {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `INV-${date}-${rand}`;
};

const _createInvoice = async (
  models,
  { userId, payment, subscription, plan, createdBy, createdByRole, branchId },
  transaction = null
) => {
  const { Invoice } = models;

  const totalAmountMinor = toMinorUnits(payment.amount);
  const planPriceMinor = toMinorUnits(plan.price);
  const subtotalMinor = Math.min(planPriceMinor, totalAmountMinor);
  const remainingMinor = Math.max(0, totalAmountMinor - subtotalMinor);

  const securityFeeMinor = toMinorUnits(plan.securityFee || 0);
  const securityMinor = Math.min(securityFeeMinor, remainingMinor);
  const joiningMinor = Math.max(0, remainingMinor - securityMinor);

  return Invoice.create(
    {
      userId,
      invoiceNo: _invoiceNo(),
      invoiceType: 'MEMBERSHIP',
      referenceEntityId: subscription.id,
      branchId: branchId || subscription?.branchId || payment?.branchId || null,
      subtotal: fromMinorUnits(subtotalMinor),
      discountAmount: '0.00',
      taxAmount: '0.00',
      totalAmount: fromMinorUnits(totalAmountMinor),
      dueDate: new Date().toISOString().split('T')[0],
      paidAt: payment.status === PaymentStatus.COMPLETED ? new Date() : null,
      status: payment.status === PaymentStatus.COMPLETED
        ? InvoiceStatus.PAID
        : InvoiceStatus.ISSUED,
      createdBy: createdBy || payment?.createdBy || null,
      createdByRole: createdByRole || payment?.createdByRole || null,
    },
    transaction ? { transaction } : {}
  );
};

/**
 * Activate a PENDING subscription after tenant gives final payment approval.
 * Transactional: updates MemberSubscription inside transaction, and syncs platform
 * UserGymMembership after transaction commit.
 */
const _activateSubscription = async (tenantDb, subscriptionId, transaction = null) => {
  const { MemberSubscription } = tenantDb.models;
  const sub = await MemberSubscription.findByPk(subscriptionId, transaction ? { transaction } : {});
  if (sub && sub.status === 'PENDING') {
    const qrCode = sub.qrCode || `GE-${crypto.randomBytes(20).toString('hex').toUpperCase()}`;
    await sub.update({ status: 'ACTIVE', qrCode }, transaction ? { transaction } : {});
    if (transaction) {
      transaction.afterCommit(async () => {
        await UserGymMembership.update({ status: 'ACTIVE' }, { where: { subscriptionId } }).catch((err) => {
          console.warn('[Payment] Failed to sync UserGymMembership after commit:', err.message);
        });
      });
    } else {
      await UserGymMembership.update({ status: 'ACTIVE' }, { where: { subscriptionId } }).catch(() => {});
    }
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
// `isDirect` is the caller's resolved payments.record.direct grant (always true
// for the owner) — the controller works this out from the permission catalogue,
// not from a literal role string, so a Branch Admin or Manager holding DIRECT
// tier gets the same immediate-complete behaviour the owner always got, and a
// Front Desk holding only REQUEST tier lands the payment as PENDING for
// approval instead of either being silently blocked or silently auto-completed.
const recordPayment = async (tenantDb, staffUserId, creatorRole, data, isDirect = false) => {
  const { Payment, MemberSubscription, MembershipPlan } = tenantDb.models;
  const { resolveCreatorRole } = require('../utils/audit.utils');
  const ledgerService = require('./ledger.service');

  // A retried/double-tapped submit with the same key returns the original
  // payment instead of recording the collection twice.
  if (data.idempotencyKey) {
    const existing = await Payment.findOne({ where: { idempotencyKey: data.idempotencyKey } });
    if (existing) {
      return { payment: existing, invoice: null, duplicate: true };
    }
  }

  // Branch billing lock guard (CAP-01): no sales/payments for a locked branch
  let targetBranchId = data.branchId;
  if (!targetBranchId && data.paymentFor === 'MEMBERSHIP' && data.referenceEntityId) {
    const sub = await MemberSubscription.findByPk(data.referenceEntityId);
    if (sub) targetBranchId = sub.branchId;
  }
  if (targetBranchId && tenantDb.models.Branch) {
    const branch = await tenantDb.models.Branch.findByPk(targetBranchId);
    if (branch) {
      const { assertBranchNotBillingLocked } = require('./branch-billing-lock.service');
      assertBranchNotBillingLocked(branch);
    }
  }

  const resolvedRole = await resolveCreatorRole(tenantDb, staffUserId, creatorRole, data.branchId);
  const autoComplete = isDirect || data.method === 'TEST';
  const paidAt = data.paidAt || (autoComplete ? new Date() : null);
  const collectedAt = data.collectedAt || (data.method === 'CASH' ? (data.paidAt || new Date()) : (autoComplete ? paidAt : null));
  const collectionTime = ledgerService.getPaymentCollectionTime({
    method: data.method,
    collectedAt,
    paidAt,
    createdAt: new Date(),
  });
  const businessDate = await ledgerService.stampBusinessDate(tenantDb, data.branchId, collectionTime);

  const effectiveBranchId = data.branchId || targetBranchId;
  if (effectiveBranchId && businessDate && tenantDb.models.LedgerDay) {
    const closedDay = await tenantDb.models.LedgerDay.findOne({
      where: {
        branchId: effectiveBranchId,
        businessDate,
        status: 'CLOSED',
      },
    });
    if (closedDay) {
      const err = createError(
        `Ledger day ${businessDate} for this branch is closed. Cannot post new payments into a closed day.`,
        409
      );
      err.code = 'ledger_day_closed';
      throw err;
    }
  }

  const { payment, invoice } = await tenantDb.sequelize.transaction(async (tx) => {
    const createdPayment = await Payment.create(
      {
        userId: data.userId,
        paymentFor: data.paymentFor || 'MEMBERSHIP',
        referenceEntityId: data.referenceEntityId || null,
        branchId: data.branchId || null,
        method: data.method,
        gatewayName: data.method === 'TEST' ? 'TEST_GATEWAY' : (data.gatewayName || null),
        gatewayTransactionId: data.method === 'TEST'
          ? `TEST-${Date.now()}`
          : (data.gatewayTransactionId || null),
        amount: data.amount,
        currency: data.currency || 'PKR',
        status: autoComplete ? PaymentStatus.COMPLETED : PaymentStatus.PENDING,
        paidAt,
        collectedAt,
        staffCollectedBy: data.staffCollectedBy || (data.method === 'CASH' ? staffUserId : null),
        notes: data.notes || null,
        createdBy: staffUserId || null,
        createdByRole: resolvedRole,
        businessDate,
        idempotencyKey: data.idempotencyKey || null,
      },
      { transaction: tx }
    );

    let createdInvoice = null;

    if (data.paymentFor === 'MEMBERSHIP' && data.referenceEntityId) {
      const subscription = await MemberSubscription.findByPk(data.referenceEntityId, { transaction: tx });
      if (subscription) {
        const plan = await MembershipPlan.findByPk(subscription.membershipPlanId, { transaction: tx });
        if (plan) {
          createdInvoice = await _createInvoice(
            tenantDb.models,
            {
              userId: data.userId,
              payment: createdPayment,
              subscription,
              plan,
              createdBy: staffUserId,
              createdByRole: resolvedRole,
              branchId: data.branchId || subscription.branchId,
            },
            tx
          );
        }
        if (autoComplete) {
          await _activateSubscription(tenantDb, data.referenceEntityId, tx);
        }
      }
    }

    return { payment: createdPayment, invoice: createdInvoice };
  });

  if (data.branchId) ledgerService.notifyLedgerUpdated(tenantDb.tenantId, data.branchId, businessDate);

  if (!autoComplete) {
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
  const { Payment, Branch } = tenantDb.models;
  const where = {};

  const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
  const activeBranchIds = activeBranches.map((b) => b.id);
  if (activeBranchIds.length === 0) {
    return { count: 0, rows: [] };
  }

  if (userId) where.userId = userId;
  if (branchId) {
    if (!activeBranchIds.includes(branchId)) {
      return { count: 0, rows: [] };
    }
    where.branchId = branchId;
  } else {
    where.branchId = { [Op.in]: activeBranchIds };
  }
  if (status) where.status = status;
  if (method) where.method = method;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt[Op.gte] = new Date(from);
    if (to) where.createdAt[Op.lte] = new Date(to);
  }

  const { count, rows } = await Payment.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  const { enrichAuditDetails } = require('../utils/audit.utils');
  const enrichedPayments = await enrichAuditDetails(tenantDb, rows);

  return { payments: enrichedPayments, pagination: buildPagination(count, page, limit) };
};

// ── GET /payments/:id ─────────────────────────────────────────────────────────
const getPayment = async (tenantDb, paymentId) => {
  const { Payment } = tenantDb.models;
  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw createError('Payment not found', 404);

  const { enrichAuditDetails } = require('../utils/audit.utils');
  const [enriched] = await enrichAuditDetails(tenantDb, [payment]);
  return enriched;
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

  const targetBranchId = payment.branchId;
  if (targetBranchId && tenantDb.models.Branch) {
    const branch = await tenantDb.models.Branch.findByPk(targetBranchId);
    if (branch) {
      const { assertBranchNotBillingLocked } = require('./branch-billing-lock.service');
      assertBranchNotBillingLocked(branch);
    }
  }

  const verifiableStatuses = [PaymentStatus.PENDING, PaymentStatus.STAFF_COLLECTED];
  if (!verifiableStatuses.includes(payment.status)) {
    throw createError(`Payment is already ${payment.status.toLowerCase()}`, 409);
  }

  let finalAmountMinor = toMinorUnits(payment.amount);
  if (payment.referenceEntityId && payment.paymentFor === 'MEMBERSHIP' && (waiveJoiningFee === true || waiveJoiningFee === 'true')) {
    const subscription = await MemberSubscription.findByPk(payment.referenceEntityId);
    if (subscription) {
      const plan = await MembershipPlan.findByPk(subscription.membershipPlanId);
      const joiningFeeMinor = toMinorUnits(plan?.joiningFee || 0);
      if (joiningFeeMinor > 0) {
        finalAmountMinor = Math.max(0, finalAmountMinor - joiningFeeMinor);
      }
    }
  }

  const updatePayload = {
    status: PaymentStatus.COMPLETED,
    amount: fromMinorUnits(finalAmountMinor),
    paidAt: new Date(),
    verifiedAt: new Date(),
    verifiedBy: verifiedByUserId,
    notes: notes || payment.notes,
  };
  if (!payment.businessDate) {
    const ledgerService = require('./ledger.service');
    const effectivePayment = {
      ...(payment.dataValues || payment),
      paidAt: payment.paidAt || updatePayload.paidAt,
    };
    const originalTime = ledgerService.getPaymentCollectionTime(effectivePayment);
    updatePayload.businessDate = await ledgerService.stampBusinessDate(tenantDb, payment.branchId, originalTime);
  }

  const targetBusinessDate = payment.businessDate || updatePayload.businessDate;
  if (payment.branchId && targetBusinessDate && tenantDb.models.LedgerDay) {
    const closedDay = await tenantDb.models.LedgerDay.findOne({
      where: {
        branchId: payment.branchId,
        businessDate: targetBusinessDate,
        status: 'CLOSED',
      },
    });
    if (closedDay) {
      const err = createError(
        `Ledger day ${targetBusinessDate} for this branch is closed. Cannot verify payment into a closed day.`,
        409
      );
      err.code = 'ledger_day_closed';
      throw err;
    }
  }

  await payment.update(updatePayload, { fromPaymentServiceTransition: true });

  const finalBusinessDate = payment.businessDate || updatePayload.businessDate;
  if (payment.branchId && finalBusinessDate) {
    require('./ledger.service').notifyLedgerUpdated(tenantDb.tenantId, payment.branchId, finalBusinessDate);
  }

  if (payment.referenceEntityId) {
    const [invoicesUpdated] = await Invoice.update(
      { status: InvoiceStatus.PAID, paidAt: new Date(), totalAmount: finalAmount },
      { where: { referenceEntityId: payment.referenceEntityId, status: InvoiceStatus.ISSUED } }
    );

    // A verified payment with no matching ISSUED invoice to mark PAID used to
    // just stop here — the update matched zero rows and nothing was logged,
    // so the payment ended up verified with no invoice ever existing for it.
    // Every subscription created before invoices were consistently generated
    // on enrolment hits this. A completed payment should always have a paid
    // invoice behind it, so this creates the missing one rather than leaving
    // the gap: same _createInvoice() the direct-payment path already uses.
    if (invoicesUpdated === 0 && payment.paymentFor === 'MEMBERSHIP') {
      try {
        const subscription = await MemberSubscription.findByPk(payment.referenceEntityId);
        if (subscription) {
          const plan = await MembershipPlan.findByPk(subscription.membershipPlanId);
          if (plan) {
            await _createInvoice(tenantDb.models, {
              userId: payment.userId,
              payment,
              subscription,
              plan,
              createdBy: verifiedByUserId,
              createdByRole: 'HOST',
              branchId: payment.branchId || subscription.branchId,
            });
          }
        }
      } catch (err) {
        console.warn('[payments] backfill invoice on verify failed:', err.message);
      }
    }

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
 * Actions (permission already checked by the controller against the payment's
 * own branch — payments.record for collect/reject, payments.verify for verify):
 *  collect  → PENDING → STAFF_COLLECTED (step 1)
 *  verify   → (PENDING | STAFF_COLLECTED) → COMPLETED (step 2)
 *  reject   → (PENDING | STAFF_COLLECTED) → FAILED
 */
const verifyOrRejectPayment = async (tenantDb, paymentId, actorUserId, actorRole, { action, notes, rejectedReason, waiveJoiningFee }) => {
  const { Payment, Invoice } = tenantDb.models;

  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw createError('Payment not found', 404);

  if (action === 'collect') {
    if (payment.branchId && tenantDb.models.Branch) {
      const branch = await tenantDb.models.Branch.findByPk(payment.branchId);
      if (branch) {
        const { assertBranchNotBillingLocked } = require('./branch-billing-lock.service');
        assertBranchNotBillingLocked(branch);
      }
    }
    if (payment.status !== PaymentStatus.PENDING) {
      throw createError(`Cannot collect a payment that is already ${payment.status.toLowerCase()}`, 409);
    }
    await payment.update({
      status: PaymentStatus.STAFF_COLLECTED,
      staffCollectedBy: actorUserId,
      collectedAt: new Date(),
      notes: notes || payment.notes,
    });
    if (payment.branchId && payment.businessDate) {
      require('./ledger.service').notifyLedgerUpdated(tenantDb.tenantId, payment.branchId, payment.businessDate);
    }

  } else if (action === 'verify') {
    // Permission already checked by the controller (payments.verify on this
    // payment's own branch) — it needs the branch to resolve that, which is why
    // the check lives there instead of here.
    return verifyPayment(tenantDb, paymentId, actorUserId, notes, waiveJoiningFee);

  } else if (action === 'reject') {
    const rejectableStatuses = [PaymentStatus.PENDING, PaymentStatus.STAFF_COLLECTED];
    if (!rejectableStatuses.includes(payment.status)) {
      throw createError(`Payment is already ${payment.status.toLowerCase()}`, 409);
    }
    await payment.update({
      status: PaymentStatus.FAILED,
      verifiedAt: new Date(),
      verifiedBy: actorUserId,
      rejectedReason: rejectedReason || null,
      notes: notes || payment.notes,
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
  const { Payment, Branch } = tenantDb.models;

  if (Branch && Array.isArray(paymentIds) && paymentIds.length > 0) {
    const payments = await Payment.findAll({
      where: { id: paymentIds, status: PaymentStatus.PENDING },
    });
    const branchIds = [...new Set(payments.map((p) => p.branchId).filter(Boolean))];
    if (branchIds.length > 0) {
      const branches = await Branch.findAll({ where: { id: branchIds } });
      const { assertBranchNotBillingLocked } = require('./branch-billing-lock.service');
      for (const branch of branches) {
        assertBranchNotBillingLocked(branch);
      }
    }
  }

  const [updatedCount] = await Payment.update(
    {
      status: PaymentStatus.STAFF_COLLECTED,
      staffCollectedBy: staffUserId,
      collectedAt: new Date(),
    },
    {
      where: {
        id: paymentIds,
        status: PaymentStatus.PENDING,
      },
      individualHooks: true,
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
    const user = await User.findByPk(payment.userId, { attributes: ['id', 'email', 'fullName'] });
    if (user) {
      const formattedGymName = gymName || 'your gym';
      const formattedAmount = payment.amount;
      const formattedCurrency = payment.currency || 'PKR';

      // 1. In-app notification, WebSocket broadcast, and FCM push notification
      await notificationsService.createNotification({
        userId: user.id,
        role: 'traveler',
        type: 'warning',
        title: 'Payment Failed',
        message: `Your payment of ${formattedCurrency} ${formattedAmount} for ${formattedGymName} could not be processed.`,
        priority: 'high',
        metadataJson: {
          event: 'payment_failed',
          paymentId: payment.id,
          amount: formattedAmount,
          currency: formattedCurrency,
          gymName: formattedGymName,
        },
      }).catch((notifErr) => {
        console.warn('[Notification Error] Failed to create PAYMENT_FAILED notification:', notifErr.message);
      });

      // 2. Direct email delivery via SMTP
      await emailService.sendPaymentFailedEmail(
        user.email,
        user.fullName,
        formattedGymName,
        formattedAmount,
        formattedCurrency
      ).catch((mailErr) => {
        console.warn('[Email Error] Failed to send PAYMENT_FAILED email:', mailErr.message);
      });
    }
  } catch (err) {
    console.warn('[Notification] Failed to dispatch PAYMENT_FAILED notification:', err.message);
  }

  return payment.reload();
};

// ── GET /invoices ──────────────────────────────────────────────────────────────
const listInvoices = async (
  tenantDb,
  requestingUserId,
  isHost,
  { userId, branchId, status, from, to, page, limit, offset }
) => {
  const { Invoice } = tenantDb.models;
  const where = {};

  if (!isHost) {
    where.userId = requestingUserId;
  } else if (userId) {
    where.userId = userId;
  }

  // Scopes a branch-level team member (a Branch Admin, say) to their own
  // branch's invoices. Previously unfiltered: "host/manager see all" meant a
  // Branch Admin — who is a manager only of one branch — saw the whole
  // organization's billing. The full-organization view stays available by
  // simply omitting branchId, which is what an ORG-scoped caller does.
  if (branchId) where.branchId = branchId;

  if (status) where.status = status;

  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt[Op.gte] = new Date(`${from}T00:00:00.000Z`);
    if (to) where.createdAt[Op.lte] = new Date(`${to}T23:59:59.999Z`);
  }

  const { count, rows } = await Invoice.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  const { enrichAuditDetails } = require('../utils/audit.utils');
  const enrichedInvoices = await enrichAuditDetails(tenantDb, rows);

  return { invoices: enrichedInvoices, pagination: buildPagination(count, page, limit) };
};

// ── GET /invoices/:id ──────────────────────────────────────────────────────────
const getInvoice = async (tenantDb, invoiceId, requestingUserId, isHost) => {
  const { Invoice } = tenantDb.models;
  const where = { id: invoiceId };
  if (!isHost) where.userId = requestingUserId;

  const invoice = await Invoice.findOne({ where });
  if (!invoice) throw createError('Invoice not found', 404);

  const { enrichAuditDetails } = require('../utils/audit.utils');
  const [enriched] = await enrichAuditDetails(tenantDb, [invoice]);
  return enriched;
};

module.exports = {
  recordPayment, listPayments, getPayment, verifyPayment, verifyOrRejectPayment,
  uploadPaymentProof, collectionAction, markPaymentFailed,
  listInvoices, getInvoice,
};
