const { Op } = require('sequelize');
const { TenantSubscription, PlatformPackage, GymListing, CapacityEvent } = require('../models/platform');

/**
 * Single source of truth for "what does this tenant's active subscription
 * actually entitle them to." Before this existed, the same three-tier
 * fallback (store-verified branchCount -> legacy package.maxBranches ->
 * tenant.selectedPackageId's package) was copy-pasted independently into
 * gym.service.js#createBranch, host.controller.js#getBranchQuota,
 * host.controller.js#getOrganizationQuota, and host.controller.js#createListing
 * — each one only got updated when someone happened to touch that specific
 * file. That's exactly how a real store-verified IAP subscription
 * (branchCount populated, platformPackageId/package left null — see
 * TenantSubscription.model.js) ended up correctly unlocking the branch-quota
 * check while still getting rejected by the organization-creation endpoint
 * with "Organization limit reached", weeks apart, as what looked like two
 * separate bugs but was really one bug in four places. Every quota check
 * should call through here instead of re-deriving this itself.
 */

/** The tenant's current entitlement — the most recently created ACTIVE subscription, if any. */
const getActiveSubscription = async (tenantId, { transaction } = {}) => {
  return TenantSubscription.findOne({
    where: { tenantId, status: 'ACTIVE' },
    include: [{ model: PlatformPackage, as: 'package', attributes: ['maxBranches', 'maxOrganizations'] }],
    order: [['createdAt', 'DESC']],
    transaction,
  });
};

/**
 * Max branches this tenant may have, across all their organizations combined.
 * Pass the tenant row and its resolved active subscription (from
 * getActiveSubscription) to avoid re-querying when a caller already has both.
 */
const resolveMaxBranches = async (tenant, activeSub, { transaction } = {}) => {
  if (activeSub && activeSub.branchCount != null) {
    // Store-verified (IAP/billing-plan) subscription — branchCount is the
    // real entitlement, snapshotted from BillingPlan at purchase time.
    // platformPackageId/package are deliberately null on this path.
    return activeSub.branchCount;
  }
  if (activeSub && activeSub.package) {
    return activeSub.package.maxBranches;
  }
  if (tenant.selectedPackageId) {
    const pkg = await PlatformPackage.findByPk(tenant.selectedPackageId, { transaction });
    if (pkg) return pkg.maxBranches;
  }
  return 1; // legacy default, matches every pre-billing-plan tenant
};

// JSON-safe stand-in for "no limit" — Infinity itself serializes to `null`
// over JSON (sendSuccess(res, {...}) would ship maxOrganizations: null,
// which the Flutter side would then default back down to 1, the opposite
// of what this is supposed to mean), so a very large finite number is used
// instead. Never compared against anything real; existingListings.length is
// never going to approach it.
const UNLIMITED_ORGANIZATIONS = Number.MAX_SAFE_INTEGER;

/**
 * Max organizations (GymListings) this tenant may create. Under the IAP
 * branch-count pricing model, organizations are genuinely free — creating
 * one costs nothing and consumes no capacity by itself (only building a
 * real branch into it does) — so there's no cap here at all for that path.
 * The legacy manual/PlatformPackage path still enforces whatever that
 * package's real maxOrganizations was.
 */
const resolveMaxOrganizations = async (tenant, activeSub, { transaction } = {}) => {
  if (activeSub && activeSub.branchCount != null) {
    return UNLIMITED_ORGANIZATIONS;
  }
  if (activeSub && activeSub.package) {
    return activeSub.package.maxOrganizations || 1;
  }
  if (tenant.selectedPackageId) {
    const pkg = await PlatformPackage.findByPk(tenant.selectedPackageId, { transaction });
    if (pkg) return pkg.maxOrganizations || 1;
  }
  return 1;
};

/**
 * How much of the tenant's branch-count subscription is already spoken for
 * — real ACTIVE branches (tenant DB, one shared pool across every
 * organization) plus every organization's reservedSlots (platform DB, units
 * earmarked but not yet built). Both count against the same total; a
 * reserved slot that later gets built increments the branch count and
 * decrements reservedSlots in the same operation, so this sum never double-
 * counts it. This is what every capacity check (createBranch, createListing,
 * getBranchQuota, reserving/moving a slot) must compare against maxBranches
 * — never just the raw active-branch count, which alone would let a host's
 * unbuilt reservations silently vanish from enforcement.
 */
