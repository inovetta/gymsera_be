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
const { sendError } = require('../utils/response.utils');
const TenantDbManager = require('../database/TenantDbManager');
const membershipService = require('../services/membership.service');
const { getRoleLevel } = require('../constants/roles');

const CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * Per-request memo (PERF API overhead, spec §4.4).
 *
 * One tenantContext run used to read the same ACTIVE tenant row up to four times
 * (header check, resolveTenantId, connection string, legacy role shim) and ran
 * the whole membership check twice for the same user + tenant. The memo is a
 * plain object created inside each tenantContext call and passed down by hand:
 * it is never stored on `req`, a module, or Redis, so it cannot outlive the
 * request and never carries a decision from one request to the next. Every
 * request therefore still reads the tenant's current status from the database
 * (NEW-26: a suspended tenant is refused on the very next request).
 */
const newRequestMemo = () => ({ activeTenants: new Map(), belongs: new Map() });

/**
 * The tenant row, but only while it is ACTIVE (null otherwise), read once per
 * request. Carries everything the middleware needs from the platform tenants
 * table: owner, connection string, status.
 */
const loadActiveTenant = (memo, tenantId) => {
  const { Tenant } = require('../models/platform');
  const query = () =>
    Tenant.findOne({
      where: { id: tenantId, status: 'ACTIVE' },
      attributes: ['id', 'ownerUserId', 'connectionStringEncrypted', 'status'],
    });
  if (!memo) return query();
  if (!memo.activeTenants.has(tenantId)) {
    const p = query();
    memo.activeTenants.set(tenantId, p);
    p.catch(() => memo.activeTenants.delete(tenantId));
  }
  return memo.activeTenants.get(tenantId);
};

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
const applyLegacyRoleShim = async (req, tenantDb, tenantId, memo = null) => {
  const user = req.user;
  if (!user) return;

  const userId = user.id || user.sub;
  if (!userId) return;

  // Platform admins and the account's own elevated role are left alone.
  if (user.role === 'PLATFORM_ADMIN') return;

  // NEW-108: the account role GYM_HOST / isHost (set when someone starts a gym,
  // tenant.service registerTenant) says "this person owns *a* gym", not "this
  // gym". Inside a tenant it counts only when they own *that* tenant. Demote
  // first, before any await, so a failure below leaves the caller with no owner
  // rights rather than with the account-wide ones.
  user.isOwner = false;
  user.isHost = false;
  if (user.role === 'GYM_HOST') user.role = 'MEMBER';

  // The tenant is ACTIVE here (tenantContext just resolved it), so the memoized
  // row answers; anything else keeps the original unconditional lookup.
  const { Tenant } = require('../models/platform');
  const tenant = (await loadActiveTenant(memo, tenantId))
    || (await Tenant.findByPk(tenantId, { attributes: ['id', 'ownerUserId'] }));

  if (tenant && tenant.ownerUserId === userId) {
    user.role = 'GYM_HOST';
    user.isOwner = true;
    user.isHost = true;
    return;
  }

  // A traveller here (only a gym membership links them to this tenant) acts as a
  // member: no team role to look up.
  if (req.tenantRelation === 'MEMBER') return;

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
const userBelongsToTenant = async (userId, tenantId, memo = null) =>
  (await tenantRelation(userId, tenantId, memo)) !== null;

/**
 * How the user is linked to the tenant: 'OWNER', 'STAFF' (membership index or a
 * live role assignment), 'MEMBER' (only a gym membership: a traveller), or null.
 * tenantContext keeps it on req.tenantRelation so a traveller never gets staff or
 * owner handling in that tenant (NEW-108).
 */
const tenantRelation = (userId, tenantId, memo = null) => {
  if (!userId || !tenantId) return Promise.resolve(null);
  if (!memo) return _tenantRelation(userId, tenantId, null);
  const key = `${userId}:${tenantId}`;
  if (!memo.belongs.has(key)) memo.belongs.set(key, _tenantRelation(userId, tenantId, memo));
  return memo.belongs.get(key);
};

/**
 * Is this user part of the tenant's *staff*: its owner, or someone with a live
 * team role there? A paying gym member (UserGymMembership) is not. Realtime
 * staff rooms use this, never userBelongsToTenant (NEW-85).
 */
const userIsTenantStaff = (userId, tenantId) => {
  if (!userId || !tenantId) return Promise.resolve(false);
  return _tenantRelation(userId, tenantId, null).then((r) => r === 'OWNER' || r === 'STAFF');
};

const _tenantRelation = async (userId, tenantId, memo) => {
  const { UserOrgIndex, UserGymMembership } = require('../models/platform');

  // 1. Direct tenant ownership (an ACTIVE tenant whose owner is this user)
  const ownedTenant = await loadActiveTenant(memo, tenantId);
  if (ownedTenant && ownedTenant.ownerUserId === userId) return 'OWNER';

  // 2. Active membership in UserOrgIndex (staff / team)
  const inIndex = await UserOrgIndex.findOne({
    where: { userId, tenantId, status: 'ACTIVE' },
    attributes: ['tenantId'],
  });
  if (inIndex) return 'STAFF';

  // 3. Fallback: check RoleAssignment directly in tenant DB (e.g. before index sync)
  try {
    const tenant = ownedTenant;
    if (tenant && tenant.connectionStringEncrypted && tenant.connectionStringEncrypted !== 'PENDING_PROVISIONING') {
      const db = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
      if (db?.models?.RoleAssignment) {
        const assignment = await db.models.RoleAssignment.findOne({
          where: { userId, status: 'ACTIVE' },
          attributes: ['id'],
        });
        if (assignment) {
          await membershipService.syncUserOrgIndex(tenantId, userId, db).catch(() => {});
          return 'STAFF';
        }
      }
    }
  } catch (_) {
    // Unreachable tenant DB — skip
  }

  // 4. Gym member in UserGymMembership (a traveller, any status): reaches the
  //    member routes of that gym only. Never staff, never owner (NEW-85, NEW-108).
  const inMemberIndex = await UserGymMembership.findOne({
    where: { userId, tenantId },
    attributes: ['id'],
  });
  if (inMemberIndex) return 'MEMBER';

  return null;
};

/**
 * Work out which tenant this request belongs to.
 * Tenant identity comes strictly from authentication and validated selectors.
 * Never from client body input.
 * @returns {Promise<string|null>}
 */
const resolveTenantId = async (req, memo = null, { memberRoute = false } = {}) => {
  const user = req.user;
  const userId = user?.id || user?.sub;
  const isPlatformAdmin = user?.role === 'PLATFORM_ADMIN';

  // 1. Header-based tenant selector (X-Tenant-Id)
  // Validated against tenants the user actually belongs to.
  const headerTenantId = req.headers['x-tenant-id'];
  if (headerTenantId) {
    if (isPlatformAdmin) {
      const exists = await loadActiveTenant(memo, headerTenantId);
      return exists ? headerTenantId : null;
    }
    const belongs = await userBelongsToTenant(userId, headerTenantId, memo);
    return belongs ? headerTenantId : null;
  }

  // 2. Token-scoped tenantId (if present in JWT)
  if (user?.tenantId) {
    if (isPlatformAdmin) return user.tenantId;
    const belongs = await userBelongsToTenant(userId, user.tenantId, memo);
    if (belongs) return user.tenantId;
  }

  // 3. Infer from branch being operated on (URL params or query only, never body!)
  const branchId = req.params?.branchId || req.query?.branchId;
  if (branchId) {
    const fromBranch = await membershipService.resolveTenantForBranch(branchId);
    if (fromBranch) {
      if (isPlatformAdmin) return fromBranch;
      const belongs = await userBelongsToTenant(userId, fromBranch, memo);
      if (belongs) return fromBranch;
    }
  }

  // 4. User's default active tenant (membership index or owned tenant)
  if (userId) {
    const fromIndex = await membershipService.resolveDefaultTenantForUser(userId, { memberRoute });
    if (fromIndex) return fromIndex;
  }

  return null;
};

const makeTenantContext = ({ memberRoute = false } = {}) => async (req, res, next) => {
  try {
    const memo = newRequestMemo(); // this request only; see newRequestMemo
    const user = req.user;
    const userId = user?.id || user?.sub;
    const isPlatformAdmin = user?.role === 'PLATFORM_ADMIN';

    // ── SEC-02: Tenant identity from authentication, never client input ───
    const isV2 = req.headers['x-api-version'] === '2' || req.headers['accept-version'] === '2';
    const rejectTenantNotFound = (r) => {
      if (isV2) return sendError(r, 404, 'Tenant not found or not active', 'tenant_not_found');
      return r.status(404).json({ success: false, message: 'Tenant not found or not active' });
    };

    // 1. If client provided a tenantId in request body:
    //    It must NEVER select tenant. If caller forged an out-of-scope tenant ID,
    //    reject immediately with 404 (without leaking existence).
    //    If caller belongs to it, delete it so body is never the authority.
    if (req.body && req.body.tenantId !== undefined) {
      const bodyTenantId = req.body.tenantId;
      delete req.body.tenantId;

      if (!isPlatformAdmin) {
        const belongs = await userBelongsToTenant(userId, bodyTenantId, memo);
        if (!belongs) {
          return rejectTenantNotFound(res);
        }
      }
    }

    // 2. If client provided X-Tenant-Id header for an out-of-scope tenant:
    //    Must be rejected with 404 without leaking existence.
    const headerTenantId = req.headers['x-tenant-id'];
    if (headerTenantId) {
      if (isPlatformAdmin) {
        const exists = await loadActiveTenant(memo, headerTenantId);
        if (!exists) {
          return rejectTenantNotFound(res);
        }
      } else {
        const belongs = await userBelongsToTenant(userId, headerTenantId, memo);
        if (!belongs) {
          return rejectTenantNotFound(res);
        }
      }
    }

    const tenantId = await resolveTenantId(req, memo, { memberRoute });

    if (!tenantId) {
      // BUG-14/15: a host whose own gym is not live yet gets a clear code the
      // clients map to "your gym isn't live yet", never a developer sentence.
      if (userId && !isPlatformAdmin && (await membershipService.ownsInactiveTenant(userId))) {
        return sendError(res, 409, 'Your gym is not live yet. Finish setting it up to use this.', 'tenant_not_active');
      }
      return sendError(res, 400, 'Choose a gym to continue.', 'missing_tenant_context');
    }

    // ── Connection string, cached ───────────────────────────────────────────
    const cacheKey = `tenant:${tenantId}:connStr`;
    let encryptedConnStr = await safeRedisGet(cacheKey);

    if (!encryptedConnStr) {
      const tenant = await loadActiveTenant(memo, tenantId);

      if (!tenant) {
        return rejectTenantNotFound(res);
      }
      if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') {
        return sendError(
          res,
          503,
          'Tenant database is not provisioned yet. Please wait for admin approval.',
          'tenant_not_provisioned'
        );
      }

      encryptedConnStr = tenant.connectionStringEncrypted;
      await safeRedisSetex(cacheKey, CACHE_TTL_SECONDS, encryptedConnStr);
    }

    req.tenantRelation = isPlatformAdmin ? null : await tenantRelation(userId, tenantId, memo);

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

    await applyLegacyRoleShim(req, req.tenantDb, tenantId, memo).catch((err) => {
      console.warn('[tenantContext] legacy role shim failed:', err.message);
    });

    return next();
  } catch (err) {
    return next(err);
  }
};

const tenantContext = makeTenantContext();

module.exports = tenantContext;
// Traveller member routes (/member/*): may fall back to a gym the caller booked, as a member.
module.exports.forMemberRoutes = makeTenantContext({ memberRoute: true });
module.exports.resolveTenant = tenantContext;
module.exports.resolveTenantId = resolveTenantId;
module.exports.userBelongsToTenant = userBelongsToTenant;
module.exports.userIsTenantStaff = userIsTenantStaff;
module.exports.tenantRelation = tenantRelation;
module.exports.applyLegacyRoleShim = applyLegacyRoleShim;
