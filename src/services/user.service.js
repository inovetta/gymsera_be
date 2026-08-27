const bcrypt = require('bcrypt');
const { Op } = require('sequelize');

const { User, RefreshToken } = require('../models/platform');
const { createError, buildPagination } = require('../utils/response.utils');
const { generateOtpCode } = require('../utils/otp.utils');
const { UserRole } = require('../constants/roles');

const BCRYPT_ROUNDS = 12;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return the MemberProfile for a user from a tenant DB.
 * Gracefully returns null if the tenant DB is not available (user not yet enrolled).
 */
const _getMemberProfile = async (tenantDb, userId) => {
  if (!tenantDb) return null;
  try {
    const { MemberProfile } = tenantDb.models;
    return MemberProfile.findOne({ where: { userId } });
  } catch {
    return null;
  }
};

/**
 * Upsert a MemberProfile in the tenant DB.
 */
const _upsertMemberProfile = async (tenantDb, userId, profileFields) => {
  if (!tenantDb) return null;
  const { MemberProfile } = tenantDb.models;
  const [profile] = await MemberProfile.findOrCreate({
    where: { userId },
    defaults: { userId, ...profileFields },
  });
  if (profile.id) {
    await profile.update(profileFields);
  }
  return profile;
};

// ── Public service methods ────────────────────────────────────────────────────

/**
 * Paginated member search — platform DB.
 * Returns platform-level user records (no tenant DB needed for listing).
 */
const searchUsers = async ({ q, role, status, page, limit, offset }) => {
  const where = {};

  if (q) {
    where[Op.or] = [
      { fullName: { [Op.like]: `%${q}%` } },
      { email: { [Op.like]: `%${q}%` } },
      { phone: { [Op.like]: `%${q}%` } },
    ];
  }

  if (role) where.role = role;
  if (status) where.status = status;

  const { count, rows } = await User.findAndCountAll({
    where,
    attributes: ['id', 'fullName', 'email', 'phone', 'role', 'status', 'isVerified', 'profileImageUrl', 'isManual', 'createdAt', 'lastLoginAt'],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  const usersWithManual = rows.map((u) => {
    const json = u.toJSON();
    return {
      ...json,
      isManual: json.isManual === true || (json.googleId == null && !json.passwordHash),
    };
  });

  return {
    users: usersWithManual,
    pagination: buildPagination(count, page, limit),
  };
};

/**
 * Get full user detail — platform + optional tenant profile.
 */
const getUserById = async (userId, tenantDb = null) => {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'fullName', 'email', 'phone', 'role', 'status', 'isVerified', 'profileImageUrl', 'googleId', 'passwordHash', 'isManual', 'createdAt', 'lastLoginAt'],
  });
  if (!user) throw createError('User not found', 404);

  const memberProfile = await _getMemberProfile(tenantDb, userId);
  const isManual = user.isManual === true || (user.passwordHash == null && !user.googleId);

  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone || null,
    role: user.role,
    status: user.status,
    isVerified: user.isVerified,
    profileImageUrl: user.profileImageUrl || null,
    provider: user.googleId ? 'GOOGLE' : 'LOCAL',
    isManual: isManual,
    lastLoginAt: user.lastLoginAt || null,
    memberSince: user.createdAt,
    profile: memberProfile
      ? {
        dateOfBirth: memberProfile.dateOfBirth || null,
        gender: memberProfile.gender || null,
        heightCm: memberProfile.heightCm || null,
        weightKg: memberProfile.weightKg || null,
        fitnessGoal: memberProfile.fitnessGoal || null,
        medicalNotes: memberProfile.medicalNotes || null,
        emergencyContactName: memberProfile.emergencyContactName || null,
        emergencyContactPhone: memberProfile.emergencyContactPhone || null,
      }
      : null,
  };
};

/**
 * Staff creates a member account — pre-activated, no OTP required.
 * Optionally creates the tenant-side MemberProfile if tenantDb is provided.
 */
const createMember = async (
  { fullName, email, phone, password, gender, dateOfBirth },
  tenantDb = null
) => {
  const existing = await User.findOne({ where: { email } });
  if (existing) throw createError('An account with this email already exists', 409);

  const rawPassword = password || generateOtpCode(10); // auto-generate if not provided
  const passwordHash = await bcrypt.hash(rawPassword, BCRYPT_ROUNDS);

  const user = await User.create({
    fullName,
    email,
    phone: phone || null,
    passwordHash,
    role: UserRole.MEMBER,
    status: 'ACTIVE',
    isVerified: true, // staff-created accounts bypass OTP
    isManual: true,
  });

  // Create tenant profile if we have a tenant DB connection
  if (tenantDb && (gender || dateOfBirth)) {
    await _upsertMemberProfile(tenantDb, user.id, {
      gender: gender || null,
      dateOfBirth: dateOfBirth || null,
    });
  }

  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone || null,
    role: user.role,
    status: user.status,
    isVerified: user.isVerified,
    isManual: true,
    // Return temp password in non-production so staff can share it — omit in prod
    ...(process.env.NODE_ENV !== 'production' && { tempPassword: rawPassword }),
  };
};

/**
 * Update user info — both platform record and tenant profile.
 */
