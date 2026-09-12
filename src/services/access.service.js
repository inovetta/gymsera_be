/**
 * Access service — effective permission resolution.
 *
 * The single function the whole authorization system hangs off. Everything else
 * in the RBAC stack is plumbing around `resolve()`.
 *
 * ── Precedence, in order ─────────────────────────────────────────────────────
 *   Owner  >  explicit DENY  >  explicit ALLOW  >  role preset  >  deny by default
 * all of it capped by the tenant's subscription entitlements.
 *
 * ── Why permissions are never in the JWT ─────────────────────────────────────
 * A token that carries grants cannot be revoked before it expires. These
 * permissions guard cash handling, so revocation has to be immediate. Grants are
 * resolved server-side and cached in Redis under a key that embeds both the user's
 * and the tenant's permission_version; bumping either counter orphans every stale
 * entry in one write, with no cache scanning and no stale-grant window.
 */
const { Op } = require('sequelize');
const { safeRedisGet, safeRedisSetex } = require('../config/redis.config');
const {
  SCOPE,
  isKnownPermission,
  getPermission,
  baseKeyFor,
  directKeyFor,
  widerScope,
} = require('../constants/permissions');
const { ROLE_META, presetFor, getRoleLevel } = require('../constants/roles');
const { createError } = require('../utils/response.utils');

const CACHE_TTL_SECONDS = 900; // 15 minutes

/** Statuses that confer no access at all. */
const INACTIVE_STATUSES = ['REVOKED', 'SUSPENDED', 'INVITED'];

/**
 * A resolved permission set for one user in one branch.
 *
 * Immutable by convention: build it in `resolve`, read it everywhere else.
 */
class Grants {
  /**
   * @param {object} opts
   * @param {boolean} opts.isOwner
   * @param {number}  opts.level        highest role level held in scope
   * @param {string[]} opts.roleKeys    every role held in scope
   * @param {Record<string, {scope: string, constraints: object|null}>} opts.map
   */
  constructor({ isOwner = false, level = 0, roleKeys = [], map = {}, assignmentIds = [] }) {
    this.isOwner = isOwner;
    this.level = level;
    this.roleKeys = roleKeys;
    this.assignmentIds = assignmentIds;
    this.map = map;
  }

  /** Does the holder have this permission at all? */
  has(key) {
    if (this.isOwner) return true;
    return Object.prototype.hasOwnProperty.call(this.map, key);
  }

  /**
   * The approval tier for an approvable action:
   *   'DIRECT'  — execute immediately
   *   'REQUEST' — create an approval_request
   *   'OFF'     — not permitted
   */
  tierFor(key) {
    const base = baseKeyFor(key);
    if (!this.has(base)) return 'OFF';
    const twin = directKeyFor(base);
    if (!twin) return 'DIRECT'; // not approvable — holding it means doing it
    return this.has(twin) ? 'DIRECT' : 'REQUEST';
  }

  /** Data scope for a permission: ALL, ASSIGNED or OWN. */
  scopeFor(key) {
    if (this.isOwner) return SCOPE.ALL;
    const g = this.map[key];
    return g ? g.scope : null;
  }

  /** Constraint blob for a permission, if one was set by an override. */
  constraintsFor(key) {
    if (this.isOwner) return null;
    const g = this.map[key];
    return g ? g.constraints : null;
  }

  /** Flat key list — what `/me/context` ships to the client. */
  keys() {
    return Object.keys(this.map);
  }

  toJSON() {
    return {
      isOwner: this.isOwner,
      level: this.level,
      roleKeys: this.roleKeys,
      assignmentIds: this.assignmentIds,
      map: this.map,
    };
  }

  static fromJSON(obj) {
    return new Grants(obj);
  }
}

/** Grants for a tenant owner: everything, unconditionally. */
const ownerGrants = () =>
  new Grants({ isOwner: true, level: ROLE_META.OWNER.level, roleKeys: ['OWNER'], map: {} });

/** Grants for someone with no assignment: nothing. Deny by default. */
const emptyGrants = () => new Grants({});

// ── Entitlements ─────────────────────────────────────────────────────────────

/**
 * Modules a tenant's GymsEra subscription includes.
 *
 * Billing beats RBAC: if the org's plan excludes the Expenses module, nobody gets
 * it regardless of role. Returns null when every module is included, which lets
 * the caller skip the intersection entirely.
 *
 * v1 ships the hook with no restrictions. Wire it to PlatformPackage.features when
 * module-level packaging goes live, and the cap applies everywhere at once.
 *
 * @returns {Set<string>|null} allowed module names, or null for "no restriction"
 */
const entitledModules = async (_tenantId) => null;

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Assignments that are live right now and cover `branchId`.
 *
 * An ORG-scoped assignment covers every branch, including ones created after the
 * assignment was made. A BRANCH-scoped assignment covers only its linked branches.
 * Passing a null branchId asks for org-wide grants and matches ORG scope only.
 */
