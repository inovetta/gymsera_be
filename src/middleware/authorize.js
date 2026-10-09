/**
 * authorize(...roles) — role-based access control middleware factory.
 *
 * Usage:
 *   router.post('/admin/thing', authenticate, authorize('PLATFORM_ADMIN'), handler);
 *   router.get('/host/thing',  authenticate, authorize('GYM_HOST', 'BRANCH_MANAGER'), handler);
 */
const authorize = (...roles) => {
  return async (req, _res, next) => {
    if (!req.user) {
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      return next(err);
    }

    if (roles.includes(req.user.role)) {
      return next();
    }

    if (roles.includes('GYM_HOST')) {
      try {
        if (req.user?.isOwner === true) {
          return next();
        }
        const userId = req.user?.id || req.user?.sub;
        const tenantId = req.user?.tenantId || req.tenantDb?.tenantId || req.tenantId;
        if (userId && tenantId) {
          const membershipService = require('../services/membership.service');
          const owned = await membershipService.listOwnedTenants(userId, {
            statuses: ['ACTIVE', 'SUSPENDED'],
            attributes: ['id'],
          });
          if (owned.some((t) => t.id === tenantId)) {
            if (req.user) req.user.isOwner = true;
            return next();
          }
        }
      } catch (_) {}
    }

    const err = new Error('Forbidden: you do not have permission to access this resource');
    err.statusCode = 403;
    return next(err);
  };
};

module.exports = authorize;
