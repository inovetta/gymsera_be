const { Op } = require('sequelize');
const { TenantSubscription, PlatformPackage, GymListing } = require('../models/platform');

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

module.exports = { getActiveSubscription, resolveMaxBranches, resolveMaxOrganizations, getUsedCapacity, UNLIMITED_ORGANIZATIONS };
