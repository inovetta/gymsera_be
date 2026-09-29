const { Op } = require('sequelize');
const { createError } = require('../utils/response.utils');
const { overquotaGraceDays, memberCheckinGraceDays } = require('../config/billing.config');
const subscriptionQuotaService = require('./subscription-quota.service');

/**
 * Branch Billing Lock Service (spec §4, §7.5.8, CAP-01)
 *
 * Enforces capacity limits on real branches when an account goes over quota after a downgrade.
 * - During OVERQUOTA_GRACE_DAYS (7 days), branches remain unlocked while a countdown is surfaced.
 * - After grace expires, exactly overQuotaCount branches are locked:
 *   1. Branches NOT in getBranchesToKeep(tenantId) first (most recently created first).
 *   2. Otherwise the most recently created first.
 * - A locked branch:
 *   - Data stays visible (GET requests).
 *   - No new members, sales/payments, plans, or staff (checked in ONE shared place).
 *   - Existing members can still check in for MEMBER_CHECKIN_GRACE_DAYS (7 days) after lock, then not.
 * - Unlock is automatic when capacity returns (upgrade or deleting another branch).
 * - Every lock/unlock writes a CapacityEvent (BRANCH_BILLING_LOCKED / BRANCH_BILLING_UNLOCKED) with idempotencyKey.
 */

/**
 * Evaluates and applies/removes branch billing locks for a tenant.
 *
 * @param {string} tenantId
 * @param {object} tenantDb
 * @returns {Promise<{ overQuotaCount: number, lockedCount: number, unlockedCount: number, inGrace: boolean, remainingDays: number|null }>}
 */
