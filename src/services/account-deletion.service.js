'use strict';

/**
 * Self-service account and tenant deletion — the REQUEST side (AUTH-07; owner
 * decisions: spec §14 R-16 and R-28).
 *
 *   preflight → re-auth → PENDING_DELETION (user + every tenant they own) → 30-day
 *   undo window → (day 30: account-deletion-finalize.service.js).
 *
 * Nothing is deleted here. The request takes effect at once through statuses that
 * already gate everything: tenantContext only serves ACTIVE tenants and discovery
 * only lists ACTIVE tenants, so a PENDING_DELETION tenant is closed to staff,
 * members and travelers without a second mechanism.
 */
const { Op } = require('sequelize');
const { sequelize } = require('../database/platform');
const {
  User,
  Tenant,
  TenantSubscription,
  RefreshToken,
  DeviceToken,
  UserGymMembership,
  PlatformAuditLog,
} = require('../models/platform');
const { TenantStatus } = require('../constants/subscription-status');
const TenantDbManager = require('../database/TenantDbManager');
const { safeRedisDel } = require('../config/redis.config');
const { createError } = require('../utils/response.utils');
const authService = require('./auth.service');
const stripeBilling = require('./stripe-billing.service');
const notificationsService = require('./notifications.service');

/** R-16: the undo window after a deletion request. */
const DELETION_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Tenant statuses that are already finished (nothing to delete or undo). */
const SETTLED_TENANT_STATUSES = [TenantStatus.REJECTED, TenantStatus.DELETED, TenantStatus.PENDING_DELETION];

/**
 * Store subscriptions that can still charge. PENDING_CANCEL (the user already
 * cancelled in the store, it just runs to the end of the period), EXPIRED,
 * CANCELLED and REVOKED do not.
 */
const LIVE_SUBSCRIPTION_STATUSES = ['ACTIVE', 'GRACE', 'ON_HOLD', 'PAUSED', 'SCHEDULED'];

const STORE_MANAGE_URLS = {
  IOS: 'https://apps.apple.com/account/subscriptions',
  ANDROID: 'https://play.google.com/store/account/subscriptions',
};

const _ownedLiveTenants = async (userId, options = {}) =>
  Tenant.findAll({
    where: { ownerUserId: userId, status: { [Op.notIn]: SETTLED_TENANT_STATUSES } },
    ...options,
  });

const _liveSubscriptions = async (tenantIds) =>
  tenantIds.length === 0
    ? []
    : TenantSubscription.findAll({
        where: { tenantId: { [Op.in]: tenantIds }, status: { [Op.in]: LIVE_SUBSCRIPTION_STATUSES } },
      });

/**
 * What would block (store subscriptions) and what will happen automatically
 * (Stripe is cancelled at period end). Read-only.
 */
const getDeletionPreflight = async (userId) => {
  const user = await User.findByPk(userId);
  if (!user) throw createError('User not found', 404);

  const tenants = await _ownedLiveTenants(userId);
  const subs = await _liveSubscriptions(tenants.map((t) => t.id));

  const blockers = subs
    .filter((s) => s.platform === 'IOS' || s.platform === 'ANDROID')
    .map((s) => ({
      type: 'STORE_SUBSCRIPTION',
      platform: s.platform,
      tenantId: s.tenantId,
      manageUrl: STORE_MANAGE_URLS[s.platform],
      message:
        s.platform === 'IOS'
          ? 'Cancel your GymsEra subscription in your Apple ID subscriptions, then try again.'
          : 'Cancel your GymsEra subscription in Google Play subscriptions, then try again.',
    }));
  const stripeSubscriptions = subs.filter((s) => s.platform === 'STRIPE' && s.externalOriginalTransactionId);

  return {
    canDelete: blockers.length === 0 && user.role !== 'PLATFORM_ADMIN',
    blockers,
    willCancelAutomatically: stripeSubscriptions.map((s) => ({ type: 'STRIPE_SUBSCRIPTION', tenantId: s.tenantId })),
    tenants: tenants.map((t) => ({ id: t.id, businessName: t.businessName, status: t.status })),
    windowDays: DELETION_WINDOW_DAYS,
    deletionPending: user.status === 'PENDING_DELETION' ? { scheduledFor: user.deletionScheduledFor } : null,
  };
};

const _audit = (action, userId, targetType, targetId, details) =>
  PlatformAuditLog.create({ actorUserId: userId, action, targetType, targetId, details, createdAt: new Date() });

/** After the status change commits: close the tenant's cached connection and members' pool. */
const _closeTenantConnections = async (tenantId) => {
  await safeRedisDel(`tenant:${tenantId}:connStr`);
  await TenantDbManager.release(tenantId).catch(() => {});
};

const _notifyMembers = async (tenant) => {
  const memberships = await UserGymMembership.findAll({
    where: { tenantId: tenant.id, status: 'ACTIVE' },
    attributes: ['userId'],
    group: ['userId'],
  });
  for (const { userId } of memberships) {
    await notificationsService
      .createNotification({
        userId,
        role: 'traveler',
        type: 'GYM_CLOSING',
        title: `${tenant.businessName || tenant.gymName || 'Your gym'} is closing on GymsEra`,
        message:
          'This gym has asked to close its GymsEra account. Its owner can still cancel the request for 30 days; after that your ' +
          'membership here will end. Your receipts and history stay available in your account.',
        priority: 'high',
        metadataJson: { event: 'gym_closing', tenantId: tenant.id },
      })
      .catch((err) => console.warn(`[AccountDeletion] Could not notify member ${userId}:`, err.message));
  }
};

