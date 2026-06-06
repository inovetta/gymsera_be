/**
 * subscription-expiry.cron.js
 *
 * Runs daily at 01:00 AM server time.
 *
 * Platform-level:
 *   1. Find TenantSubscriptions expiring in 2 days → send warning email to gym host
 *   2. Find TenantSubscriptions whose endDate < today and still ACTIVE → mark EXPIRED,
 *      auto-suspend the Tenant, hide GymListing, send suspension email
 *
 * Per-tenant (member subscriptions):
 *   1. Find ACTIVE MemberSubscriptions whose endDate < today → mark EXPIRED
 *   2. Sync platform UserGymMembership index
 *   3. Find expiring-soon member subscriptions → queue SUBSCRIPTION_EXPIRING_SOON email
 */
const { Op } = require('sequelize');
const TenantDbManager       = require('../database/TenantDbManager');
const { UserGymMembership, User, Tenant, TenantSubscription, GymListing, PlatformPackage } = require('../models/platform');
const { notificationsQueue } = require('./queues');
const { SubscriptionStatus } = require('../constants/subscription-status');
const emailService = require('../services/email.service');

const EXPIRY_CRON = '0 1 * * *'; // 01:00 every day
const WARNING_DAYS = 3;

/**
 * Process one tenant's member_subscriptions table.
 * @param {string} tenantId
 * @param {{ sequelize, models }} tenantDb
 */