const loadActiveAssignments = async (tenantDb, userId, branchId) => {
  const { RoleAssignment, RoleAssignmentBranch, AssignmentOverride } = tenantDb.models;
  const now = new Date();

  const assignments = await RoleAssignment.findAll({
    where: {
      userId,
      status: 'ACTIVE',
      [Op.and]: [
        { [Op.or]: [{ validFrom: null }, { validFrom: { [Op.lte]: now } }] },
        { [Op.or]: [{ validUntil: null }, { validUntil: { [Op.gt]: now } }] },
      ],
    },
    include: [
      { model: RoleAssignmentBranch, as: 'branchLinks', required: false },
      { model: AssignmentOverride, as: 'overrides', required: false },
    ],
  });

  return assignments.filter((a) => {
    if (a.scopeType === 'ORG') return true;
    if (!branchId) return false;
    return (a.branchLinks || []).some((l) => l.branchId === branchId);
  });
};

/**
 * Resolve the effective permission set for a user in a branch.
 *
 * @param {object}  tenantDb  from TenantDbManager — { sequelize, models }
 * @param {string}  tenantId
 * @param {string}  userId
 * @param {string|null} branchId  null resolves org-wide grants only
 * @param {object}  [opts]
 * @param {boolean} [opts.skipCache=false]
 * @returns {Promise<Grants>}
 */
const resolve = async (tenantDb, tenantId, userId, branchId = null, opts = {}) => {
  if (!userId || !tenantId) return emptyGrants();

  const { Tenant, User } = require('../models/platform');

  // ── 1. Owner short-circuit ────────────────────────────────────────────────
  const tenant = await Tenant.findByPk(tenantId, {
    attributes: ['id', 'ownerUserId', 'permissionVersion'],
  });
  if (!tenant) return emptyGrants();
  if (tenant.ownerUserId === userId) return ownerGrants();

  // ── Cache lookup ──────────────────────────────────────────────────────────
  // The key embeds both version counters, so a bump on either side orphans every
  // stale entry without any invalidation pass.
  let cacheKey = null;
  if (!opts.skipCache) {
    const user = await User.findByPk(userId, { attributes: ['id', 'permissionVersion'] });
    if (!user) return emptyGrants();
    cacheKey = `perm:t${tenant.permissionVersion}:u${user.permissionVersion}:${tenantId}:${userId}:${branchId || 'org'}`;
    const cached = await safeRedisGet(cacheKey);
    if (cached) {
      try {
        return Grants.fromJSON(JSON.parse(cached));
      } catch (_) {
        // Corrupt entry — fall through and recompute.
      }
    }
  }

  // ── 2. Live assignments covering this branch ──────────────────────────────
  const assignments = await loadActiveAssignments(tenantDb, userId, branchId);

  // ── 3. Deny by default ────────────────────────────────────────────────────
  if (assignments.length === 0) {
    const empty = emptyGrants();
    if (cacheKey) await safeRedisSetex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(empty.toJSON()));
    return empty;
  }

  // ── 4. Union the role presets ─────────────────────────────────────────────
  // A user may legitimately hold more than one role (Trainer at one branch,
  // Front Desk at another). Union the grants and keep the widest data scope.
  const map = {};
  const roleKeys = [];
  let level = 0;

  for (const a of assignments) {
    roleKeys.push(a.roleKey);
    level = Math.max(level, getRoleLevel(a.roleKey));

    const preset = presetFor(a.roleKey);
    for (const [key, grant] of Object.entries(preset)) {
      // An ORG-only permission cannot be conferred by a BRANCH-scoped assignment.
      const perm = getPermission(key);
      if (perm && perm.orgOnly && a.scopeType !== 'ORG') continue;

      if (map[key]) {
        map[key].scope = widerScope(map[key].scope, grant.scope);
      } else {
        map[key] = { scope: grant.scope, constraints: null };
      }
    }
  }

  // ── 5. Overrides — ALLOW adds, DENY is terminal ───────────────────────────
  // DENY is applied in a second pass so ordering between assignments cannot let
  // an ALLOW resurrect a denied key.
  const denied = new Set();
  for (const a of assignments) {
    for (const o of a.overrides || []) {
      if (o.branchId && o.branchId !== branchId) continue;
      if (!isKnownPermission(o.permissionKey)) continue; // stale key from an old deploy

      if (o.effect === 'ALLOW') {
        const perm = getPermission(o.permissionKey);
        if (perm && perm.orgOnly && a.scopeType !== 'ORG') continue;
        map[o.permissionKey] = {
          scope: o.dataScope || (map[o.permissionKey] && map[o.permissionKey].scope) || SCOPE.ALL,
          constraints: o.constraints || null,
        };
      } else if (o.effect === 'DENY') {
        denied.add(o.permissionKey);
        // Denying a base permission also withdraws its ability to act directly;
        // otherwise a DENY on `members.create` would leave `.direct` dangling.
        const twin = directKeyFor(o.permissionKey);
        if (twin) denied.add(twin);
      }
    }
  }
  for (const key of denied) delete map[key];

  // ── 6. Cap by subscription entitlements ───────────────────────────────────
  const allowedModules = await entitledModules(tenantId);
  if (allowedModules) {
    for (const key of Object.keys(map)) {
      const perm = getPermission(key);
      if (perm && !allowedModules.has(perm.module)) delete map[key];
    }
  }

  const grants = new Grants({
    isOwner: false,
    level,
    roleKeys: [...new Set(roleKeys)],
    assignmentIds: assignments.map((a) => a.id),
    map,
  });

  if (cacheKey) await safeRedisSetex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(grants.toJSON()));
  return grants;
};

