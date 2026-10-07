const accessService = require('../services/access.service');

/**
 * Check whether the caller has the specified permission on a given branch.
 *
 * @param {object} req Express request
 * @param {string} branchId Branch UUID
 * @param {string} permissionKey Permission string (e.g. 'payments.view', 'subscriptions.view')
 * @returns {Promise<boolean>}
 */
const hasBranchAccess = async (req, branchId, permissionKey) => {
  if (req.user?.role === 'PLATFORM_ADMIN') return true;
  if (req.user?.role === 'GYM_HOST' || req.user?.isHost === true) return true;
  if (!branchId) return false;

  const userId = req.user?.id || req.user?.sub;
  const tenantId = req.user?.tenantId || req.tenantDb?.tenantId;
  if (userId && tenantId && req.tenantDb) {
    try {
      const grants = await accessService.resolve(req.tenantDb, tenantId, userId, branchId);
      if (grants.has(permissionKey)) return true;
    } catch (err) {
      console.warn('[branchAccess] permission resolution failed:', err.message);
    }
  }

  return false;
};

/**
 * Check whether the caller holds the DIRECT-tier twin of permissionKey on branchId.
 */
const hasDirectBranchAccess = async (req, branchId, permissionKey) => {
  if (req.user?.role === 'PLATFORM_ADMIN') return true;
  if (req.user?.role === 'GYM_HOST' || req.user?.isHost === true) return true;
  if (!branchId) return false;

  const userId = req.user?.id || req.user?.sub;
  const tenantId = req.user?.tenantId || req.tenantDb?.tenantId;
  if (!userId || !tenantId || !req.tenantDb) return false;

  try {
    const grants = await accessService.resolve(req.tenantDb, tenantId, userId, branchId);
    return grants.has(`${permissionKey}.direct`);
  } catch (err) {
    console.warn('[branchAccess] direct permission resolution failed:', err.message);
    return false;
  }
};

/**
 * Callers who are not limited to particular branches: platform admins and the
 * organization's host/owner. The same short-circuit hasBranchAccess starts with.
 */
const hasAllBranches = (req) =>
  req.user?.role === 'PLATFORM_ADMIN' || req.user?.role === 'GYM_HOST' || req.user?.isHost === true;

/**
 * The ACTIVE branches at which the caller holds `permissionKey` (NEW-44).
 *
 * Built on hasBranchAccess, branch by branch, so the answer is exactly what a
 * request for that branch would get. An ORG-scoped assignment resolves at every
 * branch, so "organization-wide" needs no separate case.
 *
 * @returns {Promise<string[]|null>} branch ids, or null for "every branch" (owner,
 *   host, platform admin) — null means do not filter, not "no branches".
 */
const branchIdsWithPermission = async (req, permissionKey) => {
  if (hasAllBranches(req)) return null;
  const { Branch } = req.tenantDb.models;
  const branches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
  const allowed = [];
  for (const { id } of branches) {
    if (await hasBranchAccess(req, id, permissionKey)) allowed.push(id);
  }
  return allowed;
};

/**
 * The ACTIVE branches at which the caller holds any permission at all — "the
 * branches I work at" (NEW-44). Same null convention as branchIdsWithPermission:
 * null means every branch (owner, host, platform admin), not "none".
 */
const branchIdsWithAnyGrant = async (req) => {
  if (hasAllBranches(req)) return null;
  const userId = req.user?.id || req.user?.sub;
  const tenantId = req.user?.tenantId || req.tenantDb?.tenantId;
  if (!userId || !tenantId || !req.tenantDb) return [];

  const { Branch } = req.tenantDb.models;
  const branches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
  const allowed = [];
  for (const { id } of branches) {
    try {
      const grants = await accessService.resolve(req.tenantDb, tenantId, userId, id);
      if (grants.keys().length > 0) allowed.push(id);
    } catch (err) {
      console.warn('[branchAccess] permission resolution failed:', err.message);
    }
  }
  return allowed;
};

module.exports = {
  hasBranchAccess,
  hasDirectBranchAccess,
  hasAllBranches,
  branchIdsWithPermission,
  branchIdsWithAnyGrant,
};
