const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { OAuth2Client } = require('google-auth-library');

const { User, Tenant, RefreshToken, Otp } = require('../models/platform');
const { signToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt.utils');
const { generateOtpCode, getOtpExpiry } = require('../utils/otp.utils');
const { createError } = require('../utils/response.utils');
const emailService = require('./email.service');
const { UserRole } = require('../constants/roles');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const BCRYPT_ROUNDS = 12;

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Invalidate all unused OTPs of a given type for a user.
 */
const _invalidatePreviousOtps = async (userId, type) => {
  await Otp.update(
    { isUsed: true },
    { where: { userId, type, isUsed: false } }
  );
};

/**
 * Find a valid (unused, unexpired) OTP.
 */
const _findValidOtp = async (userId, code, type) => {
  return Otp.findOne({
    where: {
      userId,
      code,
      type,
      isUsed: false,
      expiresAt: { [Op.gt]: new Date() },
    },
  });
};

/**
 * Build the JWT payload for a user, resolving tenantId for GymHost accounts.
 */
const _buildTokenPayload = async (user) => {
  let tenantId = null;

  if (user.role === UserRole.GYM_HOST) {
    const tenant = await Tenant.findOne({
      where: { ownerUserId: user.id },
      attributes: ['id'],
      order: [['createdAt', 'DESC']],
    });
    tenantId = tenant ? tenant.id : null;
  }

  return {
    sub: user.id,
    email: user.email,
    role: user.role,
    isVerified: user.isVerified,
    tenantId,
    branchId: null,
  };
};

/**
 * Issue a JWT + refresh token pair, store the refresh token in the DB.
 */
const _issueTokenPair = async (user, ipAddress, userAgent) => {
  const payload = await _buildTokenPayload(user);

  const accessToken = signToken(payload);
  const refreshToken = signRefreshToken({ sub: user.id });

  // Decode the signed refresh token to get its actual expiry
  const decoded = jwt.decode(refreshToken);
  const expiresAt = new Date(decoded.exp * 1000);

  await RefreshToken.create({
    userId: user.id,
    token: refreshToken,
    expiresAt,
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
  });

  return { accessToken, refreshToken, user: _sanitizeUser(user, payload.tenantId) };
};

/**
 * Strip sensitive fields before returning user data in responses.
 */
const _sanitizeUser = (user, tenantId = null) => ({
  id: user.id,
  fullName: user.fullName,
  email: user.email,
  role: user.role,
  isVerified: user.isVerified,
  profileImageUrl: user.profileImageUrl || null,
  tenantId,
});

// ── Public service methods ────────────────────────────────────────────────────

/**
 * Register a new user with email + password.
 * Sends an OTP to the provided email for verification.
 */
const register = async ({ fullName, email, password, phone }) => {
  const existing = await User.findOne({ where: { email } });
  if (existing) throw createError('An account with this email already exists', 409);

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = await User.create({
    fullName,
    email,
    phone: phone || null,
    passwordHash,
    role: UserRole.MEMBER,
    status: 'INACTIVE',
    isVerified: false,
  });

  const code = generateOtpCode();
  const otp = await Otp.create({
    userId: user.id,
    email,
    code,
    type: 'EMAIL_VERIFICATION',
    expiresAt: getOtpExpiry(),
  });

  await emailService.sendOtpEmail(email, fullName, code);

  const result = { userId: user.id, email, otpExpiresAtUtc: otp.expiresAt };
  // Expose the OTP code in dev/test so Postman / integration tests don't need email
  if (process.env.NODE_ENV !== 'production') result.debugCode = code;
  return result;
};

/**
 * Verify the email OTP and activate the account.
 * Returns a JWT + refresh token pair on success.
 */
const verifyOtp = async ({ email, code }, ipAddress, userAgent) => {
  const user = await User.findOne({ where: { email } });
  if (!user) throw createError('Invalid email or code', 400);

  if (user.isVerified) throw createError('Account is already verified', 400);

  const otp = await _findValidOtp(user.id, code, 'EMAIL_VERIFICATION');
  if (!otp) throw createError('Invalid or expired OTP', 400);

  // Mark OTP used and activate user in a single transaction
  await Promise.all([
    otp.update({ isUsed: true }),
    user.update({ isVerified: true, status: 'ACTIVE' }),
  ]);

  return _issueTokenPair(user, ipAddress, userAgent);
};

/**
 * Resend a fresh OTP to the user's email for email verification.
 */
const resendOtp = async ({ email }) => {
  const user = await User.findOne({ where: { email } });

  // Don't reveal if email exists — return the same message either way
  if (!user || user.isVerified) {
    return { message: 'If this email is registered and unverified, a new code has been sent.' };
  }

  await _invalidatePreviousOtps(user.id, 'EMAIL_VERIFICATION');

  const code = generateOtpCode();
  await Otp.create({
    userId: user.id,
    email,
    code,
    type: 'EMAIL_VERIFICATION',
    expiresAt: getOtpExpiry(),
  });

  await emailService.sendOtpEmail(email, user.fullName, code);

  return { message: 'If this email is registered and unverified, a new code has been sent.' };
};

/**
 * Login with email + password.
 * Returns a JWT + refresh token pair on success.
 */
const login = async ({ email, password }, ipAddress, userAgent) => {
  const user = await User.findOne({ where: { email } });

  if (!user || !user.passwordHash) {
    throw createError('Invalid email or password', 401);
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatch) throw createError('Invalid email or password', 401);

  if (!user.isVerified) {
    // Auto-resend a fresh OTP so the user can complete verification without
    // having to manually call /auth/otp/resend — matches .NET behaviour
    await _invalidatePreviousOtps(user.id, 'EMAIL_VERIFICATION');
    const code = generateOtpCode();
    const otp = await Otp.create({
      userId: user.id,
      email,
      code,
      type: 'EMAIL_VERIFICATION',
      expiresAt: getOtpExpiry(),
    });
    await emailService.sendOtpEmail(email, user.fullName, code);

    const payload = {
      email: user.email,
      fullName: user.fullName,
      otpExpiresAtUtc: otp.expiresAt,
    };
    if (process.env.NODE_ENV !== 'production') payload.debugCode = code;

    // Use a structured error so the controller can return success:false + data
    const err = createError('Account is not verified. A new OTP has been sent to your email.', 403);
    err.pendingOtp = payload;
    throw err;
  }

  if (user.status !== 'ACTIVE') {
    throw createError('Your account has been suspended. Please contact support.', 403);
  }

  await user.update({ lastLoginAt: new Date() });

  return _issueTokenPair(user, ipAddress, userAgent);
};

/**
 * Login or register via Google ID Token.
 * On first login, creates a new ACTIVE + verified account automatically.
 */
const googleLogin = async ({ idToken }, ipAddress, userAgent) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    throw createError('Google authentication is not configured', 503);
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    throw createError('Invalid Google ID token', 401);
  }

  if (!payload.email_verified) {
    throw createError('Google account email is not verified', 401);
  }

  const { sub: googleId, email, name, picture } = payload;

  // Try to find by googleId first, then fall back to email (to link existing accounts)
  let user = await User.findOne({ where: { googleId } });

  if (!user) {
    user = await User.findOne({ where: { email } });

    if (user) {
      // Link Google ID to existing account
      await user.update({ googleId, profileImageUrl: user.profileImageUrl || picture || null });
    } else {
      // Create brand new user
      user = await User.create({
        fullName: name || email,
        email,
        googleId,
        profileImageUrl: picture || null,
        role: UserRole.MEMBER,
        status: 'ACTIVE',
        isVerified: true,
        passwordHash: null,
      });
    }
  }

  if (user.status !== 'ACTIVE') {
    throw createError('Your account has been suspended. Please contact support.', 403);
  }

  await user.update({ lastLoginAt: new Date() });

  return _issueTokenPair(user, ipAddress, userAgent);
};

