const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { OAuth2Client } = require('google-auth-library');
const { v4: uuidv4 } = require('uuid');

const { User, Tenant, RefreshToken, Otp, TenantInvitation, PlatformAuditLog } = require('../models/platform');
const { signToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt.utils');
const {
  generateOtpCode,
  getOtpExpiry,
  hashOtpCode,
  verifyOtpHash,
} = require('../utils/otp.utils');
const { createError } = require('../utils/response.utils');
const emailService = require('./email.service');
const { UserRole } = require('../constants/roles');
const { TenantStatus, KycStatus } = require('../constants/subscription-status');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const BCRYPT_ROUNDS = 12;

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Generate an opaque refresh token (80 hex characters) (AUTH-01).
 */
const _generateOpaqueRefreshToken = () => {
  return crypto.randomBytes(40).toString('hex');
};

/**
 * Hash a refresh token with SHA-256 for secure storage at rest (AUTH-01).
 */
const _hashToken = (rawToken) => {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
};

/**
 * Resolve refresh token expiry date from environment or default 30 days.
 */
const _getRefreshTokenExpiry = () => {
  const str = process.env.JWT_REFRESH_EXPIRES_IN || '30d';
  let ms = 30 * 24 * 60 * 60 * 1000;
  const match = String(str).match(/^(\d+)([smhd])$/);
  if (match) {
    const val = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === 's') ms = val * 1000;
    else if (unit === 'm') ms = val * 60 * 1000;
    else if (unit === 'h') ms = val * 60 * 60 * 1000;
    else if (unit === 'd') ms = val * 24 * 60 * 60 * 1000;
  }
  return new Date(Date.now() + ms);
};

const OTP_COOLDOWN_MS = 60 * 1000; // 60-second resend cooldown (AUTH-04)
const MAX_OTP_ATTEMPTS = 5; // 5 failed attempts locks code (AUTH-04)

/**
 * Enforce a 60-second cooldown between OTP requests for the same target (AUTH-04).
 */
const _assertOtpCooldown = async (userId, email, type) => {
  const conditions = [];
  if (userId) conditions.push({ userId });
  if (email) conditions.push({ email });
  if (conditions.length === 0) return;

  const latest = await Otp.findOne({
    where: {
      type,
      [Op.or]: conditions,
    },
    order: [['createdAt', 'DESC']],
  });

  if (latest) {
    const elapsedMs = Date.now() - new Date(latest.createdAt).getTime();
    if (elapsedMs < OTP_COOLDOWN_MS) {
      const waitSec = Math.ceil((OTP_COOLDOWN_MS - elapsedMs) / 1000);
      const err = createError(`Please wait ${waitSec} seconds before requesting a new code.`, 429);
      err.retryAfter = waitSec;
      throw err;
    }
  }
};

/**
 * Enforce per-identifier rate limiting: max 10 OTP requests per hour per email (AUTH-04).
 */
const _assertIdentifierRateLimit = async (email) => {
  if (!email) return;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const count = await Otp.count({
    where: {
      email,
      createdAt: { [Op.gt]: oneHourAgo },
    },
  });
  if (count >= 10) {
    throw createError('Too many verification codes requested for this email. Please try again later.', 429);
  }
};

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
 * Verify submitted OTP against hashed DB record with attempt counting and lockout (AUTH-04).
 */
const _verifyAndConsumeOtp = async (userId, submittedCode, type) => {
  const otp = await Otp.findOne({
    where: {
      userId,
      type,
      expiresAt: { [Op.gt]: new Date() },
    },
    order: [['createdAt', 'DESC']],
  });

  if (!otp) {
    throw createError('Invalid or expired OTP', 400);
  }

  if (otp.attempts >= (otp.maxAttempts || MAX_OTP_ATTEMPTS)) {
    if (!otp.isUsed) await otp.update({ isUsed: true });
    throw createError('Too many failed attempts. This code has been locked. Please request a new code.', 400);
  }

  if (otp.isUsed) {
    throw createError('This verification code has already been used. Please request a new code.', 400);
  }

  const isValid = verifyOtpHash(submittedCode, otp.code, userId);
  if (!isValid) {
    await otp.increment('attempts', { by: 1 });
    await otp.reload();
    if (otp.attempts >= (otp.maxAttempts || MAX_OTP_ATTEMPTS)) {
      await otp.update({ isUsed: true });
      throw createError('Too many failed attempts. This code has been locked. Please request a new code.', 400);
    }
    const remaining = (otp.maxAttempts || MAX_OTP_ATTEMPTS) - otp.attempts;
    throw createError(`Invalid OTP code. ${remaining} attempts remaining.`, 400);
  }

  // Mark OTP used
  await otp.update({ isUsed: true });
  return otp;
};

/**
 * Build the JWT payload for a user, resolving tenantId for GymHost accounts.
 */
