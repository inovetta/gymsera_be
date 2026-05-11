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
 * Returns the OTP expiry Date from now.
 */
const getOtpExpiry = () => new Date(Date.now() + OTP_TTL_MS);

module.exports = { generateOtpCode, OTP_TTL_MS, getOtpExpiry };
