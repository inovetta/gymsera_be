/**
 * Branch quota for one tenant (max / used / remaining, over-quota grace).
 *
 * Extracted from host.controller#getBranchQuota so GET /host/branch-quota and
 * GET /me/bootstrap return exactly the same numbers from one implementation.
 */
const TenantDbManager = require('../database/TenantDbManager');
const { Tenant, GymListing } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const subscriptionQuotaService = require('./subscription-quota.service');

const getBranchQuota = async (tenantId, { businessId = null } = {}) => {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw createError('Tenant not found', 404);

  const activeSub = await subscriptionQuotaService.getActiveSubscription(tenantId);
  const maxBranches = await subscriptionQuotaService.resolveMaxBranches(tenant, activeSub);

  // usedBranches/remainingBranches are always tenant-wide — the branch-
  // count subscription is one shared pool across every organization, and
  // includes every organization's reservedSlots (paid, unbuilt) alongside
  // real ACTIVE branches, since a reservation already counts as used the
  // moment it's made (subscription-quota.service.js#getUsedCapacity).
  // businessBranches/businessReservedSlots (only present with
  // ?businessId=) are additive: what THIS specific organization holds,
  // for the Gyms tab's per-organization "N branches, M unbuilt slots" view
  // — a real number now, not a generic slice of tenant-wide leftovers.
  let usedBranches = 0;
  let activeBranches = 0;
  let businessBranches = 0;
  let businessReservedSlots = 0;

  // NEW-114: a failed read is an error, never zeros. "0 of N used" from a database
  // that could not be reached reads as real capacity (UX-08). GET /me/bootstrap
  // already turns a failure into `quota: null`; the host routes answer the error.
  if (tenant.status === 'ACTIVE' && tenant.connectionStringEncrypted) {
    const tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
    usedBranches = await subscriptionQuotaService.getUsedCapacity(tenantId, tenantDb);
    activeBranches = await tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } });

    if (businessId) {
      businessBranches = await tenantDb.models.Branch.count({
        where: { status: 'ACTIVE', gymId: businessId },
      });
      const orgListing = await GymListing.findOne({
        where: { id: businessId, tenantId },
        attributes: ['reservedSlots'],
      });
      businessReservedSlots = orgListing ? orgListing.reservedSlots : 0;
    }
  }

  const remainingBranches = Math.max(0, maxBranches - usedBranches);

  const overquotaGraceDays = require('../config/billing.config').overquotaGraceDays;
  const graceDays = overquotaGraceDays();
  let overQuotaGraceRemainingDays = null;
  let isOverQuotaGraceExpired = false;
  if (activeSub && activeSub.overQuotaCount > 0) {
    const change = activeSub.pendingChange;
    const appliedAt = change?.appliedAt ? new Date(change.appliedAt) : new Date(activeSub.updatedAt);
    const graceExpiry = new Date(appliedAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
    isOverQuotaGraceExpired = Date.now() >= graceExpiry.getTime();
    overQuotaGraceRemainingDays = Math.max(0, Math.ceil((graceExpiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  }

  return {
    maxBranches,
    usedBranches,
    remainingBranches,
    activeBranches,
    buildableBranches: Math.max(0, maxBranches - activeBranches),
    overQuotaCount: activeSub?.overQuotaCount || 0,
    overQuotaGraceDays: graceDays,
    overQuotaGraceRemainingDays,
    isOverQuotaGraceExpired,
    ...(businessId ? { businessBranches, businessReservedSlots } : {}),
  };
};

module.exports = { getBranchQuota };
