/**
 * Team & Access controller.
 *
 * Backs the single Team & Access screen that replaces Admin Management and Staff
 * Management. Every handler is thin: guardrails live in access.service, business
 * rules in team.service.
 */
const teamService = require('../services/team.service');
const accessService = require('../services/access.service');
const auditService = require('../services/audit.service');
const { sendSuccess, createError, parsePagination } = require('../utils/response.utils');
const { getCatalogueForClient } = require('../constants/permissions');
const { getRolesForClient, assignableRolesFor, ROLE_META, presetFor } = require('../constants/roles');

/** Build the service context every team operation needs. */
const buildCtx = (req) => ({
  tenantDb: req.tenantDb,
  tenantId: req.tenantId || req.tenantDb.tenantId || req.user.tenantId,
  userId: req.user.id || req.user.sub,
  branchId: req.branchId || null,
  grants: req.grants,
  roleKey: (req.grants && req.grants.roleKeys && req.grants.roleKeys[0]) || null,
  req,
});

/**
 * GET /team
 * One list, filterable by role, branch and status.
 */
const listTeam = async (req, res, next) => {
  try {
    const team = await teamService.listTeam(req.tenantDb, {
      roleKey: req.query.role || undefined,
      branchId: req.query.branch || undefined,
      status: req.query.status || undefined,
      includeRevoked: req.query.includeRevoked === 'true',
    });

    // Counts drive the filter chips without a second round trip.
    const counts = team.reduce((acc, m) => {
      acc[m.role.key] = (acc[m.role.key] || 0) + 1;
      return acc;
    }, {});

    return sendSuccess(res, { team, counts, total: team.length }, 'Team retrieved');
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /team/:assignmentId
 * Includes the effective permission set, so the editor can show what it is changing.
 */
const getMember = async (req, res, next) => {
  try {
    const ctx = buildCtx(req);
    const member = await teamService.getAssignment(req.tenantDb, ctx.tenantId, req.params.assignmentId);
    return sendSuccess(res, member, 'Team member retrieved');
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /team/invites
 * The single creation path for every role.
 */
const invite = async (req, res, next) => {
  try {
    const ctx = buildCtx(req);
    const { assignment, user, tempPassword } = await teamService.inviteMember(ctx, req.body);

    return sendSuccess(
      res,
      {
        assignmentId: assignment.id,
        userId: user.id,
        email: user.email,
        fullName: user.fullName,
        role: {
          key: assignment.roleKey,
          name: ROLE_META[assignment.roleKey]?.name,
          level: assignment.roleLevel,
        },
        scopeType: assignment.scopeType,
        status: assignment.status,
        // Only present when the account was created just now. An existing user
        // signs in with the password they already have.
        tempPassword: tempPassword || null,
      },
      tempPassword
        ? 'Team member created. Share the temporary password with them.'
        : 'Existing GymsEra user added to your team.',
      201
    );
  } catch (err) {
    return next(err);
  }
};

/**
 * PATCH /team/:assignmentId
 * Role, branch scope, status and validity.
 */
const update = async (req, res, next) => {
  try {
    const ctx = buildCtx(req);
    const assignment = await teamService.updateAssignment(ctx, req.params.assignmentId, req.body);
    return sendSuccess(res, { id: assignment.id, roleKey: assignment.roleKey, status: assignment.status }, 'Team member updated');
  } catch (err) {
    return next(err);
  }
};

/**
 * PUT /team/:assignmentId/permissions
 * Replace semantics — see team.service.setOverrides for why this is not a PATCH.
 */
const setPermissions = async (req, res, next) => {
  try {
    const ctx = buildCtx(req);
    const overrides = Array.isArray(req.body.overrides) ? req.body.overrides : [];
    const member = await teamService.setOverrides(ctx, req.params.assignmentId, overrides);
    return sendSuccess(res, member, 'Access updated');
  } catch (err) {
    return next(err);
  }
};

/**
 * DELETE /team/:assignmentId
 * Revokes. Never deletes — the row is load-bearing for the audit trail.
 */
const revoke = async (req, res, next) => {
  try {
    const ctx = buildCtx(req);
    await teamService.revokeAssignment(ctx, req.params.assignmentId);
    return sendSuccess(res, null, 'Access revoked');
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /team/meta/roles
 * The role picker: which roles this caller may actually assign, with their presets.
 */
const listRoles = async (req, res, next) => {
  try {
    const grants = req.grants;
    const all = getRolesForClient();
    const assignableKeys = grants.isOwner
      ? all.filter((r) => r.assignable).map((r) => r.key)
      : assignableRolesFor(grants.level);

    const roles = all.map((role) => ({
      ...role,
      assignableByMe: assignableKeys.includes(role.key),
      // The preset itself, so the "what they'll be able to do" preview needs no
      // second request.
      preset: Object.entries(presetFor(role.key)).map(([key, g]) => ({
        permissionKey: key,
        scope: g.scope,
        tier: g.tier,
      })),
    }));

    return sendSuccess(res, { roles, myLevel: grants.level, isOwner: grants.isOwner }, 'Roles retrieved');
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /team/meta/permissions
 * The catalogue, grouped by module — everything the permission editor needs to
 * render itself without hardcoded knowledge of any key.
 */
const listPermissions = async (_req, res, next) => {
  try {
    return sendSuccess(res, { modules: getCatalogueForClient() }, 'Permission catalogue retrieved');
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /team/audit
 */
const listAudit = async (req, res, next) => {
  try {
    const { limit, offset, page } = parsePagination(req.query, 50, 200);
    const { rows, count } = await auditService.list(req.tenantDb, {
      actor: req.query.actor,
      action: req.query.action,
      branchId: req.query.branch,
      from: req.query.from,
      to: req.query.to,
      limit,
      offset,
    });
    return sendSuccess(res, rows, 'Audit log retrieved', 200, {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit),
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  listTeam,
  getMember,
  invite,
  update,
  setPermissions,
  revoke,
  listRoles,
  listPermissions,
  listAudit,
  buildCtx,
};
