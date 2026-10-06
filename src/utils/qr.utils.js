const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const jwtConfig = require('../config/jwt.config');
const { ensureRedisReady } = require('../config/redis.config');
const { createError } = require('./response.utils');

const QR_TOKEN_TTL_SECONDS = 60; // 60-second rotating TTL
const NONCE_CACHE_TTL_SECONDS = 120; // 2 minutes to cover expiration and clock drift

// In-memory fallback for non-Redis environments (e.g. DISABLE_REDIS=true, Windows IIS single-process)
const inMemorySeenNonces = new Map();

/**
 * Generate a rotating, cryptographically signed QR token.
 * Payload: { subscriptionId, userId, tenantId, branchId }
 */
const generateAttendanceQrToken = (payload, ttlSeconds = QR_TOKEN_TTL_SECONDS) => {
  if (!jwtConfig.secret) throw new Error('JWT_SECRET is not set');
  const nonce = crypto.randomBytes(16).toString('hex');
  return jwt.sign(
    {
      type: 'ATTENDANCE_QR',
      subscriptionId: payload.subscriptionId,
      userId: payload.userId,
      tenantId: payload.tenantId,
      branchId: payload.branchId,
      nonce,
    },
    jwtConfig.secret,
    { expiresIn: `${ttlSeconds}s` }
  );
};

/**
 * Verify and decode an attendance QR token.
 * Validates cryptographic signature, expiry, and prevents replay of used nonces.
 */
const verifyAttendanceQrToken = async (token) => {
  if (!token || typeof token !== 'string') {
    throw createError('QR token is required', 400);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, jwtConfig.secret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      const expiredErr = createError('QR code has expired. Please refresh your QR code.', 401);
      expiredErr.code = 'QR_EXPIRED';
      throw expiredErr;
    }
    const invalidErr = createError('Invalid QR code token', 400);
    invalidErr.code = 'QR_INVALID';
    throw invalidErr;
  }

  if (decoded.type !== 'ATTENDANCE_QR' || !decoded.subscriptionId || !decoded.nonce) {
    throw createError('Invalid QR code token payload', 400);
  }

  // Nonce replay check
  const nonceKey = `qr_nonce:${decoded.nonce}`;
  const redis = await ensureRedisReady();

  if (redis) {
    const res = await redis.set(nonceKey, '1', 'EX', NONCE_CACHE_TTL_SECONDS, 'NX');
    if (!res) {
      const replayErr = createError('QR code has already been scanned. Please refresh your QR code.', 409);
      replayErr.code = 'QR_ALREADY_USED';
      throw replayErr;
    }
  } else {
    const now = Date.now();
    // Evict expired entries
    for (const [k, exp] of inMemorySeenNonces.entries()) {
      if (exp <= now) inMemorySeenNonces.delete(k);
    }
    if (inMemorySeenNonces.has(decoded.nonce)) {
      const replayErr = createError('QR code has already been scanned. Please refresh your QR code.', 409);
      replayErr.code = 'QR_ALREADY_USED';
      throw replayErr;
    }
    inMemorySeenNonces.set(decoded.nonce, now + NONCE_CACHE_TTL_SECONDS * 1000);
  }

  return decoded;
};

const _clearInMemoryNonces = () => {
  inMemorySeenNonces.clear();
};

module.exports = {
  QR_TOKEN_TTL_SECONDS,
  generateAttendanceQrToken,
  verifyAttendanceQrToken,
  _clearInMemoryNonces,
};
