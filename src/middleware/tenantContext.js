/**
 * tenantContext — resolves the Sequelize instance for the current request's tenant.
 *
 * Requires `authenticate` to have run first. Attaches:
 *   req.tenantDb  { sequelize, models, tenantId }
 *   req.tenantId
 *
 * ── Resolution order ─────────────────────────────────────────────────────────
 *   1. JWT tenantId claim
 *   2. X-Tenant-Id header / query / body  (the app's context switcher)
 *   3. branchId → cached branch→tenant mapping
 *   4. user_org_index → the user's highest-level active membership
 *
 * Step 4 used to be a loop over every active tenant, opening a live MySQL
 * connection to each until a row matched — O(tenants) handshakes on a single
 * request. It is now one indexed read against the platform DB. See
 * services/membership.service.js.
 */
const { safeRedisGet, safeRedisSetex } = require('../config/redis.config');
const TenantDbManager = require('../database/TenantDbManager');
const membershipService = require('../services/membership.service');
const { getRoleLevel } = require('../constants/roles');

const CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * Compatibility shim for routes still guarded by `authorize(...roles)`.
 *
 * Derives a legacy `req.user.role` from the caller's role assignments so the ~40
 * routes that have not yet moved to `can()` keep behaving exactly as before. It
 * deliberately reproduces the old mapping — anyone with a live assignment reads as
 * BRANCH_MANAGER — so migrating to the new system is not also a behaviour change.
 *
 * Nothing is persisted: the platform `users.role` column is never written here.
 * That is the bug this replaces. Hiring a traveler must not cost them their
 * traveler account.
 *
 * Delete this function once every route uses `can()`.
 */
const applyLegacyRoleShim = async (req, tenantDb, tenantId) => {
  const user = req.user;
  if (!user) return;

  const userId = user.id || user.sub;
  if (!userId) return;

  // Platform admins and the account's own elevated role are left alone.
  if (user.role === 'PLATFORM_ADMIN') return;

  const { Tenant } = require('../models/platform');
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'ownerUserId'] });

  if (tenant && tenant.ownerUserId === userId) {
    user.role = 'GYM_HOST';
    user.isOwner = true;
    return;
  }

  const { RoleAssignment, RoleAssignmentBranch } = tenantDb.models;
  const branchId = req.params.branchId || req.query.branchId || (req.body && req.body.branchId);

  const assignments = await RoleAssignment.findAll({
    where: { userId, status: 'ACTIVE' },
    include: [{ model: RoleAssignmentBranch, as: 'branchLinks', required: false }],
  });

  if (assignments.length === 0) return;

  const best = assignments.reduce((a, b) => (getRoleLevel(b.roleKey) > getRoleLevel(a.roleKey) ? b : a));

  user.roleKey = best.roleKey;
  user.roleLevel = getRoleLevel(best.roleKey);
  // Matches the previous behaviour: any live assignment reads as BRANCH_MANAGER to
  // legacy role checks. New routes ignore this entirely and use can().
  user.role = 'BRANCH_MANAGER';

  // Legacy handlers read req.user.branchId. Prefer the branch the request is
  // actually about; otherwise the first branch the user is assigned to.
  const linkedBranchIds = assignments.flatMap((a) => (a.branchLinks || []).map((l) => l.branchId));
  user.branchId = branchId && linkedBranchIds.includes(branchId) ? branchId : linkedBranchIds[0] || null;
  user.branchIds = [...new Set(linkedBranchIds)];
  user.isOrgScoped = assignments.some((a) => a.scopeType === 'ORG');
};

/**
 * Work out which tenant this request belongs to.
 * @returns {Promise<string|null>}
 */
const resolveTenantId = async (req) => {
  // 1. The token said so.
  if (req.user?.tenantId) return req.user.tenantId;

  // 2. The client said so — the app's context switcher sends this, and it is the
  //    only correct answer for a user who works at more than one organization.
  const explicit = req.headers['x-tenant-id'] || req.query.tenantId || req.body?.tenantId;
  if (explicit) return explicit;

  // 3. Infer from the branch being operated on.
  const branchId = req.params.branchId || req.query.branchId || req.body?.branchId;
  if (branchId) {
    const fromBranch = await membershipService.resolveTenantForBranch(branchId);
    if (fromBranch) return fromBranch;
  }

  // 4. The user's highest-level active membership. One indexed read.
  const userId = req.user?.id || req.user?.sub;
  if (userId) {
    const fromIndex = await membershipService.resolveDefaultTenantForUser(userId);
    if (fromIndex) return fromIndex;
  }

  return null;
};

const tenantContext = async (req, res, next) => {
  try {
    const tenantId = await resolveTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message:
          'This route requires a gym context. Sign in as a gym host or team member, or send an X-Tenant-Id header.',
      });
    }

    // ── Connection string, cached ───────────────────────────────────────────
    const cacheKey = `tenant:${tenantId}:connStr`;
    let encryptedConnStr = await safeRedisGet(cacheKey);

    if (!encryptedConnStr) {
      const { Tenant } = require('../models/platform');
      const tenant = await Tenant.findOne({
        where: { id: tenantId, status: ['ACTIVE', 'SUSPENDED'] },
        attributes: ['id', 'connectionStringEncrypted', 'status'],
      });

      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Tenant not found or not active' });
      }
      if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') {
        return res.status(503).json({
          success: false,
          message: 'Tenant database is not provisioned yet. Please wait for admin approval.',
        });
      }

      encryptedConnStr = tenant.connectionStringEncrypted;
      await safeRedisSetex(cacheKey, CACHE_TTL_SECONDS, encryptedConnStr);
    }

    req.tenantDb = await TenantDbManager.getConnection(tenantId, encryptedConnStr);
    req.tenantDb.tenantId = tenantId;
    req.tenantId = tenantId;

    // Claim any invite addressed to this email but issued before they signed up.
    await membershipService.claimInvitesForUser(req.tenantDb, tenantId, req.user).catch((err) => {
      console.warn('[tenantContext] invite claim failed:', err.message);
    });

    await applyLegacyRoleShim(req, req.tenantDb, tenantId).catch((err) => {
      console.warn('[tenantContext] legacy role shim failed:', err.message);
    });

    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = tenantContext;
module.exports.applyLegacyRoleShim = applyLegacyRoleShim;