const getUsedCapacity = async (tenantId, tenantDb, { transaction } = {}) => {
  const [activeBranches, reservedTotal] = await Promise.all([
    tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } }),
    // Excludes deleted (INACTIVE) organizations — otherwise a reservedSlots
    // count left on a deleted organization would permanently lock that
    // capacity out of the pool forever, since nothing else ever reads or
    // clears reservedSlots on a listing once it's gone.
    GymListing.sum('reservedSlots', { where: { tenantId, status: { [Op.ne]: 'INACTIVE' } }, transaction }),
  ]);
  return activeBranches + (reservedTotal || 0);
};

/**
 * Writes one CapacityEvent row, but only if a row with this idempotencyKey
 * doesn't already exist — makes every caller safe to retry (webhook
 * redelivery, a failed transaction retried, the daily reconciliation pass
 * running twice) without double-applying its reservedSlots delta. Must be
 * called inside the same transaction as the reservedSlots mutation it
 * describes, and callers must check the return value: `applied: false`
 * means this exact event was already recorded and the caller must NOT also
 * re-apply the delta.
 */
const recordCapacityEvent = async (fields, { transaction }) => {
  const already = await CapacityEvent.findOne({ where: { idempotencyKey: fields.idempotencyKey }, transaction });
  if (already) return { applied: false, event: already };
  const event = await CapacityEvent.create(fields, { transaction });
  return { applied: true, event };
};

/**
 * Enforces the one invariant every branch/slot operation depends on:
 *
 *   activeBranches(tenant) + Σ reservedSlots(tenant's listings) <= maxBranches(tenant)
 *
 * Called every time a subscription's branchCount is written (upgrade,
 * downgrade, or a no-op renewal — see apple-billing.service.js
 * #syncSubscriptionFromTransaction) and once daily for every ACTIVE
 * subscription as a safety net (subscription-expiry.cron.js). Must run
 * inside the platform-DB transaction that also writes the TenantSubscription
 * row, so the invariant is never observably violated even momentarily.
 *
 * Upgrade (headroom grew): if `previousMaxBranches` is given and is lower
 * than `newMaxBranches`, the newly added capacity is attributed as a
 * reservedSlot on `originListingId` (the organization the purchase was
 * initiated from, when known) or the tenant's oldest organization otherwise
 * — matching the precedent already set for a brand-new tenant's first
 * purchase in tenant-provisioning.service.js. This is skipped on a plain
 * renewal (previousMaxBranches == newMaxBranches) so re-syncing an unchanged
 * subscription never attributes phantom capacity.
 *
 * Downgrade (capacity shrank below what's committed): trims unbuilt
 * reservedSlots first, tenant-wide, from the organizations holding the most
 * first — never an ACTIVE branch, ever. Any overage that can't be absorbed
 * by trimming slots (real branches genuinely exceed the new plan) is
 * recorded as `overQuotaCount` on the subscription row instead — a
 * host-facing "over your plan" flag that blocks new consumption (new
 * branches, restores) without touching anything that already exists.
 */
