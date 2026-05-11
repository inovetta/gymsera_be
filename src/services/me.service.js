const bcrypt = require('bcrypt');
const { Op } = require('sequelize');

const { User } = require('../models/platform');
const { createError } = require('../utils/response.utils');

const BCRYPT_ROUNDS = 12;

/**
 * Get own full profile — DB lookup, richer than JWT claims.
 */
const getMyProfile = async (userId, tenantDb = null) => {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'fullName', 'email', 'phone', 'role', 'isVerified', 'status', 'profileImageUrl', 'googleId', 'createdAt', 'lastLoginAt'],
  });
  if (!user) throw createError('User not found', 404);

  let profile = null;
  if (tenantDb) {
    const { MemberProfile } = tenantDb.models;
    profile = await MemberProfile.findOne({ where: { userId } });
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
    lastLoginAt: user.lastLoginAt || null,
    memberSince: user.createdAt,
    profile: profile
      ? {
          dateOfBirth: profile.dateOfBirth || null,
          gender: profile.gender || null,
          heightCm: profile.heightCm || null,
          weightKg: profile.weightKg || null,
          fitnessGoal: profile.fitnessGoal || null,
          medicalNotes: profile.medicalNotes || null,
          emergencyContactName: profile.emergencyContactName || null,
          emergencyContactPhone: profile.emergencyContactPhone || null,
        }
      : null,
  };
};

/**
 * Update own profile — name, phone + tenant-side extended fields.
 */
const updateMyProfile = async (userId, updates, tenantDb = null) => {
  const user = await User.findByPk(userId);
  if (!user) throw createError('User not found', 404);

  const { fullName, phone, gender, dateOfBirth, heightCm, weightKg, fitnessGoal } = updates;

  const platformUpdates = {};
  if (fullName !== undefined) platformUpdates.fullName = fullName;
  if (phone !== undefined) platformUpdates.phone = phone;
  if (Object.keys(platformUpdates).length) await user.update(platformUpdates);

  if (tenantDb) {
    const profileFields = {};
    if (gender !== undefined) profileFields.gender = gender;
    if (dateOfBirth !== undefined) profileFields.dateOfBirth = dateOfBirth;
    if (heightCm !== undefined) profileFields.heightCm = heightCm;
    if (weightKg !== undefined) profileFields.weightKg = weightKg;
    if (fitnessGoal !== undefined) profileFields.fitnessGoal = fitnessGoal;

    if (Object.keys(profileFields).length) {
      const { MemberProfile } = tenantDb.models;
      await MemberProfile.upsert({ userId, ...profileFields });
    }
  }

  return getMyProfile(userId, tenantDb);
};

/**
 * Change own password — verify current password first.
 */
const changePassword = async (userId, currentPassword, newPassword) => {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'passwordHash', 'googleId'],
  });
  if (!user) throw createError('User not found', 404);

  // Social-only accounts have no password — guide user appropriately
  if (!user.passwordHash) {
    throw createError('Your account uses social login. Please use the password reset flow to set a password.', 400);
  }

  const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isMatch) throw createError('Current password is incorrect', 401);

  if (currentPassword === newPassword) {
    throw createError('New password must differ from the current password', 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await user.update({ passwordHash });

  return { message: 'Password changed successfully.' };
};

/**
 * Update own profile image URL.
 */
const updateProfileImage = async (userId, imageUrl) => {
  const user = await User.findByPk(userId);
  if (!user) throw createError('User not found', 404);
  await user.update({ profileImageUrl: imageUrl });
  return { profileImageUrl: imageUrl };
};

/**
 * Get own account statement — subscriptions + payments across the tenant.
 */
const getMyAccountStatement = async (userId, tenantDb, { page, limit, offset, from, to }) => {
  if (!tenantDb) throw createError('Tenant context required', 400);

  const { MemberSubscription, Payment, MembershipPlan, Branch } = tenantDb.models;

  const dateWhere = {};
  if (from) dateWhere[Op.gte] = new Date(from);
  if (to) dateWhere[Op.lte] = new Date(to);

  const [subscriptions, payments] = await Promise.all([
    MemberSubscription.findAll({
      where: { userId, ...(Object.keys(dateWhere).length ? { startDate: dateWhere } : {}) },
      include: [
        { model: MembershipPlan, as: 'plan', attributes: ['id', 'name', 'price', 'durationDays'] },
        { model: Branch, as: 'branch', attributes: ['id', 'branchName'] },
      ],
      order: [['subscribedAt', 'DESC']],
      limit,
      offset,
    }),
    Payment.findAll({
      where: { userId, ...(Object.keys(dateWhere).length ? { paidAt: dateWhere } : {}) },
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    }),
  ]);

  return { subscriptions, payments };
};

/**
 * Get own payment requests from the tenant DB.
 */
const getMyPaymentRequests = async (userId, tenantDb, { page, limit, offset }) => {
  if (!tenantDb) throw createError('Tenant context required', 400);
  const { Payment } = tenantDb.models;

  const { count, rows } = await Payment.findAndCountAll({
    where: { userId, status: 'PENDING' },
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return { payments: rows, total: count };
};

/**
 * Member submits a payment request (manual/bank transfer payment intent).
 */
const submitPaymentRequest = async (userId, tenantDb, { subscriptionId, method, amount, notes }) => {
  if (!tenantDb) throw createError('Tenant context required', 400);
  const { Payment, MemberSubscription } = tenantDb.models;

  // Validate subscription belongs to this user
  const subscription = await MemberSubscription.findOne({
    where: { id: subscriptionId, userId },
  });
  if (!subscription) throw createError('Subscription not found or does not belong to you', 404);

  const payment = await Payment.create({
    userId,
    paymentFor: 'MEMBERSHIP',
    referenceEntityId: subscriptionId,
    method,
    amount,
    currency: 'PKR',
    status: 'PENDING',
    notes: notes || null,
  });

  return payment;
};

/**
 * Upload bank receipt / proof image for a payment request.
 */
const uploadPaymentProof = async (userId, tenantDb, paymentId, proofUrl) => {
  if (!tenantDb) throw createError('Tenant context required', 400);
  const { Payment } = tenantDb.models;

  const payment = await Payment.findOne({ where: { id: paymentId, userId } });
  if (!payment) throw createError('Payment not found or does not belong to you', 404);

  if (payment.status !== 'PENDING') {
    throw createError('Proof can only be uploaded for pending payments', 400);
  }

  await payment.update({ proofUrl });
  return { proofUrl };
};

module.exports = {
  getMyProfile,
  updateMyProfile,
  changePassword,
  updateProfileImage,
  getMyAccountStatement,
  getMyPaymentRequests,
  submitPaymentRequest,
  uploadPaymentProof,
};
