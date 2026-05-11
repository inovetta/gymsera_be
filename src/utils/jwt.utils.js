const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt.config');

/**
 * Sign an access token (short-lived).
 * Payload should include: { sub, email, role, isVerified, tenantId?, branchId? }
 */
const signToken = (payload) => {
  if (!jwtConfig.secret) throw new Error('JWT_SECRET is not set');
  return jwt.sign(payload, jwtConfig.secret, { expiresIn: jwtConfig.expiresIn });
};

/**
 * Sign a refresh token (long-lived). Only stores { sub }.
 */
const signRefreshToken = (payload) => {
  if (!jwtConfig.refreshSecret) throw new Error('JWT_REFRESH_SECRET is not set');
  return jwt.sign(payload, jwtConfig.refreshSecret, { expiresIn: jwtConfig.refreshExpiresIn });
};

/**
 * Verify an access token. Throws JsonWebTokenError / TokenExpiredError on failure.
 */
const verifyToken = (token) => {
  if (!jwtConfig.secret) throw new Error('JWT_SECRET is not set');
  return jwt.verify(token, jwtConfig.secret);
};

/**
 * Verify a refresh token. Throws on failure.
 */
const verifyRefreshToken = (token) => {
  if (!jwtConfig.refreshSecret) throw new Error('JWT_REFRESH_SECRET is not set');
  return jwt.verify(token, jwtConfig.refreshSecret);
};

module.exports = { signToken, signRefreshToken, verifyToken, verifyRefreshToken };