const reconcileCapacity = async (
  tenantId,
  tenantDb,
  newMaxBranches,
  {
    transaction,
    previousMaxBranches = null,
    originListingId = null,
    idempotencyPrefix,
    actorUserId = null,
    actorType = 'SYSTEM',
  }
) => {
  if (!transaction) throw new Error('reconcileCapacity requires a platform-DB transaction');
  if (!idempotencyPrefix) throw new Error('reconcileCapacity requires idempotencyPrefix (e.g. an externalTransactionId or a cron run key)');

  // Lock every non-deleted listing for this tenant up front so nothing else
  // (createBranch, moveBranch, transferReservedSlots) can mutate reservedSlots
  // underneath this reconciliation. Oldest-first — the natural order to fall
  // back to for "which org gets an upgrade's new capacity" when no specific
  // origin is known.
  const listings = await GymListing.findAll({
    where: { tenantId, status: { [Op.ne]: 'INACTIVE' } },
    order: [['createdAt', 'ASC']],
    lock: true,
    transaction,
  });

  const activeBranches = await tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } });
  const reservedTotal = listings.reduce((sum, l) => sum + l.reservedSlots, 0);
  const overage = activeBranches + reservedTotal - newMaxBranches;

  if (overage <= 0) {
    // Headroom exists (or exactly matches). If this call represents a real
    // increase, hand the new capacity to the host as a spendable slot right
    // away instead of leaving it to float unattributed.
    //
    // The amount attributed is `-overage` (== newMaxBranches - the tenant's
    // CURRENT committed capacity), never `newMaxBranches - previousMaxBranches`
    // — those two only coincide when the account was exactly at capacity
    // before this call. They diverge, and the naive subtraction breaks the
    // invariant this function exists to protect, whenever the account was
    // already over-quota going into the upgrade (e.g. a downgrade left 3
    // real branches active against a 1-branch plan, then the host upgrades
    // to 5: attributing 5-1=4 would push committed capacity to 3+4=7,
    // blowing straight through the new 5-branch limit). `-overage` is
    // always exactly the true remaining headroom after this change, so
    // committed capacity can never exceed newMaxBranches — found via a
    // downgrade-then-upgrade end-to-end test, not by inspection.
    const grew = previousMaxBranches != null && newMaxBranches > previousMaxBranches;
    if (grew && overage < 0) {
      const delta = -overage;
      const target = listings.find((l) => l.id === originListingId) || listings[0];
      if (target) {
        const { applied } = await recordCapacityEvent(
          {
            tenantId,
            listingId: target.id,
            action: 'SLOT_ATTRIBUTED_UPGRADE',
            delta,
            reservedSlotsBefore: target.reservedSlots,
            reservedSlotsAfter: target.reservedSlots + delta,
            actorUserId,
            actorType,
            reason: `Subscription increased from ${previousMaxBranches} to ${newMaxBranches} branches`,
            idempotencyKey: `slot_attribute_upgrade:${idempotencyPrefix}:${target.id}`,
          },
          { transaction }
        );
        if (applied) {
          await target.increment('reservedSlots', { by: delta, transaction });
        }
      }
    }

    // Any previously-set over-quota flag is now resolved.
    await TenantSubscription.update(
      { overQuotaCount: 0 },
      { where: { tenantId, status: 'ACTIVE' }, transaction }
    );
    return { overQuotaCount: 0, trimmedSlots: 0 };
  }

  // Over capacity — trim unbuilt reservedSlots first, from the
  // largest holders down, never touching a real branch.
  let remaining = overage;
  let trimmedSlots = 0;
  const trimOrder = [...listings].sort((a, b) => b.reservedSlots - a.reservedSlots);
  for (const listing of trimOrder) {
    if (remaining <= 0) break;
    if (listing.reservedSlots <= 0) continue;
    const take = Math.min(listing.reservedSlots, remaining);
    const { applied } = await recordCapacityEvent(
      {
        tenantId,
        listingId: listing.id,
        action: 'SLOT_TRIMMED_DOWNGRADE',
        delta: -take,
        reservedSlotsBefore: listing.reservedSlots,
        reservedSlotsAfter: listing.reservedSlots - take,
        actorUserId,
        actorType,
        reason: `Subscription reduced to ${newMaxBranches} branches`,
        idempotencyKey: `slot_trim_downgrade:${idempotencyPrefix}:${listing.id}`,
      },
      { transaction }
    );
    if (applied) {
      await listing.decrement('reservedSlots', { by: take, transaction });
      remaining -= take;
      trimmedSlots += take;
    } else {
      // Already trimmed by an earlier, still-pending retry of this same
      // event — don't double count it against `remaining`.
      remaining -= Math.min(take, remaining);
    }
  }

  // `remaining` > 0 here means real ACTIVE branches alone exceed the new
  // plan — never resolved by deleting or hiding anything, only flagged.
  await TenantSubscription.update(
    { overQuotaCount: Math.max(0, remaining) },
    { where: { tenantId, status: 'ACTIVE' }, transaction }
  );

  return { overQuotaCount: Math.max(0, remaining), trimmedSlots };
};

module.exports = {
  recordCapacityEvent,
  getActiveSubscription,
  resolveMaxBranches,
  resolveMaxOrganizations,
  getUsedCapacity,
  reconcileCapacity,
  UNLIMITED_ORGANIZATIONS,
};
