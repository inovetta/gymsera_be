const crypto = require('crypto');

/**
 * Generate a cryptographically secure 6-digit OTP code.
 * Uses crypto.randomInt to avoid bias from Math.random().
 */
const generateOtpCode = () => {
  // randomInt(min, max) — max is exclusive, so (0, 1000000) gives 0-999999
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
};

/**
 * OTP TTL in milliseconds (10 minutes)
 */
const OTP_TTL_MS = 10 * 60 * 1000;

/**
 * Returns the OTP expiry Date from now (defaults to OTP_TTL_MS = 10 minutes).
 */
const getOtpExpiry = (minutes = 10) => new Date(Date.now() + minutes * 60 * 1000);

/**
 * Hash an OTP code with SHA-256 for secure storage at rest (AUTH-04).
 * Salted with identifier (userId or email) to prevent precomputed rainbow tables.
 */
const hashOtpCode = (code, salt = '') => {
  return crypto
    .createHash('sha256')
    .update(`${salt}:${String(code).trim()}`)
    .digest('hex');
};

/**
 * Constant-time comparison between submitted OTP and stored hash (AUTH-04).
 */
const verifyOtpHash = (submittedCode, storedHash, salt = '') => {
  if (!submittedCode || !storedHash) return false;
  const computed = hashOtpCode(submittedCode, salt);
  const bufA = Buffer.from(computed, 'hex');
  const bufB = Buffer.from(storedHash, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

module.exports = {
  generateOtpCode,
  OTP_TTL_MS,
  getOtpExpiry,
  hashOtpCode,
  verifyOtpHash,
};