const _buildTokenPayload = async (user) => {
  let tenantId = null;

  if (user.role === UserRole.GYM_HOST) {
    try {
      const tenant = await Tenant.findOne({
        where: { ownerUserId: user.id },
        attributes: ['id'],
        order: [['createdAt', 'DESC']],
      });
      tenantId = tenant ? tenant.id : null;
    } catch (err) {
      console.warn('[Auth] Error resolving tenantId for GYM_HOST:', err.message);
    }
  }

  return {
    sub: user.id,
    email: user.email,
    role: user.role,
    isVerified: user.isVerified,
    isHost: !!user.isHost,
    tenantId,
    branchId: null,
    ver: user.permissionVersion || 1,
    // AUTH-07: inside the 30-day undo window the token only reaches the undo/profile
    // routes (middleware/authenticate.js). Re-derived from the user on every refresh.
    ...(user.status === 'PENDING_DELETION' && { dp: true }),
  };
};

/**
 * Issue a JWT + opaque refresh token pair, store the hashed refresh token in the DB (AUTH-01).
 * Preserves familyId on rotation so the entire session family can be revoked on reuse.
 */
const _issueTokenPair = async (user, ipAddress, userAgent, existingFamilyId = null) => {
  const payload = await _buildTokenPayload(user);

  const accessToken = signToken(payload);
  const refreshToken = _generateOpaqueRefreshToken();
  const tokenHash = _hashToken(refreshToken);
  const familyId = existingFamilyId || uuidv4();
  const expiresAt = _getRefreshTokenExpiry();

  try {
    await RefreshToken.create({
      userId: user.id,
      familyId,
      token: tokenHash,
      expiresAt,
      isRevoked: false,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
    });
  } catch (rfErr) {
    console.warn('[Auth] Failed to store refresh token record:', rfErr.message);
  }

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
  isHost: !!user.isHost,
  profileImageUrl: user.profileImageUrl || null,
  tenantId,
  ...(user.status === 'PENDING_DELETION' && {
    deletionPending: { requestedAt: user.deletionRequestedAt, scheduledFor: user.deletionScheduledFor },
  }),
});

/**
 * Statuses a sign-in must never overwrite with ACTIVE (AUTH-07). Google/Apple
 * sign-in used to set status = ACTIVE on every login unless SUSPENDED, which
 * silently undid the old "deletion" (INACTIVE) — and would undo PENDING_DELETION.
 */
const _KEEP_STATUS_ON_SIGN_IN = ['SUSPENDED', 'PENDING_DELETION', 'DELETED'];
const _statusAfterSignIn = (status) => (_KEEP_STATUS_ON_SIGN_IN.includes(status) ? status : 'ACTIVE');
const _assertNotDeleted = (user) => {
  if (user.status === 'DELETED') throw createError('This account has been deleted.', 401);
};

// ── Public service methods ────────────────────────────────────────────────────

/**
 * Register a new user with email + password.
 * Sends an OTP to the provided email for verification.
 */
const register = async ({ fullName, email, password, phone }) => {
  await _assertIdentifierRateLimit(email);
  await _assertOtpCooldown(null, email, 'EMAIL_VERIFICATION');

  const existing = await User.findOne({ where: { email } });
  if (existing) {
    if (!existing.isVerified) {
      // Account exists but was never verified: update credentials and resend fresh OTP
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await existing.update({
        fullName: fullName || existing.fullName,
        phone: phone || existing.phone,
        passwordHash,
      });

      await _invalidatePreviousOtps(existing.id, 'EMAIL_VERIFICATION');

      const code = generateOtpCode();
      const hashCode = hashOtpCode(code, existing.id);
      const otp = await Otp.create({
        userId: existing.id,
        email,
        code: hashCode,
        attempts: 0,
        maxAttempts: 5,
        type: 'EMAIL_VERIFICATION',
        expiresAt: getOtpExpiry(),
      });

      try {
        await emailService.sendOtpEmail(email, fullName || existing.fullName, code);
      } catch (emailErr) {
        console.warn('[Auth] OTP email failed (register unverified):', emailErr.message);
      }

      const result = { userId: existing.id, email, otpExpiresAtUtc: otp.expiresAt };
      if (process.env.NODE_ENV !== 'production') result.debugCode = code;
      return result;
    }

    throw createError('An account with this email already exists', 409);
  }

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
  const hashCode = hashOtpCode(code, user.id);
  const otp = await Otp.create({
    userId: user.id,
    email,
    code: hashCode,
    attempts: 0,
    maxAttempts: 5,
    type: 'EMAIL_VERIFICATION',
    expiresAt: getOtpExpiry(),
  });

  try {
    await emailService.sendOtpEmail(email, fullName, code);
  } catch (emailErr) {
    console.warn('[Auth] OTP email failed (register):', emailErr.message);
  }

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

  await _verifyAndConsumeOtp(user.id, code, 'EMAIL_VERIFICATION');

  await user.update({ isVerified: true, status: 'ACTIVE' });

  setImmediate(() => {
    try {
      const { checkAndTriggerPendingStaffInvites } = require('./gym.service');
      checkAndTriggerPendingStaffInvites(user).catch((err) => {
        console.warn('[Staff Invite Sync] verifyOtp background check error:', err.message);
      });
    } catch (_) {}
  });

  return _issueTokenPair(user, ipAddress, userAgent);
};

/**
 * Resend a fresh OTP to the user's email for email verification.
 */
