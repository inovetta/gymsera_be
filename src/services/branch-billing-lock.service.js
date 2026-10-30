const { Op } = require('sequelize');
const { createError } = require('../utils/response.utils');
const { overquotaGraceDays, memberCheckinGraceDays } = require('../config/billing.config');
const subscriptionQuotaService = require('./subscription-quota.service');

/**
 * Branch Billing Lock Service (spec §4, §7.5.8, CAP-01)
 *
 * Enforces capacity limits on real branches when an account goes over quota after a downgrade,
 * or when its plan lapses (P7c, R-82: no entitling plan but an EXPIRED, ON_HOLD, PAUSED or
 * REVOKED one — entitled to 0 branches, so every active branch is over quota).
 * - During OVERQUOTA_GRACE_DAYS (7 days), branches remain unlocked while a countdown is surfaced.
 *   A downgrade counts from when the provider applied it; a lapse from when the plan stopped
 *   entitling (TenantSubscription.entitlementEndedAt).
 * - After grace expires, exactly overQuotaCount branches are locked:
 *   1. Branches NOT in getBranchesToKeep(tenantId) first (most recently created first).
 *   2. Otherwise the most recently created first.
 * - A locked branch:
 *   - Data stays visible (GET requests).
 *   - No new members, sales/payments, plans, or staff (checked in ONE shared place).
 *   - Existing members can still check in for MEMBER_CHECKIN_GRACE_DAYS (7 days) after lock, then not.
 * - Unlock is automatic when capacity returns (upgrade, a plan that entitles again, or deleting another branch).
 * - Every lock/unlock writes a CapacityEvent (BRANCH_BILLING_LOCKED / BRANCH_BILLING_UNLOCKED) with idempotencyKey.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The tenant's over-quota state, the one computation the lock sweep, the branch quota and
 * GET /host/subscription/current all read (P7c):
 *   - an entitling plan: its overQuotaCount, grace from the applied downgrade (else updatedAt);
 *   - a lapsed plan: every active branch, grace from entitlementEndedAt (set here once, to now,
 *     for a row that lapsed before platform migration p026 recorded it);
 *   - neither (a tenant that never had a plan): not over quota.
 * @returns {Promise<{ subscription: object|null, lapsed: boolean, overQuotaCount: number,
 *   graceStartedAt: Date|null, graceEndsAt: Date|null, inGrace: boolean, remainingDays: number|null }>}
 */
const getOverQuotaState = async (tenantId, tenantDb, { transaction } = {}) => {
  const graceDays = overquotaGraceDays();
  const notOver = (subscription, lapsed) => ({
    subscription, lapsed, overQuotaCount: 0, graceStartedAt: null, graceEndsAt: null, inGrace: false, remainingDays: null,
  });

  let subscription = await subscriptionQuotaService.getActiveSubscription(tenantId, { transaction });
  let lapsed = false;
  let overQuotaCount;
  let graceStartedAt;
  if (subscription) {
    overQuotaCount = subscription.overQuotaCount || 0;
    if (overQuotaCount <= 0) return notOver(subscription, false);
    const change = subscription.pendingChange;
    graceStartedAt = change?.appliedAt ? new Date(change.appliedAt) : new Date(subscription.updatedAt);
  } else {
    subscription = await subscriptionQuotaService.getLapsedSubscription(tenantId, { transaction });
    if (!subscription) return notOver(null, false);
    lapsed = true;
    overQuotaCount = tenantDb ? await tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } }) : subscription.overQuotaCount || 0;
    if (overQuotaCount <= 0) return notOver(subscription, true);
    if (!subscription.entitlementEndedAt) await subscription.update({ entitlementEndedAt: new Date() }, { transaction });
    graceStartedAt = new Date(subscription.entitlementEndedAt);
  }

  const graceEndsAt = new Date(graceStartedAt.getTime() + graceDays * DAY_MS);
  const inGrace = Date.now() < graceEndsAt.getTime();
  return {
    subscription,
    lapsed,
    overQuotaCount,
    graceStartedAt,
    graceEndsAt,
    inGrace,
    remainingDays: Math.max(0, Math.ceil((graceEndsAt.getTime() - Date.now()) / DAY_MS)),
  };
};

/**
 * Evaluates and applies/removes branch billing locks for a tenant.
 *
 * @param {string} tenantId
 * @param {object} tenantDb
 * @param {object} [opts]
 * @param {import('sequelize').Transaction} [opts.transaction] - the platform transaction that just wrote
 *   the plan (reconcileCapacity): the state is read inside it, so the sweep sees the new status.
 * @returns {Promise<{ overQuotaCount: number, lockedCount: number, unlockedCount: number, inGrace: boolean, remainingDays: number|null, lapsed: boolean }>}
 */
const enforceBranchBillingLocksForTenant = async (tenantId, tenantDb, { transaction } = {}) => {
  const { Branch } = tenantDb.models;
  const state = await getOverQuotaState(tenantId, tenantDb, { transaction });
  const { overQuotaCount, lapsed } = state;

  // 1. If not over quota, unlock any previously locked branches
  if (overQuotaCount <= 0) {
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

    return { overQuotaCount: 0, lockedCount: 0, unlockedCount, inGrace: false, remainingDays: null, lapsed };
  }

  // 2. Over-quota grace countdown (R-3, default 7 days)
  if (state.inGrace) {
    return { overQuotaCount, lockedCount: 0, unlockedCount: 0, inGrace: true, remainingDays: state.remainingDays, lapsed };
  }

  // 3. Grace has expired: determine exactly `overQuotaCount` branches to lock
  const activeBranches = await Branch.findAll({
    where: { status: 'ACTIVE' },
    order: [['createdAt', 'DESC']],
  });

  const keepBranchIds = await subscriptionQuotaService.getBranchesToKeep(tenantId, { transaction });
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
          billingLockReason: lapsed
            ? 'The plan has ended: no branch is covered until a plan is active again'
            : 'Account over branch capacity following subscription change',
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
    lapsed,
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
  getOverQuotaState,
  enforceBranchBillingLocksForTenant,
  assertBranchNotBillingLocked,
  assertBranchCheckinAllowed,
  getBranchBillingLockStatus,
};
