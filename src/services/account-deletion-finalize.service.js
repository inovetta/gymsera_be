'use strict';

/**
 * Day 30 of an account deletion (AUTH-07; owner decisions: spec §14 R-16 / R-28).
 *
 * Finishes every deletion whose 30-day undo window has passed. It ANONYMIZES IN PLACE
 * and never drops a database:
 *
 *   KEPT (R-16, 6 years): payments, invoices, ledger days/adjustments, payouts,
 *     tenant_subscriptions, platform_invoices, billing events, audit logs — they only
 *     ever pointed at people by user id, and the user row is anonymized below.
 *   REMOVED / SCRUBBED: the person on the `users` row, their sessions, device tokens,
 *     OTPs, saved gyms, notifications, chat, review text; member health data
 *     (member_profiles), free-text notes, payment proof images, contact details,
 *     staff access; a deleted tenant's contact and bank details.
 *   CANCELLED: the memberships of a deleted tenant (no automatic refunds).
 *   NEVER: dropping a database. The tenant database stays, flagged DELETED, until the owner
 *     drops it by hand after the retention period.
 *
 * Idempotent and safe to re-run. One account failing never stops the others; its status
 * only changes to the final one as the LAST step, so the next run picks it up again.
 */
const { Op } = require('sequelize');
const {
  User,
  Tenant,
  TenantSubscription,
  GymListing,
  UserGymMembership,
  UserOrgIndex,
  RefreshToken,
  DeviceToken,
  Otp,
  SavedGym,
  Notification,
  Conversation,
  Message,
  GymReview,
  TenantInvitation,
  PlatformAuditLog,
} = require('../models/platform');
const { TenantStatus } = require('../constants/subscription-status');
const TenantDbManager = require('../database/TenantDbManager');
const { safeRedisDel } = require('../config/redis.config');
const stripeBilling = require('./stripe-billing.service');
const storageService = require('./storage.service');
const { LIVE_SUBSCRIPTION_STATUSES } = require('./account-deletion.service');
const { revokeAppleSignIn } = require('./apple-signin-revoke.service');

const DELETED_NAME = 'Deleted user';
const deletedEmail = (id) => `deleted-${id}@deleted.gymsera.invalid`;

const _audit = (action, targetType, targetId, details) =>
  PlatformAuditLog.create({ actorUserId: null, action, targetType, targetId, details, createdAt: new Date() });

/** Tenant invitations carry the owner's name, e-mail and phone (NOT NULL columns get a placeholder). */
const _scrubInvitations = async (where) => {
  const rows = await TenantInvitation.findAll({ where, attributes: ['id'] });
  for (const { id } of rows) {
    await TenantInvitation.update(
      { ownerEmail: deletedEmail(`invite-${id}`), ownerFullName: DELETED_NAME, ownerPhone: null, email: deletedEmail(`invite-contact-${id}`), phone: null },
      { where: { id } }
    );
  }
};

/** The tenant's database models, or null when it has none (never provisioned). */
const _tenantModels = async (tenant) => {
  if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') return null;
  const db = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  return db?.models || null;
};

/** Best-effort delete of stored files; a failure here must not block the deletion. */
const _deleteFiles = async (urls) => {
  for (const url of urls.filter(Boolean)) {
    await storageService.deleteImage(url).catch((err) => console.warn('[AccountDeletion] File delete failed:', err.message));
  }
};

const ACTIVE_MEMBERSHIP_STATUSES = ['ACTIVE', 'PENDING', 'FROZEN'];

/**
 * Scrub free text and personal rows for ONE person inside a tenant database.
 * Single-table statements only (no joins): safe on tenant databases with mixed collations.
 */
const _scrubPersonInTenantDb = async (models, userId, now) => {
  const proofs = await models.Payment.findAll({ where: { userId, proofUrl: { [Op.ne]: null } }, attributes: ['proofUrl'], raw: true });
  await _deleteFiles(proofs.map((p) => p.proofUrl));

  await models.MemberSubscription.update(
    { status: 'CANCELLED', cancelledAt: now },
    { where: { userId, status: { [Op.in]: ACTIVE_MEMBERSHIP_STATUSES } } }
  );
  await models.MemberSubscription.update({ notes: null, qrCode: null }, { where: { userId } });
  await models.MemberProfile.destroy({ where: { userId } });
  await models.AttendanceLog.update({ notes: null }, { where: { userId } });
  // Bulk update: no per-row ledger hooks (business date etc.); amounts and dates are untouched.
  await models.Payment.update({ notes: null, proofUrl: null, rejectedReason: null }, { where: { userId } });
  await models.GymStaff.update({ email: null }, { where: { userId } });
  await models.Trainer.update({ bio: null, certificationsJson: null, availabilityJson: null }, { where: { userId } });
  await models.RoleAssignment.update({ status: 'REVOKED' }, { where: { userId, status: { [Op.ne]: 'REVOKED' } } });
};