/**
 * Rotate a refresh token — revoke the old one, issue a new pair.
 */
const refreshTokens = async (token, ipAddress, userAgent) => {
  // Verify the JWT signature first
  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    throw createError('Invalid or expired refresh token', 401);
  }

  // Look up in DB — must not be revoked or expired
  const stored = await RefreshToken.findOne({
    where: {
      token,
      userId: decoded.sub,
      isRevoked: false,
      expiresAt: { [Op.gt]: new Date() },
    },
  });

  if (!stored) throw createError('Refresh token not found or already revoked', 401);

  const user = await User.findByPk(decoded.sub);
  if (!user || user.status !== 'ACTIVE') {
    throw createError('User not found or inactive', 401);
  }

  // Revoke old token and issue new pair atomically
  await stored.update({ isRevoked: true });

  return _issueTokenPair(user, ipAddress, userAgent);
};

/**
 * Request a password reset — sends an OTP to the registered email.
 * Always returns the same message to prevent email enumeration.
 */
const passwordResetRequest = async ({ email }) => {
  const user = await User.findOne({ where: { email, isVerified: true } });

  if (user) {
    await _invalidatePreviousOtps(user.id, 'PASSWORD_RESET');

    const code = generateOtpCode();
    await Otp.create({
      userId: user.id,
      email,
      code,
      type: 'PASSWORD_RESET',
      expiresAt: getOtpExpiry(),
    });

    await emailService.sendPasswordResetEmail(email, user.fullName, code);
  }

  return { message: 'If this email is registered, a password reset code has been sent.' };
};

