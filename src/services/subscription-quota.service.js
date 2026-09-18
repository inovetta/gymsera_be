const { TenantSubscription, PlatformPackage } = require('../models/platform');

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

/**
 * Max organizations (GymListings) this tenant may create. Under the IAP
 * branch-count pricing model, organizations are free — only total branches
 * count against the subscription — so branchCount is used as a safe upper
 * bound: an organization needs at least 1 branch to be useful, so a host can
 * never usefully create more organizations than their total branch
 * entitlement anyway.
 */
const resolveMaxOrganizations = async (tenant, activeSub, { transaction } = {}) => {
  if (activeSub && activeSub.branchCount != null) {
    return activeSub.branchCount;
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

module.exports = { getActiveSubscription, resolveMaxBranches, resolveMaxOrganizations };
