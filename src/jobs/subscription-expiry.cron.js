/**
 * subscription-expiry.cron.js
 *
 * Bull cron job — runs daily at 01:00 AM server time.
 *
 * For every tenant DB in the TenantDbManager pool:
 *   1. Find all ACTIVE subscriptions whose endDate < today → mark EXPIRED
 *   2. Find all ACTIVE subscriptions expiring in the next 3 days → queue
 *      SUBSCRIPTION_EXPIRING_SOON notification
 *
 * Additionally syncs the Platform `user_gym_memberships` status index.
 *
 * The job is registered in server.js at startup.
 */
const { Op } = require('sequelize');
const TenantDbManager       = require('../database/TenantDbManager');
const { UserGymMembership, User, Tenant } = require('../models/platform');
const { notificationsQueue } = require('./queues');
const { SubscriptionStatus } = require('../constants/subscription-status');

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

/**
 * Main cron handler — iterates over all loaded tenant connections.
 */
const runExpiryCheck = async () => {
  console.log('[Cron] subscription-expiry: starting daily check');

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