const resendOtp = async ({ email }) => {
  await _assertIdentifierRateLimit(email);

  const user = await User.findOne({ where: { email } });

  // Don't reveal if email exists — return the same message either way
  if (!user || user.isVerified) {
    return { message: 'If this email is registered and unverified, a new code has been sent.' };
  }

  await _assertOtpCooldown(user.id, email, 'EMAIL_VERIFICATION');
  await _invalidatePreviousOtps(user.id, 'EMAIL_VERIFICATION');

  const code = generateOtpCode();
  const hashCode = hashOtpCode(code, user.id);
  await Otp.create({
    userId: user.id,
    email,
    code: hashCode,
    attempts: 0,
    maxAttempts: 5,
    type: 'EMAIL_VERIFICATION',
    expiresAt: getOtpExpiry(),
  });

  try {
    await emailService.sendOtpEmail(email, user.fullName, code);
  } catch (emailErr) {
    console.warn('[Auth] OTP email failed (resend):', emailErr.message);
  }

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
    // If within cooldown, do not spam a fresh code; return existing OTP expiry
    let latestOtp = await Otp.findOne({
      where: {
        userId: user.id,
        type: 'EMAIL_VERIFICATION',
        isUsed: false,
        expiresAt: { [Op.gt]: new Date() },
      },
      order: [['createdAt', 'DESC']],
    });

    let code;
    if (!latestOtp) {
      await _assertOtpCooldown(user.id, user.email, 'EMAIL_VERIFICATION');
      await _invalidatePreviousOtps(user.id, 'EMAIL_VERIFICATION');
      code = generateOtpCode();
      const hashCode = hashOtpCode(code, user.id);
      latestOtp = await Otp.create({
        userId: user.id,
        email: user.email,
        code: hashCode,
        attempts: 0,
        maxAttempts: 5,
        type: 'EMAIL_VERIFICATION',
        expiresAt: getOtpExpiry(),
      });
      try {
        await emailService.sendOtpEmail(email, user.fullName, code);
      } catch (emailErr) {
        console.warn('[Auth] OTP email failed (login):', emailErr.message);
      }
    }

    const payload = {
      email: user.email,
      fullName: user.fullName,
      otpExpiresAtUtc: latestOtp.expiresAt,
    };
    if (code && process.env.NODE_ENV !== 'production') payload.debugCode = code;

    // Use a structured error so the controller can return success:false + data
    const err = createError('Account is not verified. A new OTP has been sent to your email.', 403);
    err.pendingOtp = payload;
    throw err;
  }

  _assertNotDeleted(user);
  if (user.status !== 'ACTIVE' && user.status !== 'PENDING_DELETION') {
    throw createError('Your account has been suspended. Please contact support.', 403);
  }

  await user.update({ lastLoginAt: new Date() });

  setImmediate(() => {
    try {
      const { checkAndTriggerPendingStaffInvites } = require('./gym.service');
      checkAndTriggerPendingStaffInvites(user).catch((err) => {
        console.warn('[Staff Invite Sync] login background check error:', err.message);
      });
    } catch (_) {}
  });

  return _issueTokenPair(user, ipAddress, userAgent);
};

/**
 * The actual Google idToken verification — shared by googleLogin (a brand
 * new or returning session) and verifyReauthCredential below (re-confirming
 * an already-signed-in account for a sensitive action, e.g. deleting a
 * branch).
 *
 * Only a token whose signature verifies against Google's certificates, for
 * one of our client IDs, from Google's issuer, not expired, with a verified
 * e-mail, is accepted. Any failure — including Google's certificates being
 * unreachable or slow — is a 401. There is no unverified fallback (NEW-03):
 * it used to `jwt.decode` the token when the verifier's error mentioned
 * "network"/"certificates"/…, text an attacker could put in the token header.
 */
const GOOGLE_VERIFY_TIMEOUT_MS = 4000;

const _verifyGoogleIdToken = async (idToken) => {
  const audiences = [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
    '852595980857-akglkibm5auiu093lkrcr3cmqgf0oo3q.apps.googleusercontent.com',
    '852595980857-s1pss39jidmqk9me80p362eabauc785o.apps.googleusercontent.com',
  ].filter(Boolean);

  if (audiences.length === 0) {
    throw createError('Google authentication is not configured', 503);
  }

  let payload;
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Google certificate fetch timed out')), GOOGLE_VERIFY_TIMEOUT_MS);
    });
    const ticket = await Promise.race([googleClient.verifyIdToken({ idToken, audience: audiences }), timeout]);
    payload = ticket.getPayload();
  } catch (err) {
    // The library's messages can echo the token; the redaction layer (SEC-07)
    // strips JWTs, and only the first line is logged.
    console.warn('[Google Auth] ID token rejected:', String(err.message || err).split('\n')[0].slice(0, 200));
    throw createError('Invalid Google ID token', 401);
  } finally {
    clearTimeout(timer);
  }

  if (!payload || !payload.sub) {
    throw createError('Invalid Google ID token', 401);
  }
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw createError('Google account email is not verified', 401);
  }

  return payload;
};

const STAFF_ROLES = [UserRole.GYM_HOST, UserRole.BRANCH_MANAGER, UserRole.PLATFORM_ADMIN];