const enforceBranchBillingLocksForTenant = async (tenantId, tenantDb) => {
  const { Branch } = tenantDb.models;
  const sub = await subscriptionQuotaService.getActiveSubscription(tenantId);
  const overQuotaCount = sub?.overQuotaCount || 0;

  // 1. If not over quota, unlock any previously locked branches
  if (!sub || overQuotaCount <= 0) {
    const lockedBranches = await Branch.findAll({
      where: { billingLockedAt: { [Op.ne]: null } },
    });

    let unlockedCount = 0;
    const nowKey = new Date().toISOString().slice(0, 10);
    for (const b of lockedBranches) {
      await b.update({ billingLockedAt: null, billingLockReason: null });
      await subscriptionQuotaService.recordCapacityEvent({
        tenantId,
        listingId: b.gymListingId || null,
        branchId: b.id,
        action: 'BRANCH_BILLING_UNLOCKED',
        delta: 0,
        actorType: 'SYSTEM',
        reason: 'Branch billing lock removed as account is within capacity',
        idempotencyKey: `branch_billing_unlocked:${b.id}:${nowKey}`,
      });
      unlockedCount++;
    }

    return { overQuotaCount: 0, lockedCount: 0, unlockedCount, inGrace: false, remainingDays: null };
  }

  // 2. Check over-quota grace countdown (R-3, default 7 days)
  const graceDays = overquotaGraceDays();
  const change = sub.pendingChange;
  const appliedAt = change?.appliedAt ? new Date(change.appliedAt) : new Date(sub.updatedAt);
  const graceExpiry = new Date(appliedAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
  const isGraceExpired = Date.now() >= graceExpiry.getTime();
  const remainingDays = Math.max(0, Math.ceil((graceExpiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));

  if (!isGraceExpired) {
    return { overQuotaCount, lockedCount: 0, unlockedCount: 0, inGrace: true, remainingDays };
  }

  // 3. Grace has expired: determine exactly `overQuotaCount` branches to lock
  const activeBranches = await Branch.findAll({
    where: { status: 'ACTIVE' },
    order: [['createdAt', 'DESC']],
  });

  const keepBranchIds = await subscriptionQuotaService.getBranchesToKeep(tenantId);
  const keepSet = new Set(Array.isArray(keepBranchIds) ? keepBranchIds : []);

  // Partition: not in keep list first (newest first), then in keep list (newest first)
  const notInKeep = activeBranches.filter((b) => !keepSet.has(b.id));
  const inKeep = activeBranches.filter((b) => keepSet.has(b.id));
  const candidates = [...notInKeep, ...inKeep];

  const targetBranchesToLock = candidates.slice(0, overQuotaCount);
  const targetLockIds = new Set(targetBranchesToLock.map((b) => b.id));

  let lockedCount = 0;
  let unlockedCount = 0;
  const nowKey = new Date().toISOString().slice(0, 10);

  for (const branch of activeBranches) {
    if (targetLockIds.has(branch.id)) {
      if (!branch.billingLockedAt) {
        await branch.update({
          billingLockedAt: new Date(),
          billingLockReason: 'Account over branch capacity following subscription change',
        });
        await subscriptionQuotaService.recordCapacityEvent({
          tenantId,
          listingId: branch.gymListingId || null,
          branchId: branch.id,
          action: 'BRANCH_BILLING_LOCKED',
          delta: 0,
          actorType: 'SYSTEM',
          reason: 'Branch billing locked due to over-quota capacity',
          idempotencyKey: `branch_billing_locked:${branch.id}:${nowKey}`,
        });
        lockedCount++;
      }
    } else {
      if (branch.billingLockedAt) {
        await branch.update({
          billingLockedAt: null,
          billingLockReason: null,
        });
        await subscriptionQuotaService.recordCapacityEvent({
          tenantId,
          listingId: branch.gymListingId || null,
          branchId: branch.id,
          action: 'BRANCH_BILLING_UNLOCKED',
          delta: 0,
          actorType: 'SYSTEM',
          reason: 'Branch billing lock removed as capacity returned',
          idempotencyKey: `branch_billing_unlocked:${branch.id}:${nowKey}`,
        });
        unlockedCount++;
      }
    }
  }

  return {
    overQuotaCount,
    lockedCount,
    unlockedCount,
    inGrace: false,
    remainingDays: 0,
    lockedBranchIds: Array.from(targetLockIds),
  };
};

/**
 * Asserts that a branch is NOT billing-locked for write operations
 * (members, sales, plans, staff).
 *
 * @param {object} branch - Branch Sequelize instance or object
 */
const assertBranchNotBillingLocked = (branch) => {
  if (branch && branch.billingLockedAt) {
    const err = createError(
      'This branch is locked due to plan capacity limits following a subscription change. Upgrade your plan to restore full access.',
      403
    );
    err.code = 'branch_billing_locked';
    err.data = {
      branchId: branch.id,
      billingLockedAt: branch.billingLockedAt,
      billingLockReason: branch.billingLockReason,
    };
    throw err;
  }
};

/**
 * Asserts that a member check-in is allowed at this branch.
 * Allowed for MEMBER_CHECKIN_GRACE_DAYS (7 days) after the lock, rejected afterwards.
 *
 * @param {object} branch - Branch Sequelize instance or object
 */
const assertBranchCheckinAllowed = (branch) => {
  if (branch && branch.billingLockedAt) {
    const graceDays = memberCheckinGraceDays();
    const lockTime = new Date(branch.billingLockedAt).getTime();
    const graceExpiryTime = lockTime + graceDays * 24 * 60 * 60 * 1000;
    const isExpired = Date.now() > graceExpiryTime;

    if (isExpired) {
      const err = createError(
        'Member check-in grace period has expired for this locked branch. Please contact gym administration.',
        403
      );
      err.code = 'member_checkin_grace_expired';
      err.data = {
        branchId: branch.id,
        billingLockedAt: branch.billingLockedAt,
        graceDays,
        graceExpiredAt: new Date(graceExpiryTime).toISOString(),
      };
      throw err;
    }
  }
};

/**
 * Returns billing lock status helper for a branch.
 */
const getBranchBillingLockStatus = (branch) => {
  if (!branch || !branch.billingLockedAt) {
    return { isLocked: false, lockedAt: null, checkinAllowed: true, checkinGraceRemainingDays: null };
  }
  const graceDays = memberCheckinGraceDays();
  const lockTime = new Date(branch.billingLockedAt).getTime();
  const graceExpiryTime = lockTime + graceDays * 24 * 60 * 60 * 1000;
  const isExpired = Date.now() > graceExpiryTime;
  const checkinGraceRemainingDays = Math.max(0, Math.ceil((graceExpiryTime - Date.now()) / (24 * 60 * 60 * 1000)));

  return {
    isLocked: true,
    lockedAt: branch.billingLockedAt,
    checkinAllowed: !isExpired,
    checkinGraceRemainingDays,
  };
};

module.exports = {
  enforceBranchBillingLocksForTenant,
  assertBranchNotBillingLocked,
  assertBranchCheckinAllowed,
  getBranchBillingLockStatus,
};