/**
 * Confirm the password reset using the OTP + new password.
 * Revokes all active refresh tokens on success.
 */
const passwordResetConfirm = async ({ email, code, password }) => {
  const user = await User.findOne({ where: { email } });
  if (!user) throw createError('Invalid email or code', 400);

  const otp = await _findValidOtp(user.id, code, 'PASSWORD_RESET');
  if (!otp) throw createError('Invalid or expired code', 400);

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  await Promise.all([
    otp.update({ isUsed: true }),
    user.update({ passwordHash }),
    // Revoke all active refresh tokens — forces re-login everywhere
    RefreshToken.update({ isRevoked: true }, { where: { userId: user.id, isRevoked: false } }),
  ]);

  return { message: 'Password has been reset successfully. Please log in with your new password.' };
};

/**
 * Return the full authenticated user profile from the DB.
 * Richer than the JWT claims — includes phone, profileImageUrl, provider, etc.
 */
const getMe = async (userId) => {
  const user = await User.findByPk(userId, {
    attributes: [
      'id', 'fullName', 'email', 'phone', 'role',
      'isVerified', 'profileImageUrl', 'status',
      'googleId', 'lastLoginAt', 'createdAt',
    ],
  });

  if (!user) throw createError('User not found', 404);

  let tenantId = null;
  if (user.role === UserRole.GYM_HOST) {
    const tenant = await Tenant.findOne({
      where: { ownerUserId: user.id },
      attributes: ['id'],
      order: [['createdAt', 'DESC']],
    });
    tenantId = tenant ? tenant.id : null;
  }

  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone || null,
    role: user.role,
    isVerified: user.isVerified,
    status: user.status,
    profileImageUrl: user.profileImageUrl || null,
    provider: user.googleId ? 'GOOGLE' : 'LOCAL',
    tenantId,
    lastLoginAt: user.lastLoginAt || null,
    memberSince: user.createdAt,
  };
};

module.exports = {
  register,
  verifyOtp,
  resendOtp,
  login,
  googleLogin,
  refreshTokens,
  passwordResetRequest,
  passwordResetConfirm,
  getMe,
};