/**
 * Login or register via Google ID Token.
 *
 * On the public surfaces (mobile app, website) this creates a new ACTIVE +
 * verified MEMBER account automatically on first login, same as always.
 *
 * `staffOnly` is for the CMS management portal specifically, which is a
 * different trust boundary: nobody should be able to provision themselves
 * an account just by owning any Gmail address and clicking a button — the
 * CMS's own AuthGuard only checks "is logged in," not role, so account
 * creation is the actual gate here, not something enforced later. With
 * `staffOnly: true`, this never creates a new account, and never lets the
 * request through unless the resolved user already holds a staff role
 * (GYM_HOST/BRANCH_MANAGER/PLATFORM_ADMIN) — an existing staff member who
 * hasn't linked Google yet still gets linked via the normal by-email match
 * below, they just can't be freshly created this way.
 */
const googleLogin = async ({ idToken }, ipAddress, userAgent, { staffOnly = false } = {}) => {
  const payload = await _verifyGoogleIdToken(idToken);
  const { sub: googleId, email, name, picture } = payload;
  console.log(`[Google Auth] Processing login for ${email} (googleId: ${googleId})${staffOnly ? ' [staff-only]' : ''}`);

  // Try to find by googleId first, then fall back to email (to link existing accounts)
  let user = null;
  try {
    user = await User.findOne({ where: { googleId } });
  } catch (findErr) {
    console.warn('[Google Auth] findOne with googleId failed, falling back to email:', findErr.message);
  }

  if (!user) {
    user = await User.findOne({ where: { email } });

    if (user) {
      // Link Google ID to existing account and activate it (email verified by Google)
      const newStatus = _statusAfterSignIn(user.status);
      const baseUpdate = {
        isVerified: true,
        status: newStatus,
      };
      if (picture && user.profileImageUrl !== picture) {
        baseUpdate.profileImageUrl = user.profileImageUrl || picture;
      }

      try {
        await user.update({
          googleId,
          ...baseUpdate,
        });
      } catch (upErr) {
        console.warn('[Google Auth] Linking with googleId failed, retrying base fields:', upErr.message);
        await user.update(baseUpdate).catch(() => null);
      }
      console.log(`[Google Auth] Linked existing account for ${email}`);
    } else if (staffOnly) {
      throw createError(
        'No GymsEra staff account is linked to this Google account. Ask an admin to invite you, or sign in with your GymsEra password instead.',
        403
      );
    } else {
      // Create brand new user
      const createFields = {
        fullName: name || email.split('@')[0],
        email,
        profileImageUrl: picture || null,
        role: UserRole.MEMBER,
        status: 'ACTIVE',
        isVerified: true,
        passwordHash: null,
      };

      try {
        user = await User.create({
          googleId,
          ...createFields,
        });
      } catch (crErr) {
        console.warn('[Google Auth] User.create with googleId failed, retrying without:', crErr.message);
        user = await User.create(createFields);
      }
      console.log(`[Google Auth] Created new user account for ${email} (id: ${user.id})`);
    }
  } else {
    // Existing Google account: ensure active & verified unless suspended / being deleted
    if (!_KEEP_STATUS_ON_SIGN_IN.includes(user.status)) {
      const updateFields = {
        isVerified: true,
        status: 'ACTIVE',
      };
      if (picture && !user.profileImageUrl) {
        updateFields.profileImageUrl = picture;
      }
      await user.update(updateFields).catch((upErr) => {
        console.warn('[Google Auth] Non-fatal user status update failed:', upErr.message);
      });
    }
    console.log(`[Google Auth] Logged in existing Google user ${email} (id: ${user.id})`);
  }

  _assertNotDeleted(user);
  if (user.status === 'SUSPENDED') {
    throw createError('Your account has been suspended. Please contact support.', 403);
  }

  if (staffOnly && !STAFF_ROLES.includes(user.role)) {
    throw createError('This account does not have management portal access.', 403);
  }

  await user.update({ lastLoginAt: new Date() }).catch(() => null);

  setImmediate(() => {
    try {
      const { checkAndTriggerPendingStaffInvites } = require('./gym.service');
      checkAndTriggerPendingStaffInvites(user).catch((err) => {
        console.warn('[Staff Invite Sync] googleLogin background check error:', err.message);
      });
    } catch (_) {}
  });

  return _issueTokenPair(user, ipAddress, userAgent);
};

// ── Apple identity token verification (NEW-02) ───────────────────────────────
// The identity token is verified against Apple's published keys (JWKS):
// RS256 signature, issuer, audience (our bundle / service IDs), expiry. The
// keys are cached for a day; an unknown `kid` (Apple rotated keys) refetches
// at most once a minute, so a stream of bogus kids cannot hammer Apple.
/* global fetch, AbortSignal */ // Node 20 built-ins (eslint config has no node globals)
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUERS = ['https://appleid.apple.com', 'appleid.apple.com'];
const APPLE_KEYS_TTL_MS = 24 * 60 * 60 * 1000;
const APPLE_UNKNOWN_KID_REFETCH_MS = 60 * 1000;
const APPLE_KEYS_FETCH_TIMEOUT_MS = 5000;

let _appleKeys = { byKid: new Map(), fetchedAt: 0, lastUnknownKidFetchAt: 0 };

