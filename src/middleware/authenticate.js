const { verifyToken } = require('../utils/jwt.utils');

// AUTH-07: a token issued while the account is PENDING_DELETION (`dp` claim) may only
// look at the profile, read the deletion preflight, and cancel the deletion.
const ALLOWED_WHILE_PENDING_DELETION = [
  ['GET', /\/me\/profile\/?$/],
  ['GET', /\/auth\/me\/?$/],
  ['GET', /\/me\/deletion-preflight\/?$/],
  ['POST', /\/me\/cancel-deletion\/?$/],
  ['POST', /\/auth\/(logout|refresh)\/?$/],
];
const allowedWhilePendingDeletion = (req) => {
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  return ALLOWED_WHILE_PENDING_DELETION.some(([method, re]) => req.method === method && re.test(pathname));
};

/**
 * authenticate — verifies the JWT from the Authorization header.
 * On success, attaches the decoded payload to req.user.
 * On failure, passes a JsonWebTokenError or TokenExpiredError to the error handler.
 */
const authenticate = (req, _res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('No token provided');
    err.statusCode = 401;
    return next(err);
  }

  const token = authHeader.slice(7);

  try {
    const decoded = verifyToken(token);
    // Normalize: JWT uses `sub` for the user ID; expose it as `id` too
    req.user = decoded;
    if (decoded.sub && !decoded.id) req.user.id = decoded.sub;
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

module.exports = authenticate;