/** Everything personal in a deleted tenant's database (and the platform rows around it). */
const _finalizeTenantData = async (tenant, now) => {
  const models = await _tenantModels(tenant);
  if (models) {
    const proofs = await models.Payment.findAll({ where: { proofUrl: { [Op.ne]: null } }, attributes: ['proofUrl'], raw: true });
    await _deleteFiles(proofs.map((p) => p.proofUrl));

    await models.MemberSubscription.update(
      { status: 'CANCELLED', cancelledAt: now },
      { where: { status: { [Op.in]: ACTIVE_MEMBERSHIP_STATUSES } } }
    );
    await models.MemberSubscription.update({ notes: null, qrCode: null }, { where: {} });
    await models.MemberProfile.destroy({ where: {} });
    await models.AttendanceLog.update({ notes: null }, { where: {} });
    await models.Payment.update({ notes: null, proofUrl: null, rejectedReason: null }, { where: {} });
    await models.GymStaff.update({ email: null }, { where: {} });
    await models.Trainer.update({ bio: null, certificationsJson: null, availabilityJson: null }, { where: {} });
    await models.RoleAssignment.update({ status: 'REVOKED' }, { where: { status: { [Op.ne]: 'REVOKED' } } });
    await models.Gym.update(
      { contactPhone: null, contactEmail: null, website: null, socialLinksJson: null, description: null, logoUrl: null, coverImageUrl: null, imagesJson: null },
      { where: {} }
    );
    await models.Branch.update(
      { phone: null, address: null, addressLine1: null, addressLine2: null, latitude: null, longitude: null, imagesJson: null, description: null, tagline: null },
      { where: {} }
    );
  }

  const listings = await GymListing.findAll({ where: { tenantId: tenant.id }, attributes: ['id', 'logoUrl', 'coverImageUrl'] });
  await _deleteFiles(listings.flatMap((l) => [l.logoUrl, l.coverImageUrl]));
  await GymListing.update(
    { status: 'INACTIVE', contactPhone: null, website: null, logoUrl: null, coverImageUrl: null, imagesJson: null },
    { where: { tenantId: tenant.id } }
  );
  await UserGymMembership.update({ status: 'CANCELLED' }, { where: { tenantId: tenant.id, status: { [Op.in]: ACTIVE_MEMBERSHIP_STATUSES } } });
  await UserOrgIndex.destroy({ where: { tenantId: tenant.id } });

  // The gym's chats with travelers go with it.
  const conversations = await Conversation.findAll({ where: { tenantId: tenant.id }, attributes: ['id'] });
  if (conversations.length > 0) {
    await Message.destroy({ where: { conversationId: { [Op.in]: conversations.map((c) => c.id) } } });
    await Conversation.destroy({ where: { tenantId: tenant.id } });
  }
  await _scrubInvitations({ tenantId: tenant.id });

  // A Stripe subscription that failed to cancel at request time is retried here.
  const live = await TenantSubscription.findAll({
    where: { tenantId: tenant.id, platform: 'STRIPE', status: { [Op.in]: LIVE_SUBSCRIPTION_STATUSES } },
  });
  for (const sub of live.filter((s) => s.externalOriginalTransactionId)) {
    await stripeBilling.cancelAtPeriodEnd(sub.externalOriginalTransactionId);
  }

  // The tenant row: contact and bank details go; the business name stays (it is on retained invoices).
  // `kycDocumentsJson` is left for the 90-day KYC sweep, which counts from `deletedAt` (R-16).
  await tenant.update({
    email: deletedEmail(`tenant-${tenant.id}`), // NOT NULL column
    phone: null,
    address: null,
    gymDescription: null,
    logoUrl: null,
    coverImageUrl: null,
    bankTransferRef: null,
    paymentDetailsJson: null,
    mainBranchDataJson: null,
    status: TenantStatus.DELETED,
    deletedAt: now,
  });
  await safeRedisDel(`tenant:${tenant.id}:connStr`);
  await TenantDbManager.release(tenant.id).catch(() => {});
};