/**
 * Re-authenticated request. Idempotent: asking again while pending changes nothing
 * (the window is not extended).
 */
const requestDeletion = async (userId, credential = {}) => {
  const user = await User.findByPk(userId);
  if (!user) throw createError('User not found', 404);
  if (user.status === 'DELETED') throw createError('User not found', 404);
  if (user.role === 'PLATFORM_ADMIN') throw createError('Platform admin accounts cannot be deleted from the app', 403);

  await authService.assertReauth(userId, credential);

  if (user.status === 'PENDING_DELETION') {
    return { alreadyRequested: true, requestedAt: user.deletionRequestedAt, scheduledFor: user.deletionScheduledFor };
  }

  const preflight = await getDeletionPreflight(userId);
  if (preflight.blockers.length > 0) {
    const err = createError('Cancel your store subscription first, then delete your account.', 409);
    err.code = 'store_subscription_active';
    err.data = { blockers: preflight.blockers };
    throw err;
  }

  // DATETIME keeps whole seconds; use the same value the database will hold.
  const requestedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const scheduledFor = new Date(requestedAt.getTime() + DELETION_WINDOW_DAYS * DAY_MS);

  const { tenants, stripeIds } = await sequelize.transaction(async (transaction) => {
    const owned = await _ownedLiveTenants(userId, { transaction, lock: transaction.LOCK.UPDATE });
    const subs = await _liveSubscriptions(owned.map((t) => t.id));

    await user.update(
      { status: 'PENDING_DELETION', deletionRequestedAt: requestedAt, deletionScheduledFor: scheduledFor },
      { transaction }
    );
    for (const tenant of owned) {
      await tenant.update(
        {
          statusBeforeDeletion: tenant.status,
          status: TenantStatus.PENDING_DELETION,
          deletionRequestedAt: requestedAt,
          deletionScheduledFor: scheduledFor,
        },
        { transaction }
      );
    }
    // Sessions end now; the owner signs in again (to undo) with a restricted token.
    await RefreshToken.update({ isRevoked: true }, { where: { userId }, transaction });
    await DeviceToken.destroy({ where: { userId }, transaction });
    await PlatformAuditLog.create(
      {
        actorUserId: userId,
        action: 'ACCOUNT_DELETION_REQUESTED',
        targetType: 'User',
        targetId: userId,
        details: { scheduledFor, tenantIds: owned.map((t) => t.id), policy: 'R-16 / R-28' },
        createdAt: requestedAt,
      },
      { transaction }
    );
    return {
      tenants: owned,
      stripeIds: subs
        .filter((s) => s.platform === 'STRIPE' && s.externalOriginalTransactionId)
        .map((s) => ({ tenantId: s.tenantId, id: s.externalOriginalTransactionId })),
    };
  });

  // Outside the transaction: a provider call must never sit inside one that could roll back.
  for (const { tenantId, id } of stripeIds) {
    try {
      await stripeBilling.cancelAtPeriodEnd(id);
    } catch (err) {
      console.error(`[AccountDeletion] Stripe cancel failed for tenant ${tenantId}:`, err.message);
      await _audit('ACCOUNT_DELETION_STRIPE_CANCEL_FAILED', userId, 'Tenant', tenantId, { reason: String(err.message).slice(0, 200) })
        .catch(() => {});
    }
  }
  for (const tenant of tenants) {
    await _closeTenantConnections(tenant.id);
    await _notifyMembers(tenant);
  }

  return { alreadyRequested: false, requestedAt, scheduledFor };
};

/** Undo inside the window: the user and each tenant return to exactly where they were. */
const cancelDeletion = async (userId) => {
  const user = await User.findByPk(userId);
  if (!user || user.status !== 'PENDING_DELETION') {
    const err = createError('No account deletion is pending', 409);
    err.code = 'no_deletion_pending';
    throw err;
  }
  if (!user.deletionScheduledFor || new Date(user.deletionScheduledFor).getTime() <= Date.now()) {
    const err = createError('The 30-day window to cancel this deletion has ended', 409);
    err.code = 'deletion_window_ended';
    throw err;
  }

  const restored = await sequelize.transaction(async (transaction) => {
    const tenants = await Tenant.findAll({
      where: { ownerUserId: userId, status: TenantStatus.PENDING_DELETION },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const tenant of tenants) {
      await tenant.update(
        {
          status: tenant.statusBeforeDeletion || TenantStatus.ACTIVE,
          statusBeforeDeletion: null,
          deletionRequestedAt: null,
          deletionScheduledFor: null,
        },
        { transaction }
      );
    }
    await user.update({ status: 'ACTIVE', deletionRequestedAt: null, deletionScheduledFor: null }, { transaction });
    await PlatformAuditLog.create(
      {
        actorUserId: userId,
        action: 'ACCOUNT_DELETION_CANCELLED',
        targetType: 'User',
        targetId: userId,
        details: { tenantIds: tenants.map((t) => t.id) },
        createdAt: new Date(),
      },
      { transaction }
    );
    return tenants;
  });

  for (const tenant of restored) await _closeTenantConnections(tenant.id);
  return { cancelled: true };
};

module.exports = {
  DELETION_WINDOW_DAYS,
  LIVE_SUBSCRIPTION_STATUSES,
  getDeletionPreflight,
  requestDeletion,
  cancelDeletion,
};