const _fetchAppleKeys = async () => {
  const res = await fetch(APPLE_JWKS_URL, { signal: AbortSignal.timeout(APPLE_KEYS_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Apple JWKS responded ${res.status}`);
  const body = await res.json();
  const byKid = new Map();
  for (const k of Array.isArray(body?.keys) ? body.keys : []) {
    if (k && k.kty === 'RSA' && k.kid) byKid.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }));
  }
  if (byKid.size === 0) throw new Error('Apple JWKS contained no usable keys');
  _appleKeys = { ..._appleKeys, byKid, fetchedAt: Date.now() };
};

const _appleKeyFor = async (kid) => {
  const fresh = Date.now() - _appleKeys.fetchedAt < APPLE_KEYS_TTL_MS;
  if (fresh && _appleKeys.byKid.has(kid)) return _appleKeys.byKid.get(kid);
  if (!fresh) {
    await _fetchAppleKeys();
  } else if (Date.now() - _appleKeys.lastUnknownKidFetchAt >= APPLE_UNKNOWN_KID_REFETCH_MS) {
    _appleKeys.lastUnknownKidFetchAt = Date.now();
    await _fetchAppleKeys();
  }
  return _appleKeys.byKid.get(kid) || null;
};

/** Test hook: forget cached Apple keys. */
const _resetAppleKeyCacheForTests = () => {
  _appleKeys = { byKid: new Map(), fetchedAt: 0, lastUnknownKidFetchAt: 0 };
};

/**
 * Verifies an Apple identity token and returns its payload. Any failure —
 * bad signature, unknown key, wrong issuer/audience, expired, Apple's keys
 * unreachable — is a 401. Shared by appleLogin and verifyReauthCredential.
 */
const _verifyAppleIdentityToken = async (identityToken) => {
  const audiences = [
    'com.inovettatech.gymsera',
    process.env.APPLE_BUNDLE_ID,
    process.env.APPLE_CLIENT_ID,
  ].filter(Boolean);

  // The header is read only to choose Apple's key; nothing in it is trusted.
  const header = jwt.decode(identityToken, { complete: true })?.header;
  if (!header || header.alg !== 'RS256' || !header.kid) {
    throw createError('Invalid Apple identity token', 401);
  }

  let key;
  try {
    key = await _appleKeyFor(header.kid);
  } catch (err) {
    console.warn('[Apple Auth] Could not load Apple public keys:', err.message);
    throw createError('Invalid Apple identity token', 401);
  }
  if (!key) throw createError('Invalid Apple identity token', 401);

  let payload;
  try {
    payload = jwt.verify(identityToken, key, { algorithms: ['RS256'], issuer: APPLE_ISSUERS, audience: audiences });
  } catch (err) {
    console.warn('[Apple Auth] Identity token rejected:', err.name, err.message);
    throw createError('Invalid or expired Apple identity token', 401);
  }
  if (!payload || typeof payload !== 'object' || !payload.sub) {
    throw createError('Invalid Apple identity token', 401);
  }
  return payload;
};

/**
 * Login or register via Apple Identity Token.
 * On first login, creates a new ACTIVE + verified account automatically.
 *
 * The Apple user id and e-mail come only from the verified token (NEW-02).
 * `userIdentifier` and `email` in the body are ignored: the app sends the same
 * values Apple put in the token, and trusting the body let a caller pick whose
 * account to enter. `fullName` is display data only (Apple gives the name to
 * the app, not in the token).
 */
const appleLogin = async ({ identityToken, fullName, authorizationCode }, ipAddress, userAgent) => {
  if (!identityToken) {
    throw createError('Apple identity token is required', 400);
  }

  const payload = await _verifyAppleIdentityToken(identityToken);
  const appleId = payload.sub;
  const userEmail = (payload.email || '').toLowerCase().trim();
  if (userEmail && payload.email_verified !== true && payload.email_verified !== 'true') {
    throw createError('Apple account email is not verified', 401);
  }
  const userName = fullName || (userEmail ? userEmail.split('@')[0] : 'Apple User');

  console.log(`[Apple Auth] Processing login for ${userEmail || 'hidden email'} (appleId: ${appleId})`);

  let user = null;
  // 1. Try to find by appleId
  try {
    user = await User.findOne({ where: { appleId } });
  } catch (findErr) {
    console.warn('[Apple Auth] findOne with appleId failed, falling back to email:', findErr.message);
  }

  // 2. If not found by appleId, try finding by email
  if (!user && userEmail) {
    user = await User.findOne({ where: { email: userEmail } });
    if (user) {
      // Link appleId to existing account
      const newStatus = _statusAfterSignIn(user.status);
      await user.update({
        appleId,
        isVerified: true,
        status: newStatus,
      }).catch((upErr) => {
        console.warn('[Apple Auth] Linking with appleId failed:', upErr.message);
      });
      console.log(`[Apple Auth] Linked existing account for ${userEmail}`);
    }
  }

  // 3. If still not found, create new user
  if (!user) {
    if (!userEmail) {
      throw createError('Email is required for Apple account registration. Please grant email access.', 400);
    }
    const createFields = {
      fullName: userName,
      email: userEmail,
      role: UserRole.MEMBER,
      status: 'ACTIVE',
      isVerified: true,
      passwordHash: null,
    };

    try {
      user = await User.create({
        appleId,
        ...createFields,
      });
    } catch (crErr) {
      console.warn('[Apple Auth] User.create with appleId failed, retrying without:', crErr.message);
      user = await User.create(createFields);
    }
    console.log(`[Apple Auth] Created new user account for ${userEmail} (id: ${user.id})`);
  } else {
    // Existing Apple account: ensure active & verified unless suspended / being deleted
    if (!_KEEP_STATUS_ON_SIGN_IN.includes(user.status)) {
      await user.update({
        isVerified: true,
        status: 'ACTIVE',
      }).catch(() => null);
    }
    console.log(`[Apple Auth] Logged in existing Apple user ${user.email} (id: ${user.id})`);
  }

  _assertNotDeleted(user);
  if (user.status === 'SUSPENDED') {
    throw createError('Your account has been suspended. Please contact support.', 403);
  }

  await user.update({ lastLoginAt: new Date() }).catch(() => null);

  // AUTH-07: keep Apple's refresh token (encrypted) so deleting the account can revoke it. Never blocks sign-in.
  if (authorizationCode) {
    await require('./apple-signin-revoke.service').storeRefreshToken(user, authorizationCode).catch((err) => {
      console.warn('[Apple Auth] Could not store the Apple refresh token:', String(err.message).slice(0, 120));
    });
  }

  // Check and trigger pending staff invites
  setImmediate(() => {
    try {
      const { checkAndTriggerPendingStaffInvites } = require('./gym.service');
      checkAndTriggerPendingStaffInvites(user).catch((err) => {
        console.warn('[Staff Invite Sync] appleLogin background check error:', err.message);
      });
    } catch (inviteErr) {
      // Ignore
    }
  });

  return _issueTokenPair(user, ipAddress, userAgent);
};

/**
 * Rotate a refresh token — revoke the old one, issue a new pair in the same family.
 * If an already-revoked refresh token is presented, REUSE is detected: revoke the
 * entire session family immediately to protect against token theft (AUTH-01).
 */
const refreshTokens = async (token, ipAddress, userAgent) => {
  if (!token || typeof token !== 'string') {
    throw createError('Invalid or expired refresh token', 401);
  }

  const tokenHash = _hashToken(token);

  // Look up in DB by token hash, or fallback to raw token for legacy DB rows if any
  let stored = await RefreshToken.findOne({
    where: { token: tokenHash },
  });
  if (!stored) {
    stored = await RefreshToken.findOne({
      where: { token },
    });
  }

  if (!stored) {
    throw createError('Invalid or expired refresh token', 401);
  }

  // Reuse detection: If the token is already revoked, an attacker or compromised
  // client is attempting to reuse an old refresh token. Revoke the entire session family!
  if (stored.isRevoked) {
    console.warn(`[Auth:Security] Refresh token reuse detected! Revoking family ${stored.familyId} for user ${stored.userId}`);
    if (stored.familyId) {
      await RefreshToken.update(
        { isRevoked: true },
        { where: { familyId: stored.familyId } }
      );
    } else {
      await RefreshToken.update(
        { isRevoked: true },
        { where: { userId: stored.userId } }
      );
    }
    throw createError('Invalid or expired refresh token', 401);
  }

  // Check expiration
  if (new Date(stored.expiresAt) <= new Date()) {
    await stored.update({ isRevoked: true });
    throw createError('Invalid or expired refresh token', 401);
  }

  // Revoke the old token (rotation)
  await stored.update({ isRevoked: true });

  // Load the user
  const user = await User.findByPk(stored.userId);
  if (!user || user.status === 'SUSPENDED' || user.status === 'DELETED') {
    throw createError('User not found or account is suspended', 401);
  }

  // Issue new token pair preserving the SAME session familyId
  return _issueTokenPair(user, ipAddress, userAgent, stored.familyId);
};

/**
 * Request a password reset OTP.
 * Always returns 200 to prevent email enumeration.
 */
const passwordResetRequest = async ({ email }) => {
  await _assertIdentifierRateLimit(email);

  const user = await User.findOne({ where: { email } });

  if (!user) {
    console.log(`[Auth] Password reset requested for non-existent email: ${email}`);
    return { message: 'If this email is registered, a password reset code has been sent.' };
  }

  if (user.status === 'SUSPENDED') {
    return { message: 'If this email is registered, a password reset code has been sent.' };
  }

  await _assertOtpCooldown(user.id, email, 'PASSWORD_RESET');

  // Invalidate any existing unused RESET OTPs
  await _invalidatePreviousOtps(user.id, 'PASSWORD_RESET');

  const code = generateOtpCode();
  const hashCode = hashOtpCode(code, user.id);
  const expiresAt = getOtpExpiry(10); // 10 minutes

  await Otp.create({
    userId: user.id,
    email,
    code: hashCode,
    attempts: 0,
    maxAttempts: 5,
    type: 'PASSWORD_RESET',
    expiresAt,
  });

  // Fire-and-forget email
  emailService.sendPasswordResetEmail(user.email, user.fullName, code).catch((err) => {
    console.error(`[Auth] Failed to send password reset email to ${email}:`, err.message);
  });

  return { message: 'If this email is registered, a password reset code has been sent.' };
};

/**
 * Confirm password reset using OTP + new password.
 */
const passwordResetConfirm = async ({ email, code, password }) => {
  const user = await User.findOne({ where: { email } });
  if (!user) {
    throw createError('Invalid or expired password reset code', 400);
  }

  await _verifyAndConsumeOtp(user.id, code, 'PASSWORD_RESET');

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await user.update({ passwordHash, isVerified: true });

  // Invalidate all existing refresh tokens for security
  await RefreshToken.update({ isRevoked: true }, { where: { userId: user.id } });

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
      'googleId', 'appleId', 'lastLoginAt', 'createdAt', 'isHost',
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

  let provider = 'LOCAL';
  if (user.googleId) provider = 'GOOGLE';
  else if (user.appleId) provider = 'APPLE';

  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone || null,
    role: user.role,
    isVerified: user.isVerified,
    status: user.status,
    isHost: !!user.isHost,
    profileImageUrl: user.profileImageUrl || null,
    provider,
    tenantId,
    lastLoginAt: user.lastLoginAt || null,
    memberSince: user.createdAt,
  };
};

/**
 * Re-confirms an already-signed-in user's identity for a sensitive in-app
 * action (currently: deleting a branch) using whichever provider they
 * actually authenticate with — the password-confirmation dialog only ever
 * worked for LOCAL accounts, since a GOOGLE/APPLE-only user has no
 * passwordHash to check (see gyms.controller.js#deleteBranch, which
 * silently skips the password check entirely when one was never set,
 * rather than actually confirming anything for that user).
 *
 * This is deliberately NOT googleLogin/appleLogin — it never touches
 * RefreshToken, never issues a new session, and never creates or links an
 * account. It only asks "does this fresh idToken belong to the SAME
 * provider identity already on this user's own User row" — proving they
 * could re-authenticate as themselves just now, the same guarantee a
 * correct password gives for a LOCAL account.
 *
 * @param {string} userId
 * @param {{ provider: 'GOOGLE'|'APPLE', idToken: string }} credential
 */
const verifyReauthCredential = async (userId, { provider, idToken }) => {
  if (!idToken) throw createError('A fresh sign-in is required to confirm this action', 400);

  const user = await User.findByPk(userId);
  if (!user) throw createError('User not found', 404);

  if (provider === 'GOOGLE') {
    if (!user.googleId) throw createError('This account is not linked to a Google sign-in', 400);
    const payload = await _verifyGoogleIdToken(idToken);
    if (payload.sub !== user.googleId) {
      throw createError('That Google account does not match your GymsEra account', 401);
    }
    return true;
  }

  if (provider === 'APPLE') {
    if (!user.appleId) throw createError('This account is not linked to an Apple sign-in', 400);
    const decoded = await _verifyAppleIdentityToken(idToken);
    if (decoded.sub !== user.appleId) {
      throw createError('That Apple account does not match your GymsEra account', 401);
    }
    return true;
  }

  throw createError(`Unsupported re-authentication provider "${provider}"`, 400);
};

/**
 * Re-authentication for a sensitive action (AUTH-07 account deletion): the
 * current password, OR a fresh Google/Apple token for the SAME provider identity
 * (verifyReauthCredential above, the SEC-13 pattern).
 *
 * A password is only ever compared against the user's own hash: an account with
 * no password (social-only) cannot pass with some password string.
 */
const assertReauth = async (userId, { password, provider, idToken } = {}) => {
  if (!password && !(provider && idToken)) {
    const err = createError('Re-authentication required: confirm with your password or sign in again', 401);
    err.code = 'reauth_required';
    throw err;
  }
  if (provider && idToken) {
    return module.exports.verifyReauthCredential(userId, { provider, idToken });
  }
  const user = await User.findByPk(userId);
  if (!user) throw createError('User not found', 404);
  const ok = Boolean(user.passwordHash) && (await bcrypt.compare(String(password), user.passwordHash));
  if (!ok) {
    const err = createError('Incorrect password', 401);
    err.code = 'invalid_credentials';
    throw err;
  }
  return true;
};

/**
 * Verify a tenant invitation token (AUTH-09).
 */
const verifyTenantInvitation = async (rawToken) => {
  if (!rawToken || typeof rawToken !== 'string') {
    throw createError('Invitation token is required', 400);
  }
  const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');

  const invitation = await TenantInvitation.findOne({
    where: {
      tokenHash,
      status: 'PENDING',
      expiresAt: { [Op.gt]: new Date() },
    },
  });

  if (!invitation) {
    throw createError('Invalid or expired invitation link', 400);
  }

  return {
    valid: true,
    invitation: {
      id: invitation.id,
      ownerEmail: invitation.ownerEmail,
      ownerFullName: invitation.ownerFullName,
      businessName: invitation.businessName,
      email: invitation.email,
      phone: invitation.phone,
      expiresAt: invitation.expiresAt,
    },
  };
};

/**
 * Accept a tenant invitation and create/link the tenant (AUTH-09).
 * Recipient proves ownership of email by providing password / authenticated session.
 */
const acceptTenantInvitation = async ({ token, password, fullName, phone }, authenticatedUser = null, ipAddress = null, userAgent = null) => {
  if (!token || typeof token !== 'string') {
    throw createError('Invitation token is required', 400);
  }
  const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');

  const invitation = await TenantInvitation.findOne({
    where: {
      tokenHash,
      status: 'PENDING',
      expiresAt: { [Op.gt]: new Date() },
    },
  });

  if (!invitation) {
    throw createError('Invalid or expired invitation link', 400);
  }

  let user = await User.findOne({ where: { email: invitation.ownerEmail } });

  if (user) {
    // Existing user: caller must prove ownership via active session or valid password
    const isSessionMatch = authenticatedUser && (authenticatedUser.id === user.id || authenticatedUser.sub === user.id);
    if (!isSessionMatch) {
      if (!password) {
        throw createError('Password is required to confirm ownership of your existing account', 401);
      }
      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) {
        throw createError('Invalid password for existing account', 401);
      }
    }

    // Check if user already owns a tenant
    const existingTenant = await Tenant.findOne({ where: { ownerUserId: user.id } });
    if (existingTenant) {
      throw createError('This user already owns a gym business', 409);
    }

    // Consent given & ownership proved: upgrade to GYM_HOST
    await user.update({
      role: UserRole.GYM_HOST,
      isVerified: true,
      status: 'ACTIVE',
      fullName: fullName || user.fullName,
      phone: phone || user.phone,
    });
  } else {
    // New user: must provide password to set up their account
    if (!password || password.length < 8) {
      throw createError('Password must be at least 8 characters long', 400);
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    user = await User.create({
      fullName: fullName || invitation.ownerFullName,
      email: invitation.ownerEmail,
      phone: phone || invitation.ownerPhone || null,
      passwordHash,
      role: UserRole.GYM_HOST,
      isVerified: true,
      status: 'ACTIVE',
    });
  }

  // Create the Tenant
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  const tenantCode = `GYM-${suffix}`;

  const tenant = await Tenant.create({
    tenantCode,
    businessName: invitation.businessName,
    email: invitation.email,
    phone: invitation.phone || null,
    cityId: invitation.cityId || null,
    ownerUserId: user.id,
    selectedPackageId: invitation.packageId || null,
    status: TenantStatus.PENDING_REVIEW,
    kycStatus: KycStatus.NOT_SUBMITTED,
    onboardingStep: 1,
  });

  // Mark invitation ACCEPTED
  await invitation.update({
    status: 'ACCEPTED',
    acceptedAt: new Date(),
    tenantId: tenant.id,
  });

  // Audit the acceptance
  try {
    await PlatformAuditLog.create({
      actorUserId: user.id,
      action: 'tenant_invitation.accepted',
      targetType: 'tenant',
      targetId: tenant.id,
      details: {
        ownerEmail: invitation.ownerEmail,
        tenantCode: tenant.tenantCode,
        businessName: tenant.businessName,
        invitationId: invitation.id,
      },
      createdAt: new Date(),
    });
  } catch (auditErr) {
    console.warn('[Audit] Failed to record tenant invitation accepted:', auditErr.message);
  }

  const tokenPair = await _issueTokenPair(user, ipAddress, userAgent);

  return {
    tenant,
    user: tokenPair.user,
    accessToken: tokenPair.accessToken,
    refreshToken: tokenPair.refreshToken,
  };
};

/**
 * Revoke a refresh token and its session family (AUTH-02).
 */
const revokeRefreshToken = async (refreshToken) => {
  if (!refreshToken || typeof refreshToken !== 'string') return;
  const tokenHash = _hashToken(refreshToken);
  let stored = await RefreshToken.findOne({ where: { token: tokenHash } });
  if (!stored) stored = await RefreshToken.findOne({ where: { token: refreshToken } });
  if (stored) {
    if (stored.familyId) {
      await RefreshToken.update({ isRevoked: true }, { where: { familyId: stored.familyId } });
    } else {
      await stored.update({ isRevoked: true });
    }
  }
};

/**
 * List active sessions for a user (AUTH-02).
 */
const getUserSessions = async (userId) => {
  const tokens = await RefreshToken.findAll({
    where: {
      userId,
      isRevoked: false,
      expiresAt: { [Op.gt]: new Date() },
    },
    order: [['updatedAt', 'DESC']],
  });

  const sessionMap = new Map();
  for (const token of tokens) {
    const famId = token.familyId || token.id;
    if (!sessionMap.has(famId)) {
      sessionMap.set(famId, {
        id: famId,
        ipAddress: token.ipAddress || null,
        userAgent: token.userAgent || null,
        createdAt: token.createdAt,
        lastActiveAt: token.updatedAt,
      });
    }
  }

  return Array.from(sessionMap.values());
};

/**
 * Revoke a specific session by familyId (AUTH-02).
 */
const revokeSession = async (userId, familyId) => {
  await RefreshToken.update(
    { isRevoked: true },
    { where: { userId, [Op.or]: [{ familyId }, { id: familyId }] } }
  );
  const accessService = require('./access.service');
  await accessService.bumpUserPermissionVersion(userId);
};

/**
 * Revoke all sessions for a user (AUTH-02).
 */
const revokeAllSessions = async (userId) => {
  await RefreshToken.update(
    { isRevoked: true },
    { where: { userId } }
  );
  const accessService = require('./access.service');
  await accessService.bumpUserPermissionVersion(userId);
};

module.exports = {
  register,
  verifyOtp,
  resendOtp,
  login,
  googleLogin,
  appleLogin,
  refreshTokens,
  revokeRefreshToken,
  getUserSessions,
  revokeSession,
  revokeAllSessions,
  passwordResetRequest,
  passwordResetConfirm,
  getMe,
  verifyReauthCredential,
  assertReauth,
  verifyTenantInvitation,
  acceptTenantInvitation,
  _resetAppleKeyCacheForTests,
};
