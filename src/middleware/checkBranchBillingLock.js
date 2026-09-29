const { assertBranchNotBillingLocked } = require('../services/branch-billing-lock.service');

/**
 * Shared Express middleware to enforce branch billing locks.
 *
 * Inspects request params, body, or query for branchId and asserts
 * that the referenced branch is NOT billing-locked.
 *
 * Rejects write requests on locked branches with 403 `branch_billing_locked`.
 */
const checkBranchBillingLock = (options = {}) => {
  return async (req, res, next) => {
    try {
      if (!req.tenantDb || !req.tenantDb.models || !req.tenantDb.models.Branch) {
        return next();
      }

      const branchId =
        (options.param && req.params[options.param]) ||
        req.params.branchId ||
        req.body?.branchId ||
        req.query?.branchId;

      if (!branchId) {
        return next();
      }

      const { Branch } = req.tenantDb.models;
      const branch = await Branch.findByPk(branchId);
      if (branch) {
        assertBranchNotBillingLocked(branch);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};

module.exports = checkBranchBillingLock;
