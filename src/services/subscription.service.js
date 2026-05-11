const crypto = require('crypto');
const { GymListing, Tenant, UserGymMembership, User } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError, buildPagination } = require('../utils/response.utils');
const { SubscriptionStatus } = require('../constants/subscription-status');
const { notificationsQueue } = require('../jobs/queues');

// ── Notification helper ───────────────────────────────────────────────────────
const _enqueueNotification = async (userId, type, extra) => {
  try {
    const user = await User.findByPk(userId, { attributes: ['email', 'fullName', 'fcmToken'] });
    if (!user) return;
    await notificationsQueue.add(
      { type, email: user.email, fullName: user.fullName, fcmToken: user.fcmToken, ...extra },
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

/**
 * Resolve tenant DB from a GymListing UUID.
 * Returns { models, tenantId, encryptedConnStr }.
 */
const _resolveTenant = async (gymListingId) => {
  const listing = await GymListing.findOne({
    where: { id: gymListingId, status: 'ACTIVE' },
    attributes: ['id', 'tenantId', 'title'],
  });
  if (!listing) throw createError('Gym not found or not active', 404);

  const tenant = await Tenant.findOne({
    where: { id: listing.tenantId, status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
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
 * Ensures the subscription belongs to the requesting user.
 */
const _resolveBySubscriptionId = async (subscriptionId, userId) => {
  const index = await UserGymMembership.findOne({
    where: { subscriptionId, userId },
  });
  if (!index) throw createError('Subscription not found', 404);

  const tenant = await Tenant.findOne({
    where: { id: index.tenantId, status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });
  if (!tenant) throw createError('Gym tenant is not available', 503);

  const { models } = await TenantDbManager.getConnection(
    tenant.id,
    tenant.connectionStringEncrypted
  );
  return { models, index };
};

// ── POST /subscriptions ───────────────────────────────────────────────────────
const subscribe = async (userId, { planId, gymListingId, branchId, autoRenew, sourceChannel }) => {
  const { models, tenantId, gymListing } = await _resolveTenant(gymListingId);
  const { MembershipPlan, MemberSubscription, MemberProfile } = models;

  // Verify plan exists and is active
  const plan = await MembershipPlan.findOne({ where: { id: planId, status: 'ACTIVE' } });
  if (!plan) throw createError('Membership plan not found or inactive', 404);

  // Verify branch belongs to this gym
  const branch = await models.Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
  if (!branch) throw createError('Branch not found or inactive', 404);

  // Prevent duplicate active/pending subscription to same branch for this user
  const existing = await MemberSubscription.findOne({
    where: {
      userId,
      branchId,
      status: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PENDING, SubscriptionStatus.FROZEN],
    },
  });
  if (existing) throw createError('You already have an active subscription at this branch', 409);

  const startDate = new Date().toISOString().split('T')[0];
  const endDate = _calcEndDate(startDate, plan.durationType, plan.durationValue);
  const qrCode = _generateQrToken();

  // Upsert member profile (create only if not exists)
  await MemberProfile.findOrCreate({ where: { userId }, defaults: { userId } });

  const subscription = await MemberSubscription.create({
    userId,
    branchId,
    membershipPlanId: planId,
    startDate,
    endDate,
    status: SubscriptionStatus.ACTIVE,
    autoRenew: autoRenew ?? false,
    qrCode,
    subscribedAt: new Date(),
    remainingVisits: plan.visitLimit ?? null,
    sourceChannel: sourceChannel ?? 'ONLINE',
  });

  // Write cross-tenant index to Platform DB
  await UserGymMembership.create({
    userId,
    tenantId,
    gymListingId,
    subscriptionId: subscription.id,
    gymName: gymListing.title,
    planName: plan.name,
    startDate,
    endDate,
    status: SubscriptionStatus.ACTIVE,
  });

  // Fire-and-forget notification
  _enqueueNotification(userId, 'SUBSCRIPTION_ACTIVATED', {
    gymName: gymListing.title,
    planName: plan.name,
    endDate,
  }).catch(() => {});

  return { subscription, qrCode };
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
  const { models, index } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription } = models;

  const sub = await MemberSubscription.findOne({ where: { id: subscriptionId } });
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
  const { models, index } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription } = models;

  const sub = await MemberSubscription.findOne({ where: { id: subscriptionId } });
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
  const { models, index } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { MemberSubscription } = models;

  const sub = await MemberSubscription.findOne({ where: { id: subscriptionId } });
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

// ── Staff: list all subscriptions in tenant DB ────────────────────────────────
const listForStaff = async (tenantDb, { status, branchId, userId, page, limit, offset }) => {
  const { MemberSubscription, MembershipPlan, Branch } = tenantDb.models;

  const where = {};
  if (status) where.status = status;
  if (branchId) where.branchId = branchId;
  if (userId) where.userId = userId;

  const { count, rows } = await MemberSubscription.findAndCountAll({
    where,
    include: [
      { model: MembershipPlan, as: 'plan', attributes: ['id', 'name', 'price', 'durationType'] },
      { model: Branch, as: 'branch', attributes: ['id', 'branchName'] },
    ],
    order: [['subscribedAt', 'DESC']],
    limit,
    offset,
  });

  return {
    subscriptions: rows,
    pagination: buildPagination(count, page, limit),
  };
};

// ── Staff: get single subscription ───────────────────────────────────────────
const getForStaff = async (tenantDb, subscriptionId) => {
  const { MemberSubscription, MembershipPlan, Branch, Payment } = tenantDb.models;

  const sub = await MemberSubscription.findOne({
    where: { id: subscriptionId },
    include: [
      { model: MembershipPlan, as: 'plan' },
      { model: Branch, as: 'branch', attributes: ['id', 'branchName'] },
    ],
  });
  if (!sub) throw createError('Subscription not found', 404);

  // Fetch latest payment for this subscription
  const latestPayment = await Payment.findOne({
    where: { referenceEntityId: subscriptionId, paymentFor: 'MEMBERSHIP' },
    order: [['createdAt', 'DESC']],
  });

  return { subscription: sub, latestPayment };
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

module.exports = {
  subscribe, listMySubscriptions, freeze, cancel, renew,
  listForStaff, getForStaff, previewSubscription,
};
