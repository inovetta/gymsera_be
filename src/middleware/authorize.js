/**
 * authorize(...roles) — role-based access control middleware factory.
 *
 * Usage:
 *   router.post('/admin/thing', authenticate, authorize('PLATFORM_ADMIN'), handler);
 *   router.get('/host/thing',  authenticate, authorize('GYM_HOST', 'BRANCH_MANAGER'), handler);
 */
const authorize = (...roles) => {
  return (req, _res, next) => {
    if (!req.user) {
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      return next(err);
    }

    if (!roles.includes(req.user.role)) {
      const err = new Error('Forbidden: you do not have permission to access this resource');
      err.statusCode = 403;
      return next(err);
    }

    next();
  };
};

module.exports = authorize;
