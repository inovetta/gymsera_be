'use strict';

/**
 * GLB-09 (spec §14 R-44): a person's own data, as one JSON document (right of access).
 *
 * It follows the same map of "where personal data lives" as the AUTH-07 deletion sweep
 * (account-deletion-finalize.service.js): whatever that sweep erases or anonymizes must be here.
 * Rules:
 *   - Only rows that belong to THIS user (single-table queries by user id, like the sweep).
 *   - Never secrets: password hash, session and push tokens, QR codes, invite and idempotency keys,
 *     database connection strings.
 *   - A gym whose database cannot be read is listed under `unavailable` and `complete` is false.
 *     The file never claims to be complete when it is not.
 */
const { Op } = require('sequelize');
const {
  User,
  Tenant,
  UserGymMembership,
  UserOrgIndex,
  DeviceToken,
  SavedGym,
  Notification,
  Conversation,
  Message,
  GymReview,
  GymListing,
  TenantInvitation,
  PlatformAuditLog,
} = require('../models/platform');
const { TenantStatus } = require('../constants/subscription-status');
const TenantDbManager = require('../database/TenantDbManager');
const { createError } = require('../utils/response.utils');

const FORMAT_VERSION = 1;

/** Columns that are credentials or internal keys, never personal data. */
const SECRET_KEYS = new Set([
  'passwordHash', 'appleRefreshTokenEncrypted', 'token', 'tokenHash', 'inviteTokenHash', 'tokenExpiresAt',
  'qrCode', 'idempotencyKey', 'connectionStringEncrypted', 'provisioningLockToken', 'permissionVersion',
]);

const plain = (row) => {
  const obj = typeof row.get === 'function' ? row.get({ plain: true }) : { ...row };
  for (const key of Object.keys(obj)) if (SECRET_KEYS.has(key)) delete obj[key];
  return obj;
};
const plainAll = (rows) => rows.map(plain);

const ACCOUNT_FIELDS = [
  'id', 'fullName', 'email', 'phone', 'role', 'status', 'isVerified', 'isHost', 'profileImageUrl',
  'createdAt', 'lastLoginAt', 'deletionRequestedAt', 'deletionScheduledFor',
];

/** One gym's database: everything it holds about `userId`. Throws if the database cannot be read. */
const exportFromTenantDb = async (tenant, userId) => {
  if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') return null;
  const { models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  const where = { userId };
  const [profile, subscriptions, payments, attendance, staff, trainers, roles] = await Promise.all([
    models.MemberProfile.findOne({ where }),
    models.MemberSubscription.findAll({ where, order: [['createdAt', 'ASC']] }),
    models.Payment.findAll({ where, order: [['createdAt', 'ASC']] }),
    models.AttendanceLog.findAll({ where, order: [['checkInAt', 'ASC']] }),
    models.GymStaff.findAll({ where }),
    models.Trainer.findAll({ where }),
    models.RoleAssignment.findAll({ where }),
  ]);
  return {
    memberProfile: profile ? plain(profile) : null,
    subscriptions: plainAll(subscriptions),
    payments: plainAll(payments),
    attendance: plainAll(attendance),
    staff: plainAll(staff),
    trainers: plainAll(trainers),
    roleAssignments: plainAll(roles),
  };
};

const buildUserDataExport = async (userId, { now = new Date() } = {}) => {
  const user = await User.findByPk(userId);
  if (!user) throw createError('User not found', 404);

  const [memberships, orgIndex] = await Promise.all([
    UserGymMembership.findAll({ where: { userId }, order: [['createdAt', 'ASC']] }),
    UserOrgIndex.findAll({ where: { userId }, attributes: ['tenantId'], raw: true }),
  ]);
  const tenantIds = [...new Set([...memberships.map((m) => m.tenantId), ...orgIndex.map((r) => r.tenantId)])];
  const tenants = tenantIds.length
    ? await Tenant.findAll({ where: { id: { [Op.in]: tenantIds }, status: { [Op.ne]: TenantStatus.DELETED } } })
    : [];

  const gyms = [];
  const unavailable = [];
  for (const tenant of tenants) {
    try {
      const data = await exportFromTenantDb(tenant, userId);
      gyms.push({ tenantId: tenant.id, gymName: tenant.gymName || tenant.businessName, ...(data || {}) });
    } catch (err) {
      unavailable.push({ tenantId: tenant.id, gymName: tenant.gymName || tenant.businessName, reason: 'database_unavailable' });
      console.error(`[DataExport] Tenant ${tenant.id} not readable for user ${userId}:`, err.message);
    }
  }

  const conversations = await Conversation.findAll({ where: { userId }, order: [['createdAt', 'ASC']] });
  const messages = conversations.length
    ? await Message.findAll({ where: { conversationId: { [Op.in]: conversations.map((c) => c.id) } }, order: [['createdAt', 'ASC']] })
    : [];

  const [devices, saved, notifications, reviews, invitations, owned] = await Promise.all([
    DeviceToken.findAll({ where: { userId } }),
    SavedGym.findAll({ where: { userId } }),
    Notification.findAll({ where: { userId }, order: [['createdAt', 'ASC']] }),
    GymReview.findAll({ where: { userId } }),
    TenantInvitation.findAll({ where: { ownerEmail: user.email } }),
    Tenant.findAll({ where: { ownerUserId: userId, status: { [Op.ne]: TenantStatus.DELETED } } }),
  ]);
  const savedListings = saved.length
    ? await GymListing.findAll({ where: { id: { [Op.in]: saved.map((s) => s.gymListingId) } }, attributes: ['id', 'title'], raw: true })
    : [];
  const titleOf = Object.fromEntries(savedListings.map((l) => [l.id, l.title]));

  const result = {
    format: 'gymsera-user-data-export',
    formatVersion: FORMAT_VERSION,
    exportedAt: now.toISOString(),
    complete: unavailable.length === 0,
    unavailable,
    note: 'Sign-in secrets (password, session and push tokens) are never included. '
      + 'Payment and accounting records are kept for 6 years in anonymized form after account deletion.',
    account: Object.fromEntries(ACCOUNT_FIELDS.map((k) => [k, user[k] ?? null])),
    signInMethods: { password: Boolean(user.passwordHash), google: Boolean(user.googleId), apple: Boolean(user.appleId) },
    devices: plainAll(devices),
    savedGyms: saved.map((s) => ({ ...plain(s), gymTitle: titleOf[s.gymListingId] || null })),
    notifications: plainAll(notifications),
    reviews: plainAll(reviews),
    conversations: conversations.map((c) => ({
      ...plain(c),
      messages: plainAll(messages.filter((m) => m.conversationId === c.id)),
    })),
    memberships: plainAll(memberships),
    gyms,
    ownedBusinesses: owned.map(plain),
    invitations: plainAll(invitations),
  };

  await PlatformAuditLog.create({
    actorUserId: userId,
    action: 'USER_DATA_EXPORT',
    targetType: 'User',
    targetId: userId,
    details: { gyms: gyms.length, unavailable: unavailable.length, formatVersion: FORMAT_VERSION },
    createdAt: now,
  });
  return result;
};

module.exports = { buildUserDataExport, FORMAT_VERSION };
