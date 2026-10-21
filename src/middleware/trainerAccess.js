/**
 * canManageTrainer(permissionKey) — NEW-98. For routes that act on one trainer by id: the caller
 * must hold the permission at that trainer's branch, or organization-wide when the trainer has no
 * branch. Owner and host pass (hasAllBranches). Unknown trainer: 404.
 * Requires `authenticate` and `tenantContext` first.
 */
const accessService = require('../services/access.service');
const { createError } = require('../utils/response.utils');
const { hasAllBranches, hasBranchAccess } = require('../utils/branchAccess.utils');

const canManageTrainer = (permissionKey) => async (req, _res, next) => {
  try {
    if (!req.user) return next(createError('Unauthorized', 401));
    if (!req.tenantDb) return next(createError('This route requires a tenant context', 400));

    const trainer = await req.tenantDb.models.Trainer.findByPk(req.params.id, { attributes: ['id', 'branchId'] });
    if (!trainer) return next(createError('Trainer not found', 404));

    let allowed = false;
    if (await hasAllBranches(req)) {
      allowed = true;
    } else if (trainer.branchId) {
      allowed = await hasBranchAccess(req, trainer.branchId, permissionKey);
    } else {
      const userId = req.user.id || req.user.sub;
      const tenantId = req.tenantDb.tenantId || req.user.tenantId;
      const grants = await accessService.resolve(req.tenantDb, tenantId, userId, null);
      allowed = grants.has(permissionKey);
    }
    if (!allowed) return next(createError('You do not have permission to assign a trainer here', 403));
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = { canManageTrainer };
