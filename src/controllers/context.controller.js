/**
 * GET /me/context — the bootstrap call.
 *
 * One request on login that tells the client everything it needs to render itself:
 * who the user is, which organizations they belong to, which branches they can act
 * in, exactly which permissions they hold in each, and how many approvals are
 * waiting on them.
 *
 * Deliberately not behind `tenantContext`: its whole job is to enumerate the
 * tenants a user belongs to, which is the question tenantContext needs answered.
 *
 * The client uses this to decide what to *render*. The server still decides what
 * is *allowed*, on every call. A hidden button is not access control.
 */
const TenantDbManager = require('../database/TenantDbManager');
const membershipService = require('../services/membership.service');
const accessService = require('../services/access.service');
const approvalService = require('../services/approval.service');
const { sendSuccess } = require('../utils/response.utils');
const { ROLE_META } = require('../constants/roles');

/**
 * Branches a user can act in within one tenant, each with its resolved permissions.
 *
 * An ORG-scoped assignment covers every active branch; a BRANCH-scoped one covers
 * only its links. Permissions are resolved per branch because they genuinely can
 * differ — the same person may add members at one branch and only view at another.
 */
const branchesForUser = async (tenantDb, tenantId, userId, isOwner) => {
  const { Branch, RoleAssignment, RoleAssignmentBranch } = tenantDb.models;

  let branchIds;
  if (isOwner) {
    branchIds = null; // every branch
  } else {
    const assignments = await RoleAssignment.findAll({
      where: { userId, status: 'ACTIVE' },
      include: [{ model: RoleAssignmentBranch, as: 'branchLinks', required: false }],
    });
    if (assignments.length === 0) return [];
    branchIds = assignments.some((a) => a.scopeType === 'ORG')
      ? null
      : [...new Set(assignments.flatMap((a) => (a.branchLinks || []).map((l) => l.branchId)))];
  }

  const where = { status: 'ACTIVE' };
  if (branchIds) {
    if (branchIds.length === 0) return [];
    where.id = branchIds;
  }

  const branches = await Branch.findAll({ where, attributes: ['id', 'branchName'] });

  return Promise.all(
    branches.map(async (b) => {
      const grants = await accessService.resolve(tenantDb, tenantId, userId, b.id);
      return {
        id: b.id,
        name: b.branchName,
        // '*' is the owner shorthand — the client treats it as "everything" rather
        // than shipping ~90 keys on every login for the most common case.
        permissions: grants.isOwner ? ['*'] : grants.keys(),
        scopes: grants.isOwner ? {} : grants.map,
      };
    })
  );
};

const getContext = async (req, res, next) => {
  try {
    const userId = req.user.id || req.user.sub;
    const { User, Tenant } = require('../models/platform');

    const user = await User.findByPk(userId, {
      attributes: ['id', 'fullName', 'email', 'phone', 'profileImageUrl', 'role', 'isHost', 'permissionVersion'],
    });

    // Every tenant the user belongs to — one indexed read, no tenant scan.
    const memberships = await membershipService.listUserTenants(userId, { activeOnly: true });

    // Plus any organization they own outright. Ownership is not an assignment, so
    // it does not appear in the index.
    const ownedTenants = await Tenant.findAll({
      where: { ownerUserId: userId, status: ['ACTIVE', 'SUSPENDED'] },
      attributes: ['id', 'gymName', 'businessName', 'connectionStringEncrypted', 'status'],
    });

    const tenantIds = [
      ...new Set([...ownedTenants.map((t) => t.id), ...memberships.map((m) => m.tenantId)]),
    ];

    const organizations = [];
    let pendingApprovals = 0;

    for (const tenantId of tenantIds) {
      const tenant =
        ownedTenants.find((t) => t.id === tenantId) ||
        (await Tenant.findByPk(tenantId, {
          attributes: ['id', 'gymName', 'businessName', 'connectionStringEncrypted', 'status', 'ownerUserId'],
        }));

      if (!tenant || !tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') {
        continue;
      }

      let tenantDb;
      try {
        tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
      } catch (err) {
        // One unreachable tenant must not break the whole app shell.
        console.warn(`[context] tenant ${tenantId} unreachable:`, err.message);
        continue;
      }

      const isOwner = tenant.ownerUserId === userId || ownedTenants.some((t) => t.id === tenantId);
      const membership = memberships.find((m) => m.tenantId === tenantId);
      const roleKey = isOwner ? 'OWNER' : membership ? membership.roleKey : null;
      if (!roleKey) continue;

      const orgGrants = await accessService.resolve(tenantDb, tenantId, userId, null);
      const branches = await branchesForUser(tenantDb, tenantId, userId, isOwner);

      const decidableBranchIds =
        isOwner || orgGrants.isOwner || (membership && membership.scopeType === 'ORG')
          ? null
          : branches.map((b) => b.id);
      const pending = await approvalService
        .pendingCountFor(tenantDb, orgGrants, decidableBranchIds)
        .catch(() => 0);
      pendingApprovals += pending;

      organizations.push({
        tenantId,
        name: tenant.gymName || tenant.businessName,
        isOwner,
        role: {
          key: roleKey,
          name: ROLE_META[roleKey]?.name || roleKey,
          displayName: ROLE_META[roleKey]?.displayName || roleKey,
          level: ROLE_META[roleKey]?.level || 0,
        },
        scopeType: isOwner ? 'ORG' : membership?.scopeType || 'BRANCH',
        orgPermissions: orgGrants.isOwner ? ['*'] : orgGrants.keys(),
        branches,
        pendingApprovals: pending,
      });
    }

    return sendSuccess(
      res,
      {
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          phone: user.phone,
          profileImageUrl: user.profileImageUrl,
          isHost: user.isHost,
          // The platform account type. Says nothing about gym access — that lives
          // entirely in `organizations` below.
          platformRole: user.role,
        },
        organizations,
        pendingApprovals,
        // Lets the client decide whether to show the organization switcher at all.
        needsContextSwitcher: organizations.length > 1,
        permissionVersion: user.permissionVersion,
      },
      'Context retrieved'
    );
  } catch (err) {
    return next(err);
  }
};

module.exports = { getContext, branchesForUser };
