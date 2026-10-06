const crypto = require('crypto');
const { Op } = require('sequelize');
const { GymListing, Tenant, UserGymMembership, User } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError, buildPagination } = require('../utils/response.utils');
const { SubscriptionStatus } = require('../constants/subscription-status');
const { PaymentStatus, InvoiceStatus } = require('../constants/payment-status');
const {
  toMinorUnits,
  fromMinorUnits,
  toMajorUnitsNumber,
  compareMoney,
  subtractMoney,
} = require('../utils/money.utils');
const notificationsService = require('./notifications.service');
const emailService = require('./email.service');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Calculate the subscription end date from a start date and plan duration.
 * Returns an ISO date string (YYYY-MM-DD).
 */
const _calcEndDate = (startDate, durationType, durationValue) => {
  const d = new Date(startDate);
  switch (durationType) {
    case 'DAILY': d.setDate(d.getDate() + durationValue); break;
    case 'WEEKLY': d.setDate(d.getDate() + durationValue * 7); break;
    case 'MONTHLY': d.setMonth(d.getMonth() + durationValue); break;
    case 'QUARTERLY': d.setMonth(d.getMonth() + durationValue * 3); break;
    case 'YEARLY': d.setFullYear(d.getFullYear() + durationValue); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().split('T')[0];
};

const { getNextInvoiceNumber } = require('./invoice-sequence.service');

// Payments a member has started for a subscription that nobody has settled yet.
const LIVE_PAYMENT_STATUSES = [PaymentStatus.PENDING, PaymentStatus.STAFF_COLLECTED];

/**
 * Generate a unique QR token for a new subscription.
 */
const _generateQrToken = () => `GE-${crypto.randomBytes(20).toString('hex').toUpperCase()}`;

/**
 * Resolve tenant DB from a GymListing UUID.
 * Returns { models, tenantId, encryptedConnStr }.
 */
const _resolveTenant = async (gymListingId) => {
  let listing = await GymListing.findOne({
    where: { id: gymListingId, status: 'ACTIVE' },
    attributes: ['id', 'tenantId', 'title'],
  });

  let tenantId = listing ? listing.tenantId : null;

  if (!listing) {
    // If listing not found, it could be a branch ID directly
    const tenants = await Tenant.findAll({
      where: { status: 'ACTIVE' },
      attributes: ['id', 'connectionStringEncrypted'],
    });

    for (const t of tenants) {
      try {
        if (!t.connectionStringEncrypted || t.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
        const tenantDb = await TenantDbManager.getConnection(t.id, t.connectionStringEncrypted);
        const { Branch } = tenantDb.models;
        const branch = await Branch.findByPk(gymListingId);
        if (branch) {
          tenantId = t.id;
          if (branch.gymListingId) {
            listing = await GymListing.findOne({
              where: { id: branch.gymListingId, status: 'ACTIVE' },
              attributes: ['id', 'tenantId', 'title'],
            });
          }
          break;
        }
      } catch (err) {
        // Ignore
      }
    }
  }

  if (!tenantId) throw createError('Gym not found or not active', 404);

  if (!listing) {
    listing = await GymListing.findOne({
      where: { tenantId, status: 'ACTIVE' },
      attributes: ['id', 'tenantId', 'title'],
    });
  }
  if (!listing) throw createError('Gym listing not found or not active', 404);

  const tenant = await Tenant.findOne({
    where: { id: tenantId, status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted', 'ownerUserId'],
  });
  if (!tenant) throw createError('Gym tenant is not available', 503);

  const { models } = await TenantDbManager.getConnection(
    tenant.id,
    tenant.connectionStringEncrypted
  );
  return { models, tenantId: tenant.id, gymListing: listing };
};

/**
 * Resolve tenant DB from a subscriptionId via the Platform cross-tenant index.
 * Tries subscriptionId field first; falls back to matching by UserGymMembership.id
 * to handle cases where the client sends the membership record's own PK.
 */
const _resolveBySubscriptionId = async (subscriptionId, userId) => {
  let index = await UserGymMembership.findOne({ where: { subscriptionId, userId } });
  if (!index) {
    index = await UserGymMembership.findOne({ where: { id: subscriptionId, userId } });
  }

  if (!index) throw createError('Subscription not found', 404);

  // Use the real MemberSubscription UUID stored in the index; fall back to the
  // passed value only if the field was never populated (older records).
  const resolvedSubscriptionId = index.subscriptionId || subscriptionId;

  const tenant = await Tenant.findOne({
    where: { id: index.tenantId, status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });
  if (!tenant) throw createError('Gym tenant is not available', 503);

  const { models } = await TenantDbManager.getConnection(
    tenant.id,
    tenant.connectionStringEncrypted
  );
  return { models, index, resolvedSubscriptionId };
};

/**
 * Server price of a membership's first payment, in integer minor units:
 * plan price + security fee + joining fee (waived when the member already had
 * a non-pending membership at this branch). The client never sends a price.
 */
const priceFirstPayment = async (models, plan, userId, branchId) => {
  const hasPreviousSubscription = await models.MemberSubscription.findOne({
    where: {
      userId,
      branchId,
      status: {
        [Op.not]: SubscriptionStatus.PENDING,
      },
    },
  });
  const subtotalMinor = toMinorUnits(plan.price);
  const joiningMinor = hasPreviousSubscription ? 0 : toMinorUnits(plan.joiningFee || 0);
  const securityMinor = toMinorUnits(plan.securityFee || 0);
  return { subtotalMinor, totalAmountMinor: subtotalMinor + joiningMinor + securityMinor };
};

// ── POST /subscriptions ───────────────────────────────────────────────────────
const subscribe = async (userId, { planId, gymListingId, branchId, autoRenew, sourceChannel }) => {
  const { models, tenantId, gymListing } = await _resolveTenant(gymListingId);
  const { MembershipPlan, MemberSubscription, MemberProfile, Payment, Invoice } = models;

  const plan = await MembershipPlan.findOne({ where: { id: planId, status: 'ACTIVE' } });
  if (!plan) throw createError('Membership plan not found or inactive', 404);

  let branchIdToUse = branchId;
  if (!branchIdToUse || branchIdToUse === 'branch-1' || branchIdToUse.trim() === '') {
    const firstBranch = await models.Branch.findOne({ where: { status: 'ACTIVE' }, order: [['createdAt', 'ASC']] });
    if (firstBranch) {
      branchIdToUse = firstBranch.id;
    }
  }

  const branch = await models.Branch.findOne({ where: { id: branchIdToUse, status: 'ACTIVE' } });
  if (!branch) throw createError('Branch not found or inactive', 404);

  const { assertBranchNotBillingLocked } = require('./branch-billing-lock.service');
  assertBranchNotBillingLocked(branch);

  const existing = await MemberSubscription.findOne({
    where: {
      userId,
      branchId: branchIdToUse,
      status: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PENDING, SubscriptionStatus.FROZEN],
    },
  });
  if (existing) throw createError('You already have an active or pending subscription at this branch', 409);

  const startDate = new Date().toISOString().split('T')[0];
  const endDate = _calcEndDate(startDate, plan.durationType, plan.durationValue);
  const qrCode = null;

  await MemberProfile.findOrCreate({ where: { userId }, defaults: { userId } });

  // Subscription starts PENDING — becomes ACTIVE only after payment is verified
  const subscription = await MemberSubscription.create({
    userId,
    branchId: branchIdToUse,
    membershipPlanId: planId,
    startDate,
    endDate,
    status: SubscriptionStatus.PENDING,
    autoRenew: autoRenew ?? false,
    qrCode,
    subscribedAt: new Date(),
    remainingVisits: plan.visitLimit ?? null,
    sourceChannel: sourceChannel ?? 'ONLINE',
    createdBy: userId,
    createdByRole: 'MEMBER',
  });

  // Write cross-tenant index (PENDING until payment verified)
  await UserGymMembership.create({
    userId,
    tenantId,
    gymListingId: gymListing.id,
    subscriptionId: subscription.id,
    gymName: gymListing.title,
    planName: plan.name,
    startDate,
    endDate,
    status: SubscriptionStatus.PENDING,
  });

  // Create pending payment + issued invoice
  const { subtotalMinor, totalAmountMinor } = await priceFirstPayment(models, plan, userId, branchIdToUse);
  const totalAmount = fromMinorUnits(totalAmountMinor);

  const ledgerService = require('./ledger.service');
  const businessDate = await ledgerService.stampBusinessDate({ models }, branchIdToUse);

  const payment = await Payment.create({
    userId,
    paymentFor: 'MEMBERSHIP',
    referenceEntityId: subscription.id,
    branchId: branchIdToUse,
    method: 'BANK_TRANSFER',
    amount: totalAmount,
    currency: 'PKR',
    status: PaymentStatus.PENDING,
    businessDate,
  });

  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const invoiceNo = await getNextInvoiceNumber(models.Invoice.sequelize, branchIdToUse);
  const invoice = await Invoice.create({
    userId,
    invoiceNo,
    invoiceType: 'MEMBERSHIP',
    referenceEntityId: subscription.id,
    subtotal: fromMinorUnits(subtotalMinor),
    discountAmount: '0.00',
    taxAmount: '0.00',
    totalAmount,
    dueDate,
    status: InvoiceStatus.ISSUED,
  });

  // Create unified in-app notifications
  try {
    const notificationsService = require('./notifications.service');
    const travelerUser = await User.findByPk(userId);
    const travelerName = travelerUser ? travelerUser.fullName : 'Traveler';

    // 1. Recipient: Traveler
    await notificationsService.createNotification({
      userId,
      role: 'traveler',
      type: 'subscription_pending',
      title: 'Subscription Pending',
      message: "Subscription submitted — awaiting verification. We'll notify you once it's confirmed.",
      deepLink: '/traveler/subscriptions',
      metadataJson: { subscriptionId: subscription.id },
    });

    // 2. Recipient: Host
    const { Tenant } = require('../models/platform');
    const tenant = await Tenant.findByPk(tenantId);
    if (tenant && tenant.ownerUserId) {
      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'subscription_pending',
        title: 'New Subscription Request',
        message: `New subscription request from ${travelerName} for ${plan.name} at ${gymListing.title}.`,
        deepLink: `/host/gyms?tab=subscriptions&filter=PENDING&subscriptionId=${subscription.id}`,
        metadataJson: {
          subscriptionId: subscription.id,
          branchId: branchIdToUse,
          userId,
          customerId: userId,
          customerName: travelerName,
          planName: plan.name,
        },
      });
    }
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create subscription pending notifications:', notifErr.message);
  }


  return { subscription, qrCode, payment, invoice };
};

// ── GET /me/subscriptions ─────────────────────────────────────────────────────
const listMySubscriptions = async (userId, { status, page, limit, offset }) => {
  const where = { userId };
  if (status) where.status = status;

  const { count, rows } = await UserGymMembership.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return {
    memberships: rows,
    pagination: buildPagination(count, page, limit),
  };
};

// ── POST /subscriptions/:id/freeze ────────────────────────────────────────────
const freeze = async (userId, subscriptionId, optsOrFrom, maybeTo) => {
  const freezeFrom = typeof optsOrFrom === 'object' && optsOrFrom !== null ? optsOrFrom.freezeFrom : optsOrFrom;
  const freezeTo = typeof optsOrFrom === 'object' && optsOrFrom !== null ? optsOrFrom.freezeTo : maybeTo;

  const { models, index, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription } = models;

  const sub = await MemberSubscription.findOne({ where: { id: resolvedSubscriptionId } });
  if (!sub) throw createError('Subscription not found in tenant database', 404);
  if (sub.status !== SubscriptionStatus.ACTIVE) {
    throw createError(`Cannot freeze a subscription with status: ${sub.status}`, 409);
  }

  // Check freeze allowance (freezeLimitDays on the plan)
  const plan = await models.MembershipPlan.findByPk(sub.membershipPlanId);
  if (plan && plan.freezeLimitDays === 0) {
    throw createError('This plan does not allow freezing', 400);
  }
  const startEpoch = new Date(freezeFrom).getTime();
  const endEpoch = new Date(freezeTo).getTime();
  const freezeDays = Math.max(1, Math.round((endEpoch - startEpoch) / 86400000));
  if (plan && freezeDays > plan.freezeLimitDays) {
    throw createError(`Freeze duration exceeds the plan limit of ${plan.freezeLimitDays} days`, 400);
  }

  // Extend endDate by the frozen days (spec §12.3, FLOW-06)
  const curEndDate = new Date(sub.endDate);
  curEndDate.setDate(curEndDate.getDate() + freezeDays);
  const extendedEndDate = curEndDate.toISOString().split('T')[0];

  await sub.update({
    status: SubscriptionStatus.FROZEN,
    freezeFrom,
    freezeTo,
    endDate: extendedEndDate,
  });

  // Sync status and extended endDate in Platform index
  await index.update({
    status: SubscriptionStatus.FROZEN,
    endDate: extendedEndDate,
  });

  return sub.reload();
};

// ── POST /subscriptions/:id/unfreeze ──────────────────────────────────────────
const unfreeze = async (userId, subscriptionId) => {
  const { models, index, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription, Branch } = models;

  const sub = await MemberSubscription.findOne({ where: { id: resolvedSubscriptionId } });
  if (!sub) throw createError('Subscription not found in tenant database', 404);
  if (sub.status !== SubscriptionStatus.FROZEN) {
    throw createError(`Cannot unfreeze a subscription with status: ${sub.status}`, 409);
  }

  let branchTimezone = 'Asia/Karachi';
  if (sub.branchId) {
    const branch = await Branch.findByPk(sub.branchId);
    if (branch && branch.timezone) branchTimezone = branch.timezone;
  }

  const { computeBusinessDate } = require('./ledger.service');
  const todayInTz = computeBusinessDate(new Date(), branchTimezone);
  const nextStatus = sub.endDate < todayInTz ? SubscriptionStatus.EXPIRED : SubscriptionStatus.ACTIVE;

  await sub.update({
    status: nextStatus,
  });

  await index.update({
    status: nextStatus,
    endDate: sub.endDate,
  });

  return sub.reload();
};

// ── POST /subscriptions/:id/cancel ────────────────────────────────────────────
const cancel = async (userId, subscriptionId) => {
  const { models, index, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription } = models;

  const sub = await MemberSubscription.findOne({ where: { id: resolvedSubscriptionId } });
  if (!sub) throw createError('Subscription not found in tenant database', 404);
  if ([SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED].includes(sub.status)) {
    throw createError(`Subscription is already ${sub.status.toLowerCase()}`, 409);
  }

  await sub.update({ status: SubscriptionStatus.CANCELLED, cancelledAt: new Date() });
  await index.update({ status: SubscriptionStatus.CANCELLED });

  return sub.reload();
};

/**
 * Extend a subscription by one period of `plan` and make it ACTIVE (FLOW-06
 * dates: from customStartDate, else max(today, endDate) in the branch
 * timezone). Runs only once the renewal is paid for — from verifyPayment, or
 * from the host-approved staff renewal. A cancelled subscription is left alone.
 */
const applyRenewal = async (models, subscriptionId, planId, customStartDate = null) => {
  const { MemberSubscription } = models;
  const sub = await MemberSubscription.findByPk(subscriptionId);
  if (!sub || sub.status === SubscriptionStatus.CANCELLED) return null;
  const plan = await models.MembershipPlan.findByPk(planId);
  if (!plan) return null;

  // Extend from customStartDate or max(now, sub.endDate) in the branch timezone (FLOW-06)
  let branchTimezone = 'Asia/Karachi';
  if (sub.branchId) {
    const branch = await models.Branch.findByPk(sub.branchId);
    if (branch && branch.timezone) {
      branchTimezone = branch.timezone;
    }
  }

  const { computeBusinessDate } = require('./ledger.service');
  const todayInBranchTz = computeBusinessDate(new Date(), branchTimezone);

  let defaultBaseDate = todayInBranchTz;
  if (sub.endDate && sub.endDate > todayInBranchTz) {
    defaultBaseDate = sub.endDate;
  }

  const baseDate = customStartDate || defaultBaseDate;
  const newEndDate = _calcEndDate(baseDate, plan.durationType, plan.durationValue);
  const newQr = _generateQrToken();

  await sub.update({
    membershipPlanId: plan.id,
    status: SubscriptionStatus.ACTIVE,
    startDate: baseDate,
    endDate: newEndDate,
    qrCode: newQr,
    remainingVisits: plan.visitLimit ?? null,
    freezeFrom: null,
    freezeTo: null,
    cancelledAt: null,
  });
  const index = await UserGymMembership.findOne({ where: { subscriptionId: sub.id } });
  if (index) {
    await index.update({
      status: SubscriptionStatus.ACTIVE,
      startDate: baseDate,
      endDate: newEndDate,
      planName: plan.name,
    });
  }

  // Direct notifications (in-app, push, email)
  try {
    const user = await User.findByPk(sub.userId, { attributes: ['id', 'email', 'fullName'] });
    if (user) {
      const gymName = (index && index.gymName) || 'your gym';
      // 1. In-app notification, WebSocket broadcast, and FCM push
      await notificationsService.createNotification({
        userId: user.id,
        role: 'traveler',
        type: 'subscription',
        title: 'Subscription Renewed',
        message: `Your ${plan.name} at ${gymName} has been renewed until ${newEndDate}.`,
        deepLink: '/traveler/subscriptions',
        metadataJson: {
          event: 'subscription_renewed',
          subscriptionId: sub.id,
          planName: plan.name,
          gymName,
          endDate: newEndDate,
        },
      }).catch((notifErr) => {
        console.warn('[Notification Error] Failed to create SUBSCRIPTION_RENEWED notification:', notifErr.message);
      });

      // 2. Direct email delivery via SMTP
      await emailService.sendSubscriptionRenewedEmail(
        user.email,
        user.fullName,
        gymName,
        plan.name,
        newEndDate
      ).catch((mailErr) => {
        console.warn('[Email Error] Failed to send SUBSCRIPTION_RENEWED email:', mailErr.message);
      });
    }
  } catch (err) {
    console.warn('[Notification] Failed to dispatch SUBSCRIPTION_RENEWED notification:', err.message);
  }

  return { subscription: await sub.reload(), qrCode: newQr };
};

// ── POST /subscriptions/:id/renew ─────────────────────────────────────────────
// Member path (NEW-40): records a PENDING renewal payment at the server price;
// the extension applies only when that payment is verified. `approvedByHost`
// is the host approving a staff renewal request, which applies at once.
const renew = async (userId, subscriptionId, targetPlanId = null, customStartDate = null, { approvedByHost = false } = {}) => {
  const { models, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription, Payment, Invoice } = models;

  const sub = await MemberSubscription.findOne({ where: { id: resolvedSubscriptionId } });
  if (!sub) throw createError('Subscription not found in tenant database', 404);
  if (sub.status === SubscriptionStatus.CANCELLED) {
    throw createError('Cancelled subscriptions cannot be renewed', 409);
  }

  if (sub.branchId) {
    const branch = await models.Branch.findByPk(sub.branchId);
    if (branch) {
      const { assertBranchNotBillingLocked } = require('./branch-billing-lock.service');
      assertBranchNotBillingLocked(branch);
    }
  }

  const effectivePlanId = targetPlanId || sub.membershipPlanId;
  let plan = await models.MembershipPlan.findByPk(effectivePlanId);

  // If plan is not found or inactive, fallback to any active plan for this branch/gym
  if (!plan || plan.status !== 'ACTIVE') {
    if (sub.branchId) {
      plan = await models.MembershipPlan.findOne({
        where: { branchId: sub.branchId, status: 'ACTIVE' },
        order: [['createdAt', 'DESC']],
      });
    }
  }

  if (!plan || plan.status !== 'ACTIVE') {
    throw createError('The associated membership plan is no longer available', 409);
  }

  if (approvedByHost) {
    return applyRenewal(models, sub.id, plan.id, customStartDate);
  }

  if (sub.status === SubscriptionStatus.PENDING) {
    throw createError('This membership is still waiting for its first payment', 409);
  }
  const openPayment = await Payment.findOne({
    where: { referenceEntityId: sub.id, status: LIVE_PAYMENT_STATUSES },
  });
  if (openPayment) {
    throw createError('This membership already has a payment awaiting verification', 409);
  }

  // One period of the plan, integer minor units (PAY-02). Dates are worked
  // out when the payment is verified, so a member-chosen start date is ignored.
  const amount = fromMinorUnits(toMinorUnits(plan.price));
  const businessDate = await require('./ledger.service').stampBusinessDate({ models }, sub.branchId);
  const payment = await Payment.create({
    userId: sub.userId,
    paymentFor: 'MEMBERSHIP',
    referenceEntityId: sub.id,
    branchId: sub.branchId,
    method: 'BANK_TRANSFER',
    amount,
    currency: 'PKR',
    status: PaymentStatus.PENDING,
    notes: `Renewal: ${plan.name}`,
    businessDate,
    pendingChangeJson: JSON.stringify({ type: 'RENEW', planId: plan.id }),
  });

  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const invoiceNo = await getNextInvoiceNumber(models.Invoice.sequelize, sub.branchId);
  const invoice = await Invoice.create({
    userId: sub.userId,
    invoiceNo,
    invoiceType: 'MEMBERSHIP',
    referenceEntityId: sub.id,
    branchId: sub.branchId,
    subtotal: amount,
    discountAmount: '0.00',
    taxAmount: '0.00',
    totalAmount: amount,
    dueDate,
    status: InvoiceStatus.ISSUED,
  });

  return { subscription: sub, qrCode: null, payment, invoice, applied: false };
};

// ── POST /subscriptions/:id/change-plan ──────────────────────────────────────────
const changePlan = async (userId, subscriptionId, newPlanId) => {
  const { models, index, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription, MembershipPlan } = models;

  const sub = await MemberSubscription.findOne({ where: { id: resolvedSubscriptionId } });
  if (!sub) throw createError('Subscription not found in tenant database', 404);

  if (sub.branchId && models.Branch) {
    const branch = await models.Branch.findByPk(sub.branchId);
    if (branch) {
      const { assertBranchNotBillingLocked } = require('./branch-billing-lock.service');
      assertBranchNotBillingLocked(branch);
    }
  }

  // Find the new membership plan
  const newPlan = await MembershipPlan.findByPk(newPlanId);
  if (!newPlan || newPlan.status !== 'ACTIVE') {
    throw createError('The selected membership plan is not available or inactive', 404);
  }

  // Update the fields: pendingPlanId, pendingChangeEffectiveDate (start of next cycle = current endDate)
  await sub.update({
    pendingPlanId: newPlanId,
    pendingChangeEffectiveDate: sub.endDate,
  });

  return { subscription: await sub.reload() };
};

// ── Staff: list all subscriptions in tenant DB ────────────────────────────────
const listForStaff = async (tenantDb, { status, branchId, userId, page, limit, offset }) => {
  const { MemberSubscription, MembershipPlan, Branch, Payment } = tenantDb.models;

  const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
  const activeBranchIds = activeBranches.map((b) => b.id);
  if (activeBranchIds.length === 0) {
    return { count: 0, rows: [] };
  }

  const where = {};
  if (status) where.status = status;
  if (branchId) {
    if (!activeBranchIds.includes(branchId)) {
      return { count: 0, rows: [] };
    }
    where.branchId = branchId;
  } else {
    where.branchId = { [Op.in]: activeBranchIds };
  }
  if (userId) where.userId = userId;

  const { count, rows } = await MemberSubscription.findAndCountAll({
    where,
    include: [
      { model: MembershipPlan, as: 'plan', attributes: ['id', 'name', 'price', 'durationType', 'durationValue'] },
      { model: MembershipPlan, as: 'pendingPlan', attributes: ['id', 'name', 'price', 'durationType', 'durationValue'] },
      { model: Branch, as: 'branch', attributes: ['id', 'branchName'], where: { status: 'ACTIVE' }, required: false },
    ],
    order: [['subscribedAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  const { enrichAuditDetails } = require('../utils/audit.utils');
  const enrichedSubs = await enrichAuditDetails(tenantDb, rows);

  // Fetch latest payment per subscription
  const subIds = rows.map((r) => r.id);
  const payments = subIds.length
    ? await Payment.findAll({
      where: { referenceEntityId: subIds, paymentFor: 'MEMBERSHIP' },
      attributes: ['id', 'referenceEntityId', 'status', 'method', 'amount', 'proofUrl', 'createdBy', 'createdByRole', 'verifiedBy', 'verifiedAt', 'createdAt'],
      order: [['createdAt', 'DESC']],
    })
    : [];
  const enrichedPayments = await enrichAuditDetails(tenantDb, payments);

  // Keep only the latest payment per subscription
  const paymentMap = {};
  for (const p of enrichedPayments) {
    if (!paymentMap[p.referenceEntityId]) paymentMap[p.referenceEntityId] = p;
  }

  const subscriptions = enrichedSubs.map((s) => ({
    ...s,
    latestPayment: paymentMap[s.id] || null,
  }));

  return {
    subscriptions,
    pagination: buildPagination(count, page, limit),
  };
};

// ── Staff: get single subscription ───────────────────────────────────────────
const getForStaff = async (tenantDb, subscriptionId) => {
  const { MemberSubscription, MembershipPlan, Branch, Payment, Invoice } = tenantDb.models;

  const sub = await MemberSubscription.findOne({
    where: { id: subscriptionId },
    include: [
      { model: MembershipPlan, as: 'plan' },
      { model: Branch, as: 'branch', attributes: ['id', 'branchName', 'address'] },
    ],
  });
  if (!sub) throw createError('Subscription not found', 404);

  const { enrichAuditDetails } = require('../utils/audit.utils');
  const [enrichedSub] = await enrichAuditDetails(tenantDb, [sub]);

  const payments = await Payment.findAll({
    where: { referenceEntityId: subscriptionId, paymentFor: 'MEMBERSHIP' },
    order: [['createdAt', 'DESC']],
  });
  const enrichedPayments = await enrichAuditDetails(tenantDb, payments);

  const invoice = await Invoice.findOne({
    where: { referenceEntityId: subscriptionId },
    order: [['createdAt', 'DESC']],
  });
  const [enrichedInvoice] = invoice ? await enrichAuditDetails(tenantDb, [invoice]) : [null];

  return { subscription: enrichedSub, payments: enrichedPayments, invoice: enrichedInvoice };
};

// ── Preview: dry-run date + price calculation without DB commit ───────────────
const previewSubscription = async (tenantDb, { planId, startDate, autoRenew }) => {
  const { MembershipPlan } = tenantDb.models;

  const plan = await MembershipPlan.findOne({ where: { id: planId, status: 'ACTIVE' } });
  if (!plan) throw createError('Plan not found or inactive', 404);

  const start = startDate || new Date().toISOString().split('T')[0];
  const endDate = _calcEndDate(start, plan.durationType, plan.durationValue);

  const priceMinor = toMinorUnits(plan.price);
  const joiningMinor = toMinorUnits(plan.joiningFee || 0);
  const securityMinor = toMinorUnits(plan.securityFee || 0);
  const totalMinor = priceMinor + joiningMinor + securityMinor;

  return {
    plan: { id: plan.id, name: plan.name, durationType: plan.durationType, durationValue: plan.durationValue },
    startDate: start,
    endDate,
    price: toMajorUnitsNumber(priceMinor),
    joiningFee: toMajorUnitsNumber(joiningMinor),
    securityFee: toMajorUnitsNumber(securityMinor),
    totalPrice: toMajorUnitsNumber(totalMinor),
    autoRenew: autoRenew ?? false,
  };
};

// ── GET /subscriptions/:id/detail ─────────────────────────────────────────────
const getMySubscriptionDetail = async (userId, subscriptionId) => {
  const { models, index, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription, MembershipPlan, Branch, Payment, Invoice } = models;

  const sub = await MemberSubscription.findOne({
    where: { id: resolvedSubscriptionId, userId },
    include: [
      { model: MembershipPlan, as: 'plan' },
      { model: Branch, as: 'branch', attributes: ['id', 'branchName', 'address'] },
    ],
  });
  if (!sub) throw createError('Subscription not found', 404);

  const latestPayment = await Payment.findOne({
    where: { referenceEntityId: resolvedSubscriptionId, paymentFor: 'MEMBERSHIP', userId },
    order: [['createdAt', 'DESC']],
  });

  const invoice = await Invoice.findOne({
    where: { referenceEntityId: resolvedSubscriptionId, userId },
    order: [['createdAt', 'DESC']],
  });

  if (sub.status === SubscriptionStatus.ACTIVE) {
    const { generateAttendanceQrToken } = require('../utils/qr.utils');
    const rotatingToken = generateAttendanceQrToken({
      subscriptionId: sub.id,
      userId: sub.userId,
      tenantId: index.tenantId,
      branchId: sub.branchId,
    });
    sub.setDataValue('qrCode', rotatingToken);
    sub.setDataValue('qrToken', rotatingToken);
  }

  return { subscription: sub, gymMembership: index, payment: latestPayment, invoice };
};

// ── GET /subscriptions/:id/qr-token ───────────────────────────────────────────
const getSubscriptionQrToken = async (userId, subscriptionId) => {
  const { models, index, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription } = models;

  const sub = await MemberSubscription.findOne({
    where: { id: resolvedSubscriptionId, userId },
  });
  if (!sub) throw createError('Subscription not found', 404);
  if (sub.status !== SubscriptionStatus.ACTIVE) {
    throw createError('Subscription is not active', 400);
  }

  const { generateAttendanceQrToken, QR_TOKEN_TTL_SECONDS } = require('../utils/qr.utils');
  const qrToken = generateAttendanceQrToken({
    subscriptionId: sub.id,
    userId: sub.userId,
    tenantId: index.tenantId,
    branchId: sub.branchId,
  });

  return { qrToken, qrCode: qrToken, expiresIn: QR_TOKEN_TTL_SECONDS };
};

// ── POST /subscriptions/:id/proof — member uploads payment proof ──────────────
const uploadSubscriptionProof = async (userId, subscriptionId, proofUrl) => {
  const { models, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { Payment } = models;

  const payment = await Payment.findOne({
    where: { referenceEntityId: resolvedSubscriptionId, userId, status: PaymentStatus.PENDING },
    order: [['createdAt', 'DESC']],
  });
  if (!payment) throw createError('No pending payment found for this subscription', 404);

  await payment.update({ proofUrl });
  return payment.reload();
};

// ── Staff: POST /subscriptions/staff/:id/activate ─────────────────────────────
const activateSubscription = async (tenantDb, subscriptionId) => {
  const { MemberSubscription } = tenantDb.models;

  const sub = await MemberSubscription.findByPk(subscriptionId);
  if (!sub) throw createError('Subscription not found', 404);
  if (sub.status === SubscriptionStatus.ACTIVE) throw createError('Subscription is already active', 409);
  if (sub.status === SubscriptionStatus.CANCELLED) throw createError('Cannot activate a cancelled subscription', 409);

  if (sub.branchId && tenantDb.models.Branch) {
    const branch = await tenantDb.models.Branch.findByPk(sub.branchId);
    if (branch) {
      const { assertBranchNotBillingLocked } = require('./branch-billing-lock.service');
      assertBranchNotBillingLocked(branch);
    }
  }

  const qrCode = sub.qrCode || `GE-${crypto.randomBytes(20).toString('hex').toUpperCase()}`;
  await sub.update({ status: SubscriptionStatus.ACTIVE, qrCode });
  await UserGymMembership.update({ status: SubscriptionStatus.ACTIVE }, { where: { subscriptionId } });

  return sub.reload();
};

// ── GET /member/branches/:branchId/subscription-status ──────────────────────────
const getMemberBranchSubscriptionStatus = async (tenantDb, userId, branchId) => {
  const { MemberSubscription, MembershipPlan } = tenantDb.models;

  const activeSub = await MemberSubscription.findOne({
    where: {
      userId,
      branchId,
      status: SubscriptionStatus.ACTIVE,
    },
    include: [
      {
        model: MembershipPlan,
        as: 'plan',
        attributes: ['id', 'name', 'price', 'durationType', 'durationValue'],
      },
      {
        model: MembershipPlan,
        as: 'pendingPlan',
        attributes: ['id', 'name', 'price', 'durationType', 'durationValue'],
      },
    ],
  });

  if (activeSub) {
    return {
      hasActiveSubscription: true,
      subscription: activeSub,
    };
  } else {
    return {
      hasActiveSubscription: false,
    };
  }
};

// ── GET /member/subscriptions/:id/upgrade-options ────────────────────────────────
const getUpgradeOptions = async (userId, subscriptionId) => {
  const { models, index, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription, MembershipPlan } = models;

  const sub = await MemberSubscription.findOne({
    where: { id: resolvedSubscriptionId },
    include: [{ model: MembershipPlan, as: 'plan' }],
  });
  if (!sub) throw createError('Subscription not found', 404);

  const currentPlan = sub.plan;
  if (!currentPlan) throw createError('Current membership plan not found', 404);

  // List all other active membership plans at this branch (including gym-wide plans)
  const allPlans = await MembershipPlan.findAll({
    where: {
      branchId: {
        [Op.or]: [sub.branchId, null],
      },
      status: 'ACTIVE',
    },
  });

  // Filter to plans priced strictly higher than the current plan
  const upgradeOptions = allPlans.filter((p) => compareMoney(p.price, currentPlan.price) > 0);

  return {
    currentPlan,
    options: upgradeOptions,
  };
};

const _parsePendingChange = (payment) => {
  if (!payment || !payment.pendingChangeJson) return null;
  try {
    return JSON.parse(payment.pendingChangeJson);
  } catch (_) {
    return null;
  }
};

/**
 * Switch a subscription to the plan an upgrade payment paid for (FLOW-08).
 * Called only from verifyPayment, after the payment is COMPLETED, and from the
 * host-approved staff upgrade. A subscription that has ended since keeps its
 * plan; the money stays recorded on the payment.
 */
const applyUpgrade = async (models, subscriptionId, planId, transaction = null) => {
  const { MemberSubscription, MembershipPlan } = models;
  const opts = transaction ? { transaction } : {};
  const sub = await MemberSubscription.findByPk(subscriptionId, opts);
  if (!sub) return null;
  if ([SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED].includes(sub.status)) return null;
  const plan = await MembershipPlan.findByPk(planId, opts);
  if (!plan) return null;
  if (sub.membershipPlanId !== plan.id) {
    await sub.update({ membershipPlanId: plan.id }, opts);
  }
  await UserGymMembership.update({ planName: plan.name }, { where: { subscriptionId } }).catch((err) => {
    console.warn('[Subscription] Failed to sync planName after upgrade:', err.message);
  });
  return sub;
};

// ── POST /member/subscriptions/:id/upgrade ───────────────────────────────────────
// Member path: the new plan waits for the payment (FLOW-08); until then the
// member keeps the old plan exactly as it was. `approvedByHost` is the host
// approving a staff upgrade request, which applies at once as before.
const upgradeSubscription = async (userId, subscriptionId, newPlanId, { approvedByHost = false } = {}) => {
  const { models, index, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription, MembershipPlan, Payment, Invoice } = models;

  const sub = await MemberSubscription.findOne({
    where: { id: resolvedSubscriptionId },
    include: [{ model: MembershipPlan, as: 'plan' }],
  });
  if (!sub) throw createError('Subscription not found', 404);
  if (![SubscriptionStatus.ACTIVE, SubscriptionStatus.FROZEN].includes(sub.status)) {
    throw createError('Only an active membership can be upgraded', 409);
  }

  const openPayment = await Payment.findOne({
    where: { referenceEntityId: sub.id, status: LIVE_PAYMENT_STATUSES },
  });
  if (openPayment) {
    throw createError('This membership already has a payment awaiting verification', 409);
  }

  if (sub.branchId && models.Branch) {
    const branch = await models.Branch.findByPk(sub.branchId);
    if (branch) {
      const { assertBranchNotBillingLocked } = require('./branch-billing-lock.service');
      assertBranchNotBillingLocked(branch);
    }
  }

  const currentPlan = sub.plan;
  if (!currentPlan) throw createError('Current membership plan not found', 404);

  const newPlan = await MembershipPlan.findByPk(newPlanId);
  if (!newPlan || newPlan.status !== 'ACTIVE') {
    throw createError('Selected upgrade plan not found or inactive', 404);
  }

  if (compareMoney(newPlan.price, currentPlan.price) <= 0) {
    throw createError('Selected plan must be priced strictly higher than the current plan', 409);
  }

  const amountToPay = subtractMoney(newPlan.price, currentPlan.price);

  if (approvedByHost) {
    await applyUpgrade(models, sub.id, newPlan.id);
  }

  const businessDate = await require('./ledger.service').stampBusinessDate({ models }, sub.branchId);
  const payment = await Payment.create({
    userId: sub.userId,
    paymentFor: 'MEMBERSHIP',
    referenceEntityId: sub.id,
    branchId: sub.branchId,
    method: 'CASH',
    amount: amountToPay,
    currency: 'PKR',
    status: PaymentStatus.PENDING,
    notes: `Upgrade to ${newPlan.name}`,
    businessDate,
    pendingChangeJson: approvedByHost ? null : JSON.stringify({ type: 'UPGRADE', planId: newPlan.id }),
  });

  // Create unified Traveler notification
  try {
    const notificationsService = require('./notifications.service');
    await notificationsService.createNotification({
      userId: sub.userId,
      role: 'traveler',
      type: 'subscription_upgrade_pending',
      title: 'Upgrade Pending',
      message: `Upgrade request submitted — Rs ${amountToPay} due, pending verification.`,
      deepLink: '/traveler/subscriptions',
      metadataJson: { subscriptionId: sub.id },
    });
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create upgrade pending notification:', notifErr.message);
  }

  // 3. Create Invoice (status ISSUED)
  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const invoiceNo = await getNextInvoiceNumber(models.Invoice.sequelize, sub.branchId);
  const invoice = await Invoice.create({
    userId: sub.userId,
    invoiceNo,
    invoiceType: 'MEMBERSHIP',
    referenceEntityId: sub.id,
    subtotal: amountToPay,
    discountAmount: 0,
    taxAmount: 0,
    totalAmount: amountToPay,
    dueDate,
    status: InvoiceStatus.ISSUED,
  });

  return {
    amountToPay,
    invoiceId: invoice.id,
    paymentId: payment.id,
    // false: the old plan stays until this payment is verified (FLOW-08).
    applied: approvedByHost,
    newPlanId: newPlan.id,
  };
};

module.exports = {
  subscribe, listMySubscriptions, freeze, unfreeze, cancel, renew, changePlan,
  listForStaff, getForStaff, previewSubscription,
  getMySubscriptionDetail, uploadSubscriptionProof, activateSubscription,
  getMemberBranchSubscriptionStatus, getUpgradeOptions, upgradeSubscription,
  getSubscriptionQrToken, applyUpgrade, applyRenewal, parsePendingChange: _parsePendingChange, priceFirstPayment,
};
