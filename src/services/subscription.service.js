const crypto = require('crypto');
const { GymListing, Tenant, UserGymMembership, User } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError, buildPagination } = require('../utils/response.utils');
const { SubscriptionStatus } = require('../constants/subscription-status');
const { PaymentStatus, InvoiceStatus } = require('../constants/payment-status');
const { notificationsQueue } = require('../jobs/queues');

// ── Notification helper ───────────────────────────────────────────────────────
const _enqueueNotification = async (userId, type, extra) => {
  try {
    const user = await User.findByPk(userId, { attributes: ['email', 'fullName', 'fcmToken'] });
    if (!user) return;
    await notificationsQueue.add(
      { type, userId, email: user.email, fullName: user.fullName, fcmToken: user.fcmToken, ...extra },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
    );
  } catch (err) {
    console.warn('[Notification] Failed to enqueue:', err.message);
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Calculate the subscription end date from a start date and plan duration.
 * Returns an ISO date string (YYYY-MM-DD).
 */
const _calcEndDate = (startDate, durationType, durationValue) => {
  const d = new Date(startDate);
  switch (durationType) {
    case 'DAILY':     d.setDate(d.getDate() + durationValue);               break;
    case 'WEEKLY':    d.setDate(d.getDate() + durationValue * 7);           break;
    case 'MONTHLY':   d.setMonth(d.getMonth() + durationValue);             break;
    case 'QUARTERLY': d.setMonth(d.getMonth() + durationValue * 3);         break;
    case 'YEARLY':    d.setFullYear(d.getFullYear() + durationValue);       break;
    default:          d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().split('T')[0];
};

/**
 * Generate a unique QR token for a new subscription.
 */
const _generateQrToken = () => `GE-${crypto.randomBytes(20).toString('hex').toUpperCase()}`;

const _invoiceNo = () => {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `INV-${date}-${rand}`;
};

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
  const user = await User.findByPk(userId);
  const isStaff = user && ['GYM_HOST', 'BRANCH_MANAGER', 'FRONT_DESK'].includes(user.role);

  let index;
  if (isStaff) {
    index = await UserGymMembership.findOne({ where: { subscriptionId } });
    if (!index) {
      index = await UserGymMembership.findOne({ where: { id: subscriptionId } });
    }
  } else {
    index = await UserGymMembership.findOne({ where: { subscriptionId, userId } });
    if (!index) {
      index = await UserGymMembership.findOne({ where: { id: subscriptionId, userId } });
    }
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

  // Check if they have any past approved/completed subscriptions at this branch
  const { Op } = require('sequelize');
  const hasPreviousSubscription = await MemberSubscription.findOne({
    where: {
      userId,
      branchId: branchIdToUse,
      status: {
        [Op.not]: SubscriptionStatus.PENDING,
      },
    },
  });

  // Create pending payment + issued invoice
  const subtotal    = parseFloat(plan.price);
  const joining     = hasPreviousSubscription ? 0.0 : parseFloat(plan.joiningFee  || 0);
  const security    = parseFloat(plan.securityFee || 0);
  const totalAmount = subtotal + joining + security;

  const payment = await Payment.create({
    userId,
    paymentFor:        'MEMBERSHIP',
    referenceEntityId: subscription.id,
    branchId:          branchIdToUse,
    method:            'BANK_TRANSFER',
    amount:            totalAmount,
    currency:          'PKR',
    status:            PaymentStatus.PENDING,
  });

  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const invoice = await Invoice.create({
    userId,
    invoiceNo:         _invoiceNo(),
    invoiceType:       'MEMBERSHIP',
    referenceEntityId: subscription.id,
    subtotal,
    discountAmount: 0,
    taxAmount:      0,
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
        deepLink: `/host/gyms/${branchIdToUse}/subscriptions`,
        metadataJson: { subscriptionId: subscription.id, branchId: branchIdToUse },
      });
    }
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create subscription pending notifications:', notifErr.message);
  }

  _enqueueNotification(userId, 'SUBSCRIPTION_PENDING', {
    gymName: gymListing.title,
    planName: plan.name,
    endDate,
  }).catch(() => {});

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
const freeze = async (userId, subscriptionId, { freezeFrom, freezeTo }) => {
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
  const freezeDays = Math.ceil((new Date(freezeTo) - new Date(freezeFrom)) / 86400000);
  if (plan && freezeDays > plan.freezeLimitDays) {
    throw createError(`Freeze duration exceeds the plan limit of ${plan.freezeLimitDays} days`, 400);
  }

  await sub.update({ status: SubscriptionStatus.FROZEN, freezeFrom, freezeTo });

  // Sync status in Platform index
  await index.update({ status: SubscriptionStatus.FROZEN });

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

// ── POST /subscriptions/:id/renew ─────────────────────────────────────────────
const renew = async (userId, subscriptionId) => {
  const { models, index, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription } = models;

  const sub = await MemberSubscription.findOne({ where: { id: resolvedSubscriptionId } });
  if (!sub) throw createError('Subscription not found in tenant database', 404);
  if (sub.status === SubscriptionStatus.CANCELLED) {
    throw createError('Cancelled subscriptions cannot be renewed', 409);
  }

  const plan = await models.MembershipPlan.findByPk(sub.membershipPlanId);
  if (!plan || plan.status !== 'ACTIVE') {
    throw createError('The associated membership plan is no longer available', 409);
  }

  // Extend from current endDate (or today if already expired)
  const baseDate = sub.status === SubscriptionStatus.EXPIRED
    ? new Date().toISOString().split('T')[0]
    : sub.endDate;
  const newEndDate = _calcEndDate(baseDate, plan.durationType, plan.durationValue);
  const newQr = _generateQrToken();

  await sub.update({
    status: SubscriptionStatus.ACTIVE,
    endDate: newEndDate,
    qrCode: newQr,
    remainingVisits: plan.visitLimit ?? null,
    freezeFrom: null,
    freezeTo: null,
    cancelledAt: null,
  });
  await index.update({ status: SubscriptionStatus.ACTIVE, endDate: newEndDate });

  // Fire-and-forget notification
  _enqueueNotification(userId, 'SUBSCRIPTION_RENEWED', {
    gymName: index.gymName,
    planName: plan.name,
    endDate: newEndDate,
  }).catch(() => {});

  return { subscription: await sub.reload(), qrCode: newQr };
};

// ── POST /subscriptions/:id/change-plan ──────────────────────────────────────────
const changePlan = async (userId, subscriptionId, newPlanId) => {
  const { models, index, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription, MembershipPlan } = models;

  const sub = await MemberSubscription.findOne({ where: { id: resolvedSubscriptionId } });
  if (!sub) throw createError('Subscription not found in tenant database', 404);

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

  const where = {};
  if (status) where.status = status;
  if (branchId) {
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

  // Enrich with platform DB user info and latest payment
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const users = userIds.length
    ? await User.findAll({
        where: { id: userIds },
        attributes: ['id', 'fullName', 'email', 'phone', 'profileImageUrl'],
      })
    : [];
  const userMap = Object.fromEntries(users.map((u) => [u.id, u.toJSON()]));

  // Fetch latest payment per subscription
  const subIds = rows.map((r) => r.id);
  const payments = subIds.length
    ? await Payment.findAll({
        where: { referenceEntityId: subIds, paymentFor: 'MEMBERSHIP' },
        attributes: ['id', 'referenceEntityId', 'status', 'method', 'amount', 'proofUrl', 'createdAt'],
        order: [['createdAt', 'DESC']],
      })
    : [];
  // Keep only the latest payment per subscription
  const paymentMap = {};
  for (const p of payments) {
    if (!paymentMap[p.referenceEntityId]) paymentMap[p.referenceEntityId] = p.toJSON();
  }

  const subscriptions = rows.map((r) => ({
    ...r.toJSON(),
    user: userMap[r.userId] || null,
    latestPayment: paymentMap[r.id] || null,
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

  const user = await User.findByPk(sub.userId, {
    attributes: ['id', 'fullName', 'email', 'phone', 'profileImageUrl'],
  });

  const payments = await Payment.findAll({
    where: { referenceEntityId: subscriptionId, paymentFor: 'MEMBERSHIP' },
    order: [['createdAt', 'DESC']],
  });

  const invoice = await Invoice.findOne({
    where: { referenceEntityId: subscriptionId },
    order: [['createdAt', 'DESC']],
  });

  return { subscription: { ...sub.toJSON(), user }, payments, invoice };
};

// ── Preview: dry-run date + price calculation without DB commit ───────────────
const previewSubscription = async (tenantDb, { planId, startDate, autoRenew }) => {
  const { MembershipPlan } = tenantDb.models;

  const plan = await MembershipPlan.findOne({ where: { id: planId, status: 'ACTIVE' } });
  if (!plan) throw createError('Plan not found or inactive', 404);

  const start = startDate || new Date().toISOString().split('T')[0];
  const endDate = _calcEndDate(start, plan.durationType, plan.durationValue);

  const totalPrice = parseFloat(plan.price) + parseFloat(plan.joiningFee || 0) + parseFloat(plan.securityFee || 0);

  return {
    plan: { id: plan.id, name: plan.name, durationType: plan.durationType, durationValue: plan.durationValue },
    startDate: start,
    endDate,
    price: parseFloat(plan.price),
    joiningFee: parseFloat(plan.joiningFee || 0),
    securityFee: parseFloat(plan.securityFee || 0),
    totalPrice,
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

  return { subscription: sub, gymMembership: index, payment: latestPayment, invoice };
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
  const { Op } = require('sequelize');
  const allPlans = await MembershipPlan.findAll({
    where: {
      branchId: {
        [Op.or]: [sub.branchId, null],
      },
      status: 'ACTIVE',
    },
  });

  // Filter to plans priced strictly higher than the current plan
  const upgradeOptions = allPlans.filter((p) => Number(p.price) > Number(currentPlan.price));

  return {
    currentPlan,
    options: upgradeOptions,
  };
};

// ── POST /member/subscriptions/:id/upgrade ───────────────────────────────────────
const upgradeSubscription = async (userId, subscriptionId, newPlanId) => {
  const { models, index, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription, MembershipPlan, Payment, Invoice } = models;

  const sub = await MemberSubscription.findOne({
    where: { id: resolvedSubscriptionId },
    include: [{ model: MembershipPlan, as: 'plan' }],
  });
  if (!sub) throw createError('Subscription not found', 404);

  const currentPlan = sub.plan;
  if (!currentPlan) throw createError('Current membership plan not found', 404);

  const newPlan = await MembershipPlan.findByPk(newPlanId);
  if (!newPlan || newPlan.status !== 'ACTIVE') {
    throw createError('Selected upgrade plan not found or inactive', 404);
  }

  if (Number(newPlan.price) <= Number(currentPlan.price)) {
    throw createError('Selected plan must be priced strictly higher than the current plan', 409);
  }

  const amountToPay = Number(newPlan.price) - Number(currentPlan.price);

  // 1. Update subscription IMMEDIATELY
  await sub.update({
    membershipPlanId: newPlanId,
  });

  // Update platform index table if needed
  await index.update({
    planName: newPlan.name,
  });

  // 2. Create Payment (status PENDING)
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
  const invoice = await Invoice.create({
    userId: sub.userId,
    invoiceNo: _invoiceNo(),
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
  };
};

module.exports = {
  subscribe, listMySubscriptions, freeze, cancel, renew, changePlan,
  listForStaff, getForStaff, previewSubscription,
  getMySubscriptionDetail, uploadSubscriptionProof, activateSubscription,
  getMemberBranchSubscriptionStatus, getUpgradeOptions, upgradeSubscription,
};
