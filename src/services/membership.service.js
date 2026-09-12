/**
 * Membership service — maintains user_org_index and resolves tenancy from it.
 *
 * The index is derived data whose only job is routing: "which tenant databases do
 * I need to open for this user?". Before it existed, four call sites answered that
 * by looping every active tenant and opening a live MySQL connection to each until
 * a row matched.
 *
 * Rule that must not be broken: nothing here authorizes anything. The index says
 * which door to open; access.service.js decides what is behind it by reading
 * role_assignments in the tenant database.
 */
const { Op } = require('sequelize');
const TenantDbManager = require('../database/TenantDbManager');
const { safeRedisGet, safeRedisSetex, safeRedisDel } = require('../config/redis.config');
const { getRoleLevel } = require('../constants/roles');

const BRANCH_TENANT_TTL = 3600; // 1 hour — a branch never changes tenant

/** Status precedence when collapsing several assignments into one index row. */
const STATUS_RANK = { REVOKED: 0, INVITED: 1, SUSPENDED: 2, ACTIVE: 3 };

/**
 * Recompute this user's index row for one tenant from the tenant DB.
 *
 * Call after any write to role_assignments. Cheap — one indexed query plus one
 * upsert — and idempotent, so calling it twice costs nothing.
 *
 * @param {string} tenantId
 * @param {string} userId
 * @param {object} tenantDb  optional, saves a connection lookup when the caller has one
 */
const syncUserOrgIndex = async (tenantId, userId, tenantDb = null) => {
  if (!tenantId || !userId) return null;

  const { UserOrgIndex, Tenant } = require('../models/platform');

  let db = tenantDb;
  if (!db) {
    const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'connectionStringEncrypted'] });
    if (!tenant || !tenant.connectionStringEncrypted) return null;
    db = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
  }

  const { RoleAssignment, RoleAssignmentBranch } = db.models;

  const assignments = await RoleAssignment.findAll({
    where: { userId, status: { [Op.ne]: 'REVOKED' } },
    include: [{ model: RoleAssignmentBranch, as: 'branchLinks', required: false }],
  });

  if (assignments.length === 0) {
    await UserOrgIndex.destroy({ where: { userId, tenantId } });
    await safeRedisDel(`uoi:${userId}`);
    return null;
  }

  // Collapse to the strongest signal the user has in this tenant.
  let best = assignments[0];
  for (const a of assignments) {
    const aRank = STATUS_RANK[a.status] ?? 0;
    const bestRank = STATUS_RANK[best.status] ?? 0;
    if (aRank > bestRank) best = a;
    else if (aRank === bestRank && getRoleLevel(a.roleKey) > getRoleLevel(best.roleKey)) best = a;
  }

  const isOrgScoped = assignments.some((a) => a.scopeType === 'ORG');
  const branchIds = new Set();
  for (const a of assignments) {
    for (const l of a.branchLinks || []) branchIds.add(l.branchId);
  }

  const row = {
    userId,
    tenantId,
    roleKey: best.roleKey,
    roleLevel: getRoleLevel(best.roleKey),
    scopeType: isOrgScoped ? 'ORG' : 'BRANCH',
    branchCount: isOrgScoped ? 0 : branchIds.size,
    status: best.status,
  };

  await UserOrgIndex.upsert(row);
  await safeRedisDel(`uoi:${userId}`);
  return row;
};

/**
 * Every tenant this user holds a non-revoked assignment in.
 *
 * One indexed read against the platform DB. This is the call that replaced the
 * tenant scan.
 *
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.activeOnly=true] exclude INVITED and SUSPENDED
 */
const listUserTenants = async (userId, opts = {}) => {
  if (!userId) return [];
  const { activeOnly = true } = opts;
  const { UserOrgIndex } = require('../models/platform');

  const where = { userId };
  if (activeOnly) where.status = 'ACTIVE';

  return UserOrgIndex.findAll({ where, order: [['roleLevel', 'DESC']] });
};

/**
 * The tenant a user should be placed in when the request carries no tenant hint.
 *
 * Picks their highest-level active membership, which is nearly always the right
 * answer: a host with one org, or a staff member at one gym. Where a user holds
 * roles in several orgs the client is expected to send X-Tenant-Id — the context
 * switcher in the app exists precisely for this.
 */
const resolveDefaultTenantForUser = async (userId) => {
  const memberships = await listUserTenants(userId, { activeOnly: true });
  return memberships.length > 0 ? memberships[0].tenantId : null;
};

/**
 * Which tenant owns a branch.
 *
 * Cached indefinitely in practice — a branch cannot move between tenants. Falls
 * back to a scan only on a cold cache for a branch that predates the index, and
 * caches the answer so it happens at most once per branch.
 */
const resolveTenantForBranch = async (branchId) => {
  if (!branchId) return null;

  const cacheKey = `branch:${branchId}:tenantId`;
  const cached = await safeRedisGet(cacheKey);
  if (cached) return cached;

  const { Tenant } = require('../models/platform');
  const tenants = await Tenant.findAll({
    where: { status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });

  for (const t of tenants) {
    if (!t.connectionStringEncrypted || t.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
    try {
      const db = await TenantDbManager.getConnection(t.id, t.connectionStringEncrypted);
      const exists = await db.models.Branch.findByPk(branchId, { attributes: ['id'] });
      if (exists) {
        await safeRedisSetex(cacheKey, BRANCH_TENANT_TTL, t.id);
        return t.id;
      }
    } catch (_) {
      // Unreachable tenant — skip rather than fail the whole lookup.
    }
  }
  return null;
};

/**
 * Claim any invites addressed to this user's email.
 *
 * An invite can be issued before the person has a GymsEra account, so it is keyed
 * by email with a null userId. On their first authenticated request in that
 * tenant, the assignment is bound to their user ID and activated.
 *
 * Returns the number of assignments claimed.
 */
const claimInvitesForUser = async (tenantDb, tenantId, user) => {
  if (!user || !user.email) return 0;
  const { RoleAssignment } = tenantDb.models;
  const userId = user.id || user.sub;
  if (!userId) return 0;

  const emailClean = String(user.email).toLowerCase().trim();

  const pending = await RoleAssignment.findAll({
    where: {
      email: emailClean,
      status: 'INVITED',
      [Op.or]: [{ userId: null }, { userId }],
    },
  });
  if (pending.length === 0) return 0;

  const now = new Date();
  for (const a of pending) {
    await a.update({ userId, status: 'ACTIVE', acceptedAt: a.acceptedAt || now });
  }

  await syncUserOrgIndex(tenantId, userId, tenantDb);
  return pending.length;
};

/**
 * Rebuild one tenant's slice of the index from scratch.
 *
 * The repair path. Safe to run at any time — the index is derived data, so
 * rebuilding it can only bring it back into agreement with the tenant DB.
 */
const rebuildIndexForTenant = async (tenantId, tenantDb) => {
  const { RoleAssignment } = tenantDb.models;
  const rows = await RoleAssignment.findAll({
    where: { userId: { [Op.ne]: null } },
    attributes: ['userId'],
    group: ['userId'],
  });

  let synced = 0;
  for (const r of rows) {
    await syncUserOrgIndex(tenantId, r.userId, tenantDb);
    synced += 1;
  }
  return synced;
};

module.exports = {
  syncUserOrgIndex,
  listUserTenants,
  resolveDefaultTenantForUser,
  resolveTenantForBranch,
  claimInvitesForUser,
  rebuildIndexForTenant,
};