const _processTenant = async (tenantId, tenantDb) => {
  const { MemberSubscription } = tenantDb.models;
  const today = new Date().toISOString().split('T')[0];

  // ── 1. Expire overdue subscriptions ────────────────────────────────────────
  const [expiredCount] = await MemberSubscription.update(
    { status: SubscriptionStatus.EXPIRED },
    {
      where: {
        status: SubscriptionStatus.ACTIVE,
        endDate: { [Op.lt]: today },
      },
    }
  );

  if (expiredCount > 0) {
    console.log(`[Cron] Tenant ${tenantId}: expired ${expiredCount} subscription(s)`);

    // Sync platform index
    await UserGymMembership.update(
      { status: SubscriptionStatus.EXPIRED },
      {
        where: {
          tenantId,
          status: SubscriptionStatus.ACTIVE,
          endDate: { [Op.lt]: today },
        },
      }
    );
  }

  // ── 2. Queue expiry-warning notifications (3-day window) ──────────────────
  const warningDate = new Date();
  warningDate.setDate(warningDate.getDate() + WARNING_DAYS);
  const warningDateStr = warningDate.toISOString().split('T')[0];

  const expiringSoon = await MemberSubscription.findAll({
    where: {
      status: SubscriptionStatus.ACTIVE,
      endDate: { [Op.between]: [today, warningDateStr] },
    },
  });

  for (const sub of expiringSoon) {
    // Load user from platform DB to get email
    const user = await User.findByPk(sub.userId, {
      attributes: ['id', 'email', 'fullName'],
    });
    if (!user) continue;

    // Get gym name from platform index
    const index = await UserGymMembership.findOne({
      where: { subscriptionId: sub.id },
      attributes: ['gymName'],
    });

    await notificationsQueue.add({
      type:     'SUBSCRIPTION_EXPIRING_SOON',
      email:    user.email,
      fullName: user.fullName,
      gymName:  index?.gymName || 'your gym',
      endDate:  sub.endDate,
    }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
  }
};

// ── Platform tenant subscription expiry ────────────────────────────────────────
/**
 * Handles platform-level tenant subscription expiry:
 *  - Sends 2-day warning emails for subscriptions about to expire
 *  - Marks expired TenantSubscriptions as EXPIRED
 *  - Auto-suspends the Tenant + hides GymListing
 *  - Sends suspension email to gym host
 */
const _processPlatformSubscriptions = async () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  // ── 1. 2-day warning ──────────────────────────────────────────────────────
  const warningDate = new Date(today);
  warningDate.setDate(warningDate.getDate() + 2);
  const warningDateStr = warningDate.toISOString().split('T')[0];

  const expiringSoon = await TenantSubscription.findAll({
    where: {
      status: 'ACTIVE',
      endDate: { [Op.between]: [todayStr, warningDateStr] },
    },
    include: [
      { model: Tenant, as: 'tenant', include: [{ model: User, as: 'owner', attributes: ['email', 'fullName'] }] },
      { model: PlatformPackage, as: 'package', attributes: ['name'] },
    ],
  });

  for (const sub of expiringSoon) {
    const owner = sub.tenant?.owner;
    if (!owner) continue;
    try {
      await emailService.sendTenantSubscriptionWarningEmail(owner.email, owner.fullName, {
        businessName: sub.tenant.businessName,
        packageName: sub.package?.name || 'Platform',
        endDate: sub.endDate,
      });
      console.log(`[Cron] Sent subscription warning to ${owner.email} (tenant: ${sub.tenantId})`);
    } catch (err) {
      console.error(`[Cron] Failed to send warning email to ${owner.email}:`, err.message);
    }
  }

  // ── 2. Expire overdue platform subscriptions ──────────────────────────────
  const expiredSubs = await TenantSubscription.findAll({
    where: { status: 'ACTIVE', endDate: { [Op.lt]: todayStr } },
    include: [
      { model: Tenant, as: 'tenant', include: [{ model: User, as: 'owner', attributes: ['email', 'fullName'] }] },
      { model: PlatformPackage, as: 'package', attributes: ['name'] },
    ],
  });

  for (const sub of expiredSubs) {
    try {
      // Mark subscription expired
      await sub.update({ status: 'EXPIRED' });

      // Auto-suspend the tenant
      const tenant = sub.tenant;
      if (!tenant || tenant.status === 'SUSPENDED') continue;

      await tenant.update({ status: 'SUSPENDED' });

      // Hide their gym listing
      await GymListing.update(
        { status: 'INACTIVE' },
        { where: { tenantId: tenant.id, status: 'ACTIVE' } }
      );

      console.log(`[Cron] Auto-suspended tenant ${tenant.id} (${tenant.businessName}) — subscription expired`);

      // Send suspension email
      const owner = tenant.owner;
      if (owner) {
        try {
          await emailService.sendTenantSubscriptionSuspendedEmail(owner.email, owner.fullName, {
            businessName: tenant.businessName,
            packageName: sub.package?.name || 'Platform',
            endDate: sub.endDate,
          });
        } catch (emailErr) {
          console.error(`[Cron] Failed to send suspension email to ${owner.email}:`, emailErr.message);
        }
      }
    } catch (err) {
      console.error(`[Cron] Failed to process expired subscription ${sub.id}:`, err.message);
    }
  }

  if (expiringSoon.length || expiredSubs.length) {
    console.log(`[Cron] Platform subscriptions: ${expiringSoon.length} warning(s) sent, ${expiredSubs.length} expired & suspended`);
  }
};

/**
 * Main cron handler — iterates over all loaded tenant connections.
 */
const runExpiryCheck = async () => {
  console.log('[Cron] subscription-expiry: starting daily check');

  // ── Platform subscriptions first ─────────────────────────────────────────
  await _processPlatformSubscriptions();

  const entries = TenantDbManager.getAllEntries();

  if (entries.length === 0) {
    // Load all ACTIVE tenants so we can iterate their DBs
    const tenants = await Tenant.findAll({
      where: { status: 'ACTIVE' },
      attributes: ['id', 'connectionStringEncrypted'],
    });

    for (const tenant of tenants) {
      try {
        const tenantDb = await TenantDbManager.getConnection(
          tenant.id,
          tenant.connectionStringEncrypted
        );
        await _processTenant(tenant.id, tenantDb);
      } catch (err) {
        console.error(`[Cron] Failed to process tenant ${tenant.id}:`, err.message);
      }
    }
  } else {
    for (const [tenantId, tenantDb] of entries) {
      try {
        await _processTenant(tenantId, tenantDb);
      } catch (err) {
        console.error(`[Cron] Failed to process tenant ${tenantId}:`, err.message);
      }
    }
  }

  console.log('[Cron] subscription-expiry: check complete');
};

module.exports = { runExpiryCheck, EXPIRY_CRON };
