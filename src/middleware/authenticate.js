const { verifyToken } = require('../utils/jwt.utils');
const { safeRedisGet, safeRedisSet } = require('../config/redis.config');
const { User } = require('../models/platform');
const {
  getUserAuthCache,
  setUserAuthCache,
  clearUserAuthCache,
} = require('../utils/user-auth-cache');

// AUTH-07: a token issued while the account is PENDING_DELETION (`dp` claim) may only
// look at the profile, read the deletion preflight, and cancel the deletion.
const ALLOWED_WHILE_PENDING_DELETION = [
  ['GET', /\/me\/profile\/?$/],
  ['GET', /\/auth\/me\/?$/],
  ['GET', /\/me\/deletion-preflight\/?$/],
  ['POST', /\/me\/request-deletion\/?$/],
  ['POST', /\/me\/cancel-deletion\/?$/],
  ['POST', /\/auth\/(logout|refresh)\/?$/],
];
const allowedWhilePendingDeletion = (req) => {
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  return ALLOWED_WHILE_PENDING_DELETION.some(([method, re]) => req.method === method && re.test(pathname));
};

/**
 * authenticate — verifies the JWT from the Authorization header.
 * Checks permission version (`ver` claim) and live user status (AUTH-08 & NEW-37).
 * On success, attaches the decoded payload to req.user.
 * On failure, passes an error to the error handler.
 */
const authenticate = async (req, _res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('No token provided');
    err.statusCode = 401;
    err.code = 'unauthorized';
    return next(err);
  }

  const token = authHeader.slice(7);

  try {
    const decoded = verifyToken(token);
    // Normalize: JWT uses `sub` for the user ID; expose it as `id` too
    req.user = decoded;
    if (decoded.sub && !decoded.id) req.user.id = decoded.sub;

    const userId = decoded.sub || decoded.id;

    // Check user status and permission version (AUTH-08 & NEW-37)
    // 1. Fast in-process cache (30s TTL, bounded) — prevents per-request DB queries when Redis is absent
    let userMeta = getUserAuthCache(userId);
    const cacheKey = `user:${userId}:auth`;

    if (!userMeta) {
      // 2. Redis fallback
      try {
        const cached = await safeRedisGet(cacheKey);
        if (cached) {
          userMeta = JSON.parse(cached);
          if (userMeta) {
            setUserAuthCache(userId, userMeta);
          }
        }
      } catch (_) {}
    }

    if (!userMeta && userId) {
      // 3. Platform DB query (only when in-process and Redis both miss)
      const dbUser = await User.findByPk(userId, {
        attributes: ['id', 'status', 'permissionVersion'],
      });
      if (dbUser) {
        userMeta = {
          status: dbUser.status,
          ver: dbUser.permissionVersion || 1,
        };
        setUserAuthCache(userId, userMeta);
        try {
          await safeRedisSet(cacheKey, JSON.stringify(userMeta), 60);
        } catch (_) {}
      }
    }

    if (userMeta) {
      if (userMeta.status === 'SUSPENDED' || userMeta.status === 'DELETED') {
        const err = new Error('User not found or account is suspended');
        err.statusCode = 401;
        err.code = 'unauthorized';
        return next(err);
      }

      // AUTH-08: Immediate permission revocation (ver claim checked against DB/cache per §8.2)
      if (decoded.ver != null && Number(decoded.ver) < Number(userMeta.ver)) {
        const revoked = new Error('Your permissions have changed. Please refresh your session or sign in again.');
        revoked.statusCode = 403;
        revoked.code = 'forbidden';
        return next(revoked);
      }
    }

    // AUTH-07: tokens issued during PENDING_DELETION carry `dp: true` and are restricted to allowed routes
    if (decoded.dp === true && !allowedWhilePendingDeletion(req)) {
      const blocked = new Error('Your account is scheduled for deletion. Cancel the deletion to keep using GymsEra.');
      blocked.statusCode = 403;
      blocked.code = 'account_pending_deletion';
      return next(blocked);
    }

    next();
  } catch (err) {
    // JsonWebTokenError / TokenExpiredError — handled by errorHandler
    next(err);
  }
};

authenticate.clearUserAuthCache = clearUserAuthCache;
authenticate.getUserAuthCache = getUserAuthCache;

module.exports = authenticate;