/** Convenience: resolve then test a single key. */
const can = async (tenantDb, tenantId, userId, permissionKey, branchId = null) => {
  const grants = await resolve(tenantDb, tenantId, userId, branchId);
  return grants.has(permissionKey);
};

// ── Cache invalidation ───────────────────────────────────────────────────────

/**
 * Invalidate every cached permission set for a user, everywhere.
 *
 * Bumps `users.permission_version`, which changes the cache key prefix for every
 * entry belonging to this user. No scanning, no key list, no TTL wait. Call this
 * after any write that changes what someone may do.
 */
const bumpUserPermissionVersion = async (userId) => {
  if (!userId) return;
  const { User } = require('../models/platform');
  await User.increment('permissionVersion', { where: { id: userId } }).catch(() => {});
};

/**
 * Invalidate every cached permission set in an organization.
 *
 * For changes with org-wide blast radius: entitlement changes, custom role edits.
 */
const bumpTenantPermissionVersion = async (tenantId) => {
  if (!tenantId) return;
  const { Tenant } = require('../models/platform');
  await Tenant.increment('permissionVersion', { where: { id: tenantId } }).catch(() => {});
};

// ── Guardrails ───────────────────────────────────────────────────────────────

/**
 * May `actor` assign `targetRoleKey`?
 *
 * Two rules, both enforced here and never in the UI alone:
 *   1. You may only assign a role strictly below your own level. Equal is not
 *      allowed — a Manager creating another Manager is lateral escalation.
 *   2. OWNER is never assignable from the Team screen. Ownership moves through an
 *      explicit two-step transfer.
 *
 * @throws when the assignment would be an escalation
 */
const assertCanAssignRole = (actorGrants, targetRoleKey) => {
  const meta = ROLE_META[targetRoleKey];
  if (!meta) throw createError(`Unknown role: ${targetRoleKey}`, 400);
  if (!meta.assignable) {
    throw createError(`The ${meta.name} role cannot be assigned from the team screen`, 403);
  }
  if (actorGrants.isOwner) return true;

  if (!actorGrants.has('team.role.assign')) {
    throw createError('You do not have permission to assign roles', 403);
  }
  if (meta.level >= actorGrants.level) {
    throw createError(
      `You cannot assign the ${meta.name} role — it is at or above your own level`,
      403
    );
  }
  return true;
};

/**
 * May `actor` grant these permission overrides?
 *
 * You may only grant what you hold yourself. Without this a Branch Admin could
 * override their way to `payouts.bank.manage` in one request.
 *
 * @param {Grants} actorGrants
 * @param {Array<{permissionKey: string, effect: string}>} overrides
 */
const assertCanGrantOverrides = (actorGrants, overrides = []) => {
  if (actorGrants.isOwner) return true;
  if (overrides.length === 0) return true;

  if (!actorGrants.has('team.permission.override')) {
    throw createError('You do not have permission to fine-tune individual access', 403);
  }

  for (const o of overrides) {
    if (!isKnownPermission(o.permissionKey)) {
      throw createError(`Unknown permission: ${o.permissionKey}`, 400);
    }
    // Revoking something is always allowed; only granting is bounded.
    if (o.effect === 'DENY') continue;
    if (!actorGrants.has(o.permissionKey)) {
      const perm = getPermission(o.permissionKey);
      throw createError(
        `You cannot grant "${perm ? perm.label : o.permissionKey}" because you do not hold it yourself`,
        403
      );
    }
  }
  return true;
};

/**
 * Nobody edits their own access. Not the owner, not anyone.
 *
 * The owner already has everything, so this costs them nothing and closes the
 * most obvious self-elevation path for everybody else.
 */
const assertNotSelf = (actorUserId, targetUserId) => {
  if (actorUserId && targetUserId && actorUserId === targetUserId) {
    throw createError('You cannot change your own role or permissions', 403);
  }
  return true;
};

/**
 * May `actor` act on `target`'s assignment at all?
 *
 * You may only manage people strictly below you. Otherwise two Managers could
 * revoke each other, and a Branch Admin could suspend the Owner.
 */
const assertCanManageAssignment = (actorGrants, targetAssignment) => {
  if (actorGrants.isOwner) return true;
  const targetLevel = getRoleLevel(targetAssignment.roleKey);
  if (targetLevel >= actorGrants.level) {
    throw createError('You cannot manage a team member at or above your own level', 403);
  }
  return true;
};

module.exports = {
  Grants,
  resolve,
  can,
  ownerGrants,
  emptyGrants,
  bumpUserPermissionVersion,
  bumpTenantPermissionVersion,
  assertCanAssignRole,
  assertCanGrantOverrides,
  assertNotSelf,
  assertCanManageAssignment,
  entitledModules,
  INACTIVE_STATUSES,
  CACHE_TTL_SECONDS,
};