const updateUser = async (
  userId,
  {
    fullName, email, phone,
    gender, dateOfBirth, heightCm, weightKg,
    fitnessGoal, medicalNotes,
    emergencyContactName, emergencyContactPhone,
  },
  tenantDb = null,
  currentUser = null
) => {
  const user = await User.findByPk(userId);
  if (!user) throw createError('User not found', 404);

  const isManual = user.isManual === true || (user.passwordHash == null && !user.googleId);

  // If performed by a GYM_HOST or BRANCH_MANAGER, check if user was manually added
  if (currentUser && [UserRole.GYM_HOST, UserRole.BRANCH_MANAGER].includes(currentUser.role)) {
    if (!isManual) {
      throw createError('Only manually added members can be edited by gym staff. Registered users manage their own profile.', 403);
    }
  }

  // Update platform-level fields
  const platformUpdates = {};
  if (fullName !== undefined && fullName !== null) platformUpdates.fullName = fullName.trim();
  if (phone !== undefined) platformUpdates.phone = phone ? phone.trim() : null;

  if (email !== undefined && email !== null) {
    const normalizedEmail = email.toLowerCase().trim();
    if (normalizedEmail !== user.email.toLowerCase().trim()) {
      const existing = await User.findOne({
        where: {
          email: normalizedEmail,
          id: { [Op.ne]: userId },
        },
      });
      if (existing) {
        throw createError('An account with this email already exists', 409);
      }
      platformUpdates.email = normalizedEmail;
    }
  }

  if (Object.keys(platformUpdates).length) await user.update(platformUpdates);

  // Update tenant profile fields if provided
  const profileFields = {};
  if (gender !== undefined) profileFields.gender = gender;
  if (dateOfBirth !== undefined) profileFields.dateOfBirth = dateOfBirth;
  if (heightCm !== undefined) profileFields.heightCm = heightCm;
  if (weightKg !== undefined) profileFields.weightKg = weightKg;
  if (fitnessGoal !== undefined) profileFields.fitnessGoal = fitnessGoal;
  if (medicalNotes !== undefined) profileFields.medicalNotes = medicalNotes;
  if (emergencyContactName !== undefined) profileFields.emergencyContactName = emergencyContactName;
  if (emergencyContactPhone !== undefined) profileFields.emergencyContactPhone = emergencyContactPhone;

  if (Object.keys(profileFields).length && tenantDb) {
    await _upsertMemberProfile(tenantDb, userId, profileFields);
  }

  return getUserById(userId, tenantDb);
};

/**
 * Activate / freeze / suspend a user account.
 */
const setStatus = async (userId, status) => {
  const user = await User.findByPk(userId, { attributes: ['id', 'status', 'role'] });
  if (!user) throw createError('User not found', 404);

  // Protect platform admins from accidental deactivation
  if (user.role === UserRole.PLATFORM_ADMIN) {
    throw createError('Platform admin accounts cannot be modified via this endpoint', 403);
  }

  await user.update({ status });

  // If suspending, revoke all active sessions for immediate effect
  if (status === 'SUSPENDED' || status === 'INACTIVE') {
    await RefreshToken.update({ isRevoked: true }, { where: { userId, isRevoked: false } });
  }

  return { id: userId, status };
};

/**
 * Admin force-reset a user's password (GYM_HOST only).
 * Revokes all existing sessions to force re-login.
 */
const adminResetPassword = async (userId, newPassword) => {
  const user = await User.findByPk(userId, { attributes: ['id', 'role'] });
  if (!user) throw createError('User not found', 404);

  if (user.role === UserRole.PLATFORM_ADMIN) {
    throw createError('Cannot reset platform admin password via this endpoint', 403);
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await user.update({ passwordHash });

  // Revoke all sessions — user must log in fresh
  await RefreshToken.update({ isRevoked: true }, { where: { userId, isRevoked: false } });

  return { message: 'Password updated. All existing sessions have been revoked.' };
};

/**
 * Update profile image URL (after upload to storage).
 */
const updateProfileImage = async (userId, imageUrl) => {
  const user = await User.findByPk(userId);
  if (!user) throw createError('User not found', 404);
  await user.update({ profileImageUrl: imageUrl });
  return { profileImageUrl: imageUrl };
};

/**
 * Account statement — subscriptions + payments for a user in a tenant DB.
 */
const getAccountStatement = async (userId, tenantDb, { page, limit, offset, from, to }) => {
  if (!tenantDb) throw createError('Tenant context required for account statement', 400);

  const { MemberSubscription, Payment, MembershipPlan, Branch } = tenantDb.models;

  const dateFilter = {};
  if (from) dateFilter[Op.gte] = new Date(from);
  if (to) dateFilter[Op.lte] = new Date(to);

  const [subscriptions, payments] = await Promise.all([
    MemberSubscription.findAll({
      where: {
        userId,
        ...(from || to ? { startDate: dateFilter } : {}),
      },
      include: [
        { model: MembershipPlan, as: 'plan', attributes: ['id', 'name', 'price', 'durationType', 'durationValue'] },
        { model: Branch, as: 'branch', attributes: ['id', 'branchName'] },
      ],
      order: [['subscribedAt', 'DESC']],
      limit,
      offset,
    }),
    Payment.findAll({
      where: {
        userId,
        ...(from || to ? { paidAt: dateFilter } : {}),
      },
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    }),
  ]);

  return { subscriptions, payments };
};

module.exports = {
  searchUsers,
  getUserById,
  createMember,
  updateUser,
  setStatus,
  adminResetPassword,
  updateProfileImage,
  getAccountStatement,
};
