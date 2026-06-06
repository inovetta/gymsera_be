const { verifyToken } = require('../utils/jwt.utils');

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
    next();
  } catch (err) {
    // JsonWebTokenError / TokenExpiredError — handled by errorHandler
    next(err);
  }
};

module.exports = authenticate;
