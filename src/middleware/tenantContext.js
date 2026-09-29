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
 * Verify whether an authenticated user belongs to the requested tenant.
 * @param {string} userId
 * @param {string} tenantId
 * @returns {Promise<boolean>}
 */
const userBelongsToTenant = async (userId, tenantId) => {
  if (!userId || !tenantId) return false;
  const { UserOrgIndex, Tenant, UserGymMembership } = require('../models/platform');

  // 1. Direct tenant ownership
  const owned = await Tenant.findOne({
    where: { id: tenantId, ownerUserId: userId, status: 'ACTIVE' },
    attributes: ['id'],
  });
  if (owned) return true;

  // 2. Active membership in UserOrgIndex (staff / team)
  const inIndex = await UserOrgIndex.findOne({
    where: { userId, tenantId, status: 'ACTIVE' },
    attributes: ['tenantId'],
  });
  if (inIndex) return true;

  // 3. Gym member in UserGymMembership
  const inMemberIndex = await UserGymMembership.findOne({
    where: { userId, tenantId },
    attributes: ['id'],
  });
  if (inMemberIndex) return true;

  // 3. Fallback: check RoleAssignment directly in tenant DB (e.g. before index sync)
  try {
    const tenant = await Tenant.findOne({
      where: { id: tenantId, status: 'ACTIVE' },
      attributes: ['id', 'connectionStringEncrypted'],
    });
    if (!tenant || !tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') {
      return false;
    }
    const db = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
    if (db?.models?.RoleAssignment) {
      const assignment = await db.models.RoleAssignment.findOne({
        where: { userId, status: 'ACTIVE' },
        attributes: ['id'],
      });
      if (assignment) {
        await membershipService.syncUserOrgIndex(tenantId, userId, db).catch(() => {});
        return true;
      }
    }
  } catch (_) {
    // Unreachable tenant DB — skip
  }

  return false;
};

/**
 * Work out which tenant this request belongs to.
 * Tenant identity comes strictly from authentication and validated selectors.
 * Never from client body input.
 * @returns {Promise<string|null>}
 */
const resolveTenantId = async (req) => {
  const user = req.user;
  const userId = user?.id || user?.sub;
  const isPlatformAdmin = user?.role === 'PLATFORM_ADMIN';

  // 1. Header-based tenant selector (X-Tenant-Id)
  // Validated against tenants the user actually belongs to.
  const headerTenantId = req.headers['x-tenant-id'];
  if (headerTenantId) {
    if (isPlatformAdmin) {
      const { Tenant } = require('../models/platform');
      const exists = await Tenant.findOne({
        where: { id: headerTenantId, status: 'ACTIVE' },
        attributes: ['id'],
      });
      return exists ? headerTenantId : null;
    }
    const belongs = await userBelongsToTenant(userId, headerTenantId);
    return belongs ? headerTenantId : null;
  }

  // 2. Token-scoped tenantId (if present in JWT)
  if (user?.tenantId) {
    if (isPlatformAdmin) return user.tenantId;
    const belongs = await userBelongsToTenant(userId, user.tenantId);
    if (belongs) return user.tenantId;
  }

  // 3. Infer from branch being operated on (URL params or query only, never body!)
  const branchId = req.params?.branchId || req.query?.branchId;
  if (branchId) {
    const fromBranch = await membershipService.resolveTenantForBranch(branchId);
    if (fromBranch) {
      if (isPlatformAdmin) return fromBranch;
      const belongs = await userBelongsToTenant(userId, fromBranch);
      if (belongs) return fromBranch;
    }
  }

  // 4. User's default active tenant (membership index or owned tenant)
  if (userId) {
    const fromIndex = await membershipService.resolveDefaultTenantForUser(userId);
    if (fromIndex) return fromIndex;
  }

  return null;
};

const tenantContext = async (req, res, next) => {
  try {
    const user = req.user;
    const userId = user?.id || user?.sub;
    const isPlatformAdmin = user?.role === 'PLATFORM_ADMIN';

    // ── SEC-02: Tenant identity from authentication, never client input ───
    // 1. If client provided a tenantId in request body:
    //    It must NEVER select tenant. If caller forged an out-of-scope tenant ID,
    //    reject immediately with 404 (without leaking existence).
    //    If caller belongs to it, delete it so body is never the authority.
    if (req.body && req.body.tenantId !== undefined) {
      const bodyTenantId = req.body.tenantId;
      delete req.body.tenantId;

      if (!isPlatformAdmin) {
        const belongs = await userBelongsToTenant(userId, bodyTenantId);
        if (!belongs) {
          return res.status(404).json({ success: false, message: 'Tenant not found or not active' });
        }
      }
    }

    // 2. If client provided X-Tenant-Id header for an out-of-scope tenant:
    //    Must be rejected with 404 without leaking existence.
    const headerTenantId = req.headers['x-tenant-id'];
    if (headerTenantId) {
      if (isPlatformAdmin) {
        const { Tenant } = require('../models/platform');
        const exists = await Tenant.findOne({
          where: { id: headerTenantId, status: 'ACTIVE' },
          attributes: ['id'],
        });
        if (!exists) {
          return res.status(404).json({ success: false, message: 'Tenant not found or not active' });
        }
      } else {
        const belongs = await userBelongsToTenant(userId, headerTenantId);
        if (!belongs) {
          return res.status(404).json({ success: false, message: 'Tenant not found or not active' });
        }
      }
    }

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
        where: { id: tenantId, status: 'ACTIVE' },
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
    if (req.user) {
      req.user.tenantId = tenantId;
    }

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
module.exports.resolveTenant = tenantContext;
module.exports.resolveTenantId = resolveTenantId;
module.exports.userBelongsToTenant = userBelongsToTenant;
module.exports.applyLegacyRoleShim = applyLegacyRoleShim;
