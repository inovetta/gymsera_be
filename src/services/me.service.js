const bcrypt = require('bcrypt');
const { Op } = require('sequelize');

const { User, UserGymMembership, Tenant } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError } = require('../utils/response.utils');

const _resolveBySubscriptionId = async (subscriptionId, userId) => {
  let index = await UserGymMembership.findOne({ where: { subscriptionId, userId } });

  if (!index) {
    index = await UserGymMembership.findOne({ where: { id: subscriptionId, userId } });
  }

  if (!index) throw createError('Subscription not found', 404);

  const resolvedSubscriptionId = index.subscriptionId || subscriptionId;

  const tenant = await Tenant.findOne({ where: { id: index.tenantId, status: 'ACTIVE' }, attributes: ['id', 'connectionStringEncrypted'] });
  if (!tenant) throw createError('Gym tenant is not available', 503);
  const { models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  return { models, index, resolvedSubscriptionId };
};

/**
 * Load all tenant DBs the user has memberships in.
 * Returns an array of { tenantId, models } — empty array if no memberships.
 */
const _getAllTenantDbs = async (userId) => {
  const rows = await UserGymMembership.findAll({
    where: { userId },
    attributes: ['tenantId'],
    group: ['tenantId'],
  });
  const results = await Promise.all(
    rows.map(async ({ tenantId }) => {
      try {
        const tenant = await Tenant.findOne({ where: { id: tenantId, status: 'ACTIVE' }, attributes: ['id', 'connectionStringEncrypted'] });
        if (!tenant) return null;
        const { models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        return { tenantId, models };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
};

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
 * Get own account statement — subscriptions + payments across ALL the member's gyms.
 * Uses cross-tenant lookup via UserGymMembership — no tenantDb arg needed.
 */
const getMyAccountStatement = async (userId, { page, limit, offset, from, to }) => {
  const tenantDbs = await _getAllTenantDbs(userId);
  if (tenantDbs.length === 0) return { subscriptions: [], payments: [] };

  const dateWhere = {};
  if (from) dateWhere[Op.gte] = new Date(from);
  if (to) dateWhere[Op.lte] = new Date(to);

  const perTenant = await Promise.all(
    tenantDbs.map(async ({ models }) => {
      const { MemberSubscription, Payment, MembershipPlan, Branch } = models;
      const [subscriptions, payments] = await Promise.all([
        MemberSubscription.findAll({
          where: { userId, ...(Object.keys(dateWhere).length ? { startDate: dateWhere } : {}) },
          include: [
            { model: MembershipPlan, as: 'plan', attributes: ['id', 'name', 'price', 'durationType', 'durationValue'] },
            { model: Branch, as: 'branch', attributes: ['id', 'branchName'] },
          ],
          order: [['subscribedAt', 'DESC']],
        }),
        Payment.findAll({
          where: { userId, ...(Object.keys(dateWhere).length ? { paidAt: dateWhere } : {}) },
          order: [['createdAt', 'DESC']],
        }),
      ]);
      return { subscriptions, payments };
    })
  );

  const subscriptions = perTenant.flatMap((r) => r.subscriptions)
    .sort((a, b) => new Date(b.subscribedAt || b.createdAt) - new Date(a.subscribedAt || a.createdAt))
    .slice(offset, offset + limit);

  const payments = perTenant.flatMap((r) => r.payments)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(offset, offset + limit);

  return { subscriptions, payments };
};

/**
 * Get own payments (all statuses) across ALL the member's gyms.
 */
const getMyPaymentRequests = async (userId, { page, limit, offset }) => {
  const tenantDbs = await _getAllTenantDbs(userId);
  if (tenantDbs.length === 0) return { payments: [], total: 0 };

  const perTenant = await Promise.all(
    tenantDbs.map(({ models }) =>
      models.Payment.findAll({ where: { userId }, order: [['createdAt', 'DESC']] })
    )
  );

  const all = perTenant.flat().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const payments = all.slice(offset, offset + limit);

  return { payments, total: all.length };
};

/**
 * Member submits a payment request.
 * Resolves tenant via subscriptionId — no tenantDb arg needed.
 */
const submitPaymentRequest = async (userId, { subscriptionId, method, amount, notes }) => {
  const { models, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
  const { Payment, MemberSubscription } = models;

  const subscription = await MemberSubscription.findOne({ where: { id: resolvedSubscriptionId, userId } });
  if (!subscription) throw createError('Subscription not found or does not belong to you', 404);

  const payment = await Payment.create({
    userId,
    paymentFor: 'MEMBERSHIP',
    referenceEntityId: resolvedSubscriptionId,
    method,
    amount,
    currency: 'PKR',
    status: 'PENDING',
    notes: notes || null,
  });

  return payment;
};

/**
 * Upload bank receipt / proof image for a payment.
 * Searches across all user's tenant DBs to find the payment by ID.
 */
const uploadPaymentProof = async (userId, paymentId, proofUrl) => {
  const tenantDbs = await _getAllTenantDbs(userId);
  if (tenantDbs.length === 0) throw createError('Payment not found or does not belong to you', 404);

  for (const { models } of tenantDbs) {
    const payment = await models.Payment.findOne({ where: { id: paymentId, userId } });
    if (payment) {
      if (payment.status !== 'PENDING') {
        throw createError('Proof can only be uploaded for pending payments', 400);
      }
      await payment.update({ proofUrl });
      return { proofUrl };
    }
  }

  throw createError('Payment not found or does not belong to you', 404);
};

const _mapAttendanceLogs = (logs) => logs.map((log) => ({
  id: log.id,
  checkInTime: log.checkInAt,
  checkOutTime: log.checkOutAt || null,
  branch: log.branch ? { branchName: log.branch.branchName } : null,
}));

/**
 * Get member's attendance logs. When subscriptionId is provided, scoped to that
 * subscription. When omitted, returns recent logs across all the member's gyms.
 */
const getMyAttendance = async (userId, subscriptionId) => {
  if (subscriptionId) {
    const { models, resolvedSubscriptionId } = await _resolveBySubscriptionId(subscriptionId, userId);
    const { AttendanceLog, Branch } = models;
    const logs = await AttendanceLog.findAll({
      where: { userId, memberSubscriptionId: resolvedSubscriptionId },
      include: [{ model: Branch, as: 'branch', attributes: ['id', 'branchName'] }],
      order: [['checkInAt', 'DESC']],
      limit: 100,
    });
    return _mapAttendanceLogs(logs);
  }

  // No subscriptionId — aggregate across all gyms the member belongs to
  const tenantDbs = await _getAllTenantDbs(userId);
  const nested = await Promise.all(
    tenantDbs.map(async ({ models }) => {
      try {
        const { AttendanceLog, Branch } = models;
        const logs = await AttendanceLog.findAll({
          where: { userId },
          include: [{ model: Branch, as: 'branch', attributes: ['id', 'branchName'] }],
          order: [['checkInAt', 'DESC']],
          limit: 50,
        });
        return _mapAttendanceLogs(logs);
      } catch {
        return [];
      }
    })
  );

  return nested
    .flat()
    .sort((a, b) => new Date(b.checkInTime) - new Date(a.checkInTime))
    .slice(0, 100);
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
  getMyAttendance,
};
