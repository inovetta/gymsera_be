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
const { sequelize: platformSequelize } = require('../database/platform');
const { UserGymMembership, User, Tenant, TenantSubscription, GymListing, PlatformPackage } = require('../models/platform');
const { notificationsQueue } = require('./queues');
const { SubscriptionStatus } = require('../constants/subscription-status');
const emailService = require('../services/email.service');
const subscriptionQuotaService = require('../services/subscription-quota.service');

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
      userId:   user.id,
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
 * Safety-net pass for the capacity invariant every branch/slot operation
 * depends on (activeBranches + Σ reservedSlots <= maxBranches — see
 * subscription-quota.service.js#reconcileCapacity). The synchronous check in
 * apple-billing.service.js#syncSubscriptionFromTransaction handles this at
 * the moment a subscription's branchCount actually changes; this covers
 * everything that check can't see — a webhook that never arrived, a race
 * between two concurrent requests, a manual DB correction. Idempotency key
 * is scoped to today's date, so running this twice in one day never
 * double-trims, but a violation that's still present tomorrow gets
 * re-evaluated (and re-corrected) fresh rather than being permanently
 * skipped after the first fix attempt.
 */
const _reconcileCapacityForAllTenants = async () => {
  const todayStr = new Date().toISOString().split('T')[0];
  const activeSubs = await TenantSubscription.findAll({
    where: { status: 'ACTIVE', branchCount: { [Op.ne]: null } },
    attributes: ['id', 'tenantId', 'branchCount'],
  });

  let reconciled = 0;
  let audited = 0;
  for (const sub of activeSubs) {
    const tenant = await Tenant.findByPk(sub.tenantId, { attributes: ['id', 'connectionStringEncrypted'] });
    if (!tenant?.connectionStringEncrypted) continue;

    try {
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const platformTx = await platformSequelize.transaction();
      try {
        const result = await subscriptionQuotaService.reconcileCapacity(sub.tenantId, tenantDb, sub.branchCount, {
          transaction: platformTx,
          idempotencyPrefix: `cron:${todayStr}`,
          actorType: 'SYSTEM',
        });
        await platformTx.commit();
        if (result.trimmedSlots > 0 || result.overQuotaCount > 0) {
          reconciled++;
          console.log(
            `[Cron] Tenant ${sub.tenantId}: capacity reconciliation trimmed ${result.trimmedSlots} slot(s)` +
              `${result.overQuotaCount > 0 ? `, over-quota by ${result.overQuotaCount}` : ''}`
          );
        }
      } catch (err) {
        await platformTx.rollback();
        throw err;
      }

      // Integrity check, after reconciliation rather than before, so what it
      // reports is what's still wrong once the self-healing pass has done
      // everything it can. reconcileCapacity enforces the invariant against
      // the plan; it does NOT verify that reservedSlots agrees with the
      // capacity_events ledger, so a credit lost by a failed cross-database
      // step (see gym.service.js#deleteBranch, which logs and gives up "for
      // the reconciliation job to correct") was previously silent forever.
      // This is the first thing that actually looks.
      //
      // Reported, never auto-repaired: drift means reality and the audit
      // trail disagree, and silently rewriting one to match the other would
      // destroy the only evidence of what went wrong. A human decides.
      try {
        const audit = await subscriptionQuotaService.auditCapacity(sub.tenantId, tenantDb);
        if (!audit.ok) {
          audited++;
          console.warn(
            `[Cron] CAPACITY AUDIT FAILED tenant ${sub.tenantId} (${audit.businessName}): ` +
              `${audit.activeBranches} active + ${audit.usedCapacity - audit.activeBranches} reserved ` +
              `vs plan ${audit.maxBranches}` +
              (audit.totalDrift !== 0 ? `, ledger drift ${audit.totalDrift > 0 ? '+' : ''}${audit.totalDrift}` : '') +
              (audit.overQuotaMismatch
                ? `, overQuotaCount recorded ${audit.recordedOverQuota} but should be ${audit.expectedOverQuota}`
                : '')
          );
          for (const d of audit.driftedListings) {
            console.warn(
              `[Cron]   listing "${d.title}" (${d.listingId}): reservedSlots ${d.actualReservedSlots}, ` +
                `ledger says ${d.ledgerReservedSlots} (drift ${d.drift > 0 ? '+' : ''}${d.drift})`
            );
          }
        }
      } catch (auditErr) {
        console.error(`[Cron] Capacity audit failed for tenant ${sub.tenantId}:`, auditErr.message);
      }
    } catch (err) {
      console.error(`[Cron] Capacity reconciliation failed for tenant ${sub.tenantId}:`, err.message);
    }
  }

  if (reconciled > 0) {
    console.log(`[Cron] Capacity reconciliation: corrected drift for ${reconciled} tenant(s)`);
  }
  if (audited > 0) {
    console.warn(`[Cron] Capacity audit: ${audited} tenant(s) need a human look — see warnings above`);
  }
};

/**
 * Main cron handler — iterates over all loaded tenant connections.
 */
const runExpiryCheck = async () => {
  console.log('[Cron] subscription-expiry: starting daily check');

  // ── Platform subscriptions first ─────────────────────────────────────────
  await _processPlatformSubscriptions();

  // ── Capacity invariant safety net ────────────────────────────────────────
  await _reconcileCapacityForAllTenants();

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
