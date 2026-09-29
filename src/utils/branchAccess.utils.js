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

module.exports = {
  hasBranchAccess,
  hasDirectBranchAccess,
};