/** The person: every tenant they belong to, then the platform rows, then the user row itself. */
const _finalizeUser = async (user, now) => {
  const memberTenantIds = new Set([
    ...(await UserGymMembership.findAll({ where: { userId: user.id }, attributes: ['tenantId'], raw: true })).map((r) => r.tenantId),
    ...(await UserOrgIndex.findAll({ where: { userId: user.id }, attributes: ['tenantId'], raw: true })).map((r) => r.tenantId),
  ]);
  const tenants = await Tenant.findAll({
    where: { id: { [Op.in]: [...memberTenantIds] }, status: { [Op.ne]: TenantStatus.DELETED }, ownerUserId: { [Op.ne]: user.id } },
  });
  for (const tenant of tenants) {
    const models = await _tenantModels(tenant);
    if (models) await _scrubPersonInTenantDb(models, user.id, now);
  }
  await UserGymMembership.update({ status: 'CANCELLED' }, { where: { userId: user.id, status: { [Op.in]: ACTIVE_MEMBERSHIP_STATUSES } } });
  await UserOrgIndex.destroy({ where: { userId: user.id } });

  await RefreshToken.destroy({ where: { userId: user.id } });
  await DeviceToken.destroy({ where: { userId: user.id } });
  await Otp.destroy({ where: { [Op.or]: [{ userId: user.id }, { email: user.email }] } });
  await SavedGym.destroy({ where: { userId: user.id } });
  await Notification.destroy({ where: { userId: user.id } });
  await GymReview.update({ title: null, body: null }, { where: { userId: user.id } }); // the rating stays; the words go
  const conversations = await Conversation.findAll({ where: { userId: user.id }, attributes: ['id'] });
  if (conversations.length > 0) {
    await Message.update({ text: '[deleted]' }, { where: { conversationId: { [Op.in]: conversations.map((c) => c.id) }, senderId: user.id } });
    await Conversation.update({ lastMessageText: '[deleted]' }, { where: { userId: user.id } });
  }
  await _scrubInvitations({ ownerEmail: user.email });
  await _deleteFiles([user.profileImageUrl]);

  // Apple wants the Sign in with Apple token revoked (guideline 5.1.1(v)). With no key configured this
  // is recorded and skipped; if Apple is configured and fails, this throws and the sweep retries.
  await revokeAppleSignIn(user);

  // Last: after this the account is final.
  await user.update({
    fullName: DELETED_NAME,
    email: deletedEmail(user.id),
    phone: null,
    passwordHash: null,
    googleId: null,
    appleId: null,
    appleRefreshTokenEncrypted: null,
    profileImageUrl: null,
    isVerified: false,
    status: 'DELETED',
    deletedAt: now,
  });

  try {
    const { clearUserAuthCache } = require('../utils/user-auth-cache');
    clearUserAuthCache(user.id);
  } catch (_) {}
  await safeRedisDel(`user:${user.id}:auth`).catch(() => {});
};

/**
 * @param {{ dryRun?: boolean, now?: Date }} [options]
 * @returns {Promise<{ dryRun: boolean, tenants: Array, users: Array, failed: Array }>}
 */
const runDeletionFinalizeSweep = async ({ dryRun = false, now = new Date() } = {}) => {
  const dueTenants = await Tenant.findAll({
    where: { status: TenantStatus.PENDING_DELETION, deletionScheduledFor: { [Op.lte]: now } },
    order: [['deletionScheduledFor', 'ASC']],
  });
  const dueUsers = await User.findAll({
    where: { status: 'PENDING_DELETION', deletionScheduledFor: { [Op.lte]: now } },
    order: [['deletionScheduledFor', 'ASC']],
  });

  const result = {
    dryRun,
    tenants: dueTenants.map((t) => ({ id: t.id, tenantCode: t.tenantCode, scheduledFor: t.deletionScheduledFor })),
    users: dueUsers.map((u) => ({ id: u.id, scheduledFor: u.deletionScheduledFor })),
    finalizedTenants: [],
    finalizedUsers: [],
    failed: [],
  };
  if (dryRun) return result;

  for (const tenant of dueTenants) {
    try {
      await _finalizeTenantData(tenant, now);
      await _audit('TENANT_DELETION_FINALIZED', 'Tenant', tenant.id, { policy: 'R-16 / R-28', databaseKept: true });
      result.finalizedTenants.push(tenant.id);
    } catch (err) {
      console.error(`[AccountDeletion] Tenant ${tenant.id} not finalized (will retry):`, err.message);
      result.failed.push({ type: 'Tenant', id: tenant.id, error: String(err.message).slice(0, 200) });
    }
  }

  for (const user of dueUsers) {
    try {
      // A user's own tenants must be finished first; if one failed, wait for the next run.
      const unfinished = await Tenant.count({ where: { ownerUserId: user.id, status: TenantStatus.PENDING_DELETION } });
      if (unfinished > 0) {
        result.failed.push({ type: 'User', id: user.id, error: 'an owned tenant is not finalized yet' });
        continue;
      }
      await _finalizeUser(user, now);
      await _audit('ACCOUNT_DELETION_FINALIZED', 'User', user.id, { policy: 'R-16 / R-28' });
      result.finalizedUsers.push(user.id);
    } catch (err) {
      console.error(`[AccountDeletion] User ${user.id} not finalized (will retry):`, err.message);
      result.failed.push({ type: 'User', id: user.id, error: String(err.message).slice(0, 200) });
    }
  }
  return result;
};

module.exports = { runDeletionFinalizeSweep, deletedEmail, DELETED_NAME };
