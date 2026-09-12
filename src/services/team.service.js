/**
 * Team service — one code path for every role.
 *
 * Replaces createStaffUser + the parallel "admin" flow. A Manager, an Org Admin, a
 * Front Desk clerk, a Trainer and a Cleaner are created by this one function,
 * differing only in `roleKey`. Adding a role is a catalogue entry, not a new
 * service, table, screen and invite flow.
 *
 * Two rules run through everything here, both enforced server-side:
 *   1. You may only assign a role strictly below your own level.
 *   2. You may only grant permissions you hold yourself.
 */
const { Op } = require('sequelize');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const accessService = require('./access.service');
const membershipService = require('./membership.service');
const auditService = require('./audit.service');
const { createError } = require('../utils/response.utils');
const { ROLE_META, getRoleLevel, isKnownRole } = require('../constants/roles');
const { isKnownPermission, getPermission } = require('../constants/permissions');
const { UserRole } = require('../constants/roles');

/** Assignment fields safe to echo back to a client. */
const ASSIGNMENT_FIELDS = [
  'id', 'userId', 'email', 'roleKey', 'roleLevel', 'scopeType', 'status',
  'jobTitle', 'validFrom', 'validUntil', 'invitedBy', 'invitedAt', 'acceptedAt', 'createdAt',
];

/**
 * Shape one assignment for the team list.
 *
 * Resolves the platform user (name, avatar) and branch names, and flags whether
 * the person deviates from their role preset — hosts need to see at a glance who
 * has custom access, or the presets stop meaning anything.
 */
const serializeAssignment = async (assignment, { branchNames = {}, users = {} } = {}) => {
  const meta = ROLE_META[assignment.roleKey] || {};
  const user = users[assignment.userId] || null;
  const branchLinks = assignment.branchLinks || [];
  const overrides = assignment.overrides || [];

  return {
    id: assignment.id,
    userId: assignment.userId,
    email: assignment.email || (user ? user.email : null),
    fullName: user ? user.fullName : null,
    profileImageUrl: user ? user.profileImageUrl : null,
    role: {
      key: assignment.roleKey,
      name: meta.name || assignment.roleKey,
      displayName: meta.displayName || assignment.roleKey,
      level: assignment.roleLevel,
    },
    scopeType: assignment.scopeType,
    status: assignment.status,
    jobTitle: assignment.jobTitle,
    validFrom: assignment.validFrom,
    validUntil: assignment.validUntil,
    branches:
      assignment.scopeType === 'ORG'
        ? []
        : branchLinks.map((l) => ({ id: l.branchId, name: branchNames[l.branchId] || 'Branch' })),
    branchCount: assignment.scopeType === 'ORG' ? null : branchLinks.length,
    hasCustomAccess: overrides.length > 0,
    overrideCount: overrides.length,
    createdAt: assignment.createdAt,
  };
};

/** Batch-load the platform users and branch names a team list needs. */
const loadDecorations = async (tenantDb, assignments) => {
  const { User } = require('../models/platform');
  const { Branch } = tenantDb.models;

  const userIds = [...new Set(assignments.map((a) => a.userId).filter(Boolean))];
  const branchIds = [
    ...new Set(assignments.flatMap((a) => (a.branchLinks || []).map((l) => l.branchId))),
  ];

  const [userRows, branchRows] = await Promise.all([
    userIds.length
      ? User.findAll({
          where: { id: { [Op.in]: userIds } },
          attributes: ['id', 'fullName', 'email', 'profileImageUrl'],
        })
      : [],
    branchIds.length
      ? Branch.findAll({ where: { id: { [Op.in]: branchIds } }, attributes: ['id', 'branchName'] })
      : [],
  ]);

  return {
    users: Object.fromEntries(userRows.map((u) => [u.id, u])),
    branchNames: Object.fromEntries(branchRows.map((b) => [b.id, b.branchName])),
  };
};

/**
 * The team list. One list, filterable — not one screen per role.
 */
const listTeam = async (tenantDb, { roleKey, branchId, status, includeRevoked = false } = {}) => {
  const { RoleAssignment, RoleAssignmentBranch, AssignmentOverride } = tenantDb.models;

  const where = {};
  if (roleKey) where.roleKey = roleKey;
  if (status) where.status = status;
  else if (!includeRevoked) where.status = { [Op.ne]: 'REVOKED' };

  const assignments = await RoleAssignment.findAll({
    where,
    include: [
      { model: RoleAssignmentBranch, as: 'branchLinks', required: false },
      { model: AssignmentOverride, as: 'overrides', required: false },
    ],
    order: [['roleLevel', 'DESC'], ['createdAt', 'DESC']],
  });

  // Branch filter is applied after loading so an ORG-scoped assignment still shows
  // up when filtering by a branch — it does cover that branch.
  const filtered = branchId
    ? assignments.filter(
        (a) => a.scopeType === 'ORG' || (a.branchLinks || []).some((l) => l.branchId === branchId)
      )
    : assignments;

  const decorations = await loadDecorations(tenantDb, filtered);
  return Promise.all(filtered.map((a) => serializeAssignment(a, decorations)));
};

/**
 * One assignment, with its full effective permission set.
 *
 * The permission editor needs both the preset and the effective result, so the
 * host can see what they are changing from.
 */
const getAssignment = async (tenantDb, tenantId, assignmentId) => {
  const { RoleAssignment, RoleAssignmentBranch, AssignmentOverride } = tenantDb.models;

  const assignment = await RoleAssignment.findByPk(assignmentId, {
    include: [
      { model: RoleAssignmentBranch, as: 'branchLinks', required: false },
      { model: AssignmentOverride, as: 'overrides', required: false },
    ],
  });
  if (!assignment) throw createError('Team member not found', 404);

  const decorations = await loadDecorations(tenantDb, [assignment]);
  const base = await serializeAssignment(assignment, decorations);

  // Effective grants in the first branch of the assignment's scope — enough to
  // drive the editor, which edits one scope at a time.
  const probeBranchId =
    assignment.scopeType === 'ORG' ? null : (assignment.branchLinks || [])[0]?.branchId || null;

  const grants = assignment.userId
    ? await accessService.resolve(tenantDb, tenantId, assignment.userId, probeBranchId, {
        skipCache: true,
      })
    : accessService.emptyGrants();

  return {
    ...base,
    overrides: (assignment.overrides || []).map((o) => ({
      permissionKey: o.permissionKey,
      effect: o.effect,
      dataScope: o.dataScope,
      branchId: o.branchId,
      constraints: o.constraints,
    })),
    effectivePermissions: grants.isOwner ? ['*'] : grants.keys(),
    effectiveScopes: grants.isOwner ? {} : grants.map,
  };
};

/**
 * Invite someone, in any role.
 *
 * Identity rule that the old flow got wrong: an existing account's platform `role`
 * is never modified. Hiring a traveler as a trainer must not cost them their
 * traveler account — that loop is the product. The gym role lives in the
 * assignment, and only there.
 */
const inviteMember = async (ctx, input) => {
  const {
    email,
    fullName,
    phone,
    roleKey,
    scopeType = 'BRANCH',
    branchIds = [],
    assignToAllBranches = false,
    overrides = [],
    jobTitle = null,
    validFrom = null,
    validUntil = null,
  } = input;

  const { tenantDb, tenantId, grants: actorGrants, userId: actorId } = ctx;
  const { RoleAssignment, RoleAssignmentBranch, AssignmentOverride, Branch } = tenantDb.models;
  const { User } = require('../models/platform');

  if (!email) throw createError('An email address is required', 400);
  if (!isKnownRole(roleKey)) throw createError(`Unknown role: ${roleKey}`, 400);

  // ── Guardrails ────────────────────────────────────────────────────────────
  accessService.assertCanAssignRole(actorGrants, roleKey);
  accessService.assertCanGrantOverrides(actorGrants, overrides);

  const emailClean = String(email).toLowerCase().trim();

  // ── Scope ─────────────────────────────────────────────────────────────────
  const effectiveScope = assignToAllBranches ? 'ORG' : scopeType;
  let targetBranchIds = [];

  if (effectiveScope === 'BRANCH') {
    targetBranchIds = [...new Set(branchIds)].filter(Boolean);
    if (targetBranchIds.length === 0) {
      throw createError('Select at least one branch, or assign to all branches', 400);
    }
    const found = await Branch.findAll({
      where: { id: { [Op.in]: targetBranchIds } },
      attributes: ['id'],
    });
    if (found.length !== targetBranchIds.length) {
      throw createError('One or more selected branches do not exist', 400);
    }

    // A branch-scoped actor cannot staff a branch they have no access to.
    if (!actorGrants.isOwner && actorGrants.assignmentIds.length > 0) {
      const actorAssignments = await RoleAssignment.findAll({
        where: { userId: actorId, status: 'ACTIVE' },
        include: [{ model: RoleAssignmentBranch, as: 'branchLinks', required: false }],
      });
      const actorIsOrgScoped = actorAssignments.some((a) => a.scopeType === 'ORG');
      if (!actorIsOrgScoped) {
        const actorBranches = new Set(
          actorAssignments.flatMap((a) => (a.branchLinks || []).map((l) => l.branchId))
        );
        const outside = targetBranchIds.filter((b) => !actorBranches.has(b));
        if (outside.length > 0) {
          throw createError('You can only assign people to branches you manage', 403);
        }
      }
    }
  }

  // ── Identity ──────────────────────────────────────────────────────────────
  let user = await User.findOne({ where: { email: emailClean } });
  let tempPassword = null;

  if (!user) {
    // No account yet. Create one as an ordinary MEMBER — their gym role lives in
    // the assignment, so the platform account stays a plain GymsEra account they
    // can also use as a traveler.
    tempPassword = crypto.randomBytes(4).toString('hex') + '!Aa1';
    user = await User.create({
      fullName: fullName || emailClean.split('@')[0],
      email: emailClean,
      phone: phone || null,
      passwordHash: await bcrypt.hash(tempPassword, 12),
      role: UserRole.MEMBER,
      status: 'ACTIVE',
      isVerified: true,
    });
  }

  // Already on the team in a live capacity? Update that assignment instead of
  // creating a second one, which would silently union two roles' permissions.
  const existing = await RoleAssignment.findOne({
    where: {
      [Op.or]: [{ userId: user.id }, { email: emailClean }],
      status: { [Op.in]: ['INVITED', 'ACTIVE', 'SUSPENDED'] },
    },
  });
  if (existing) {
    throw createError(
      `${emailClean} is already on your team as ${ROLE_META[existing.roleKey]?.name || existing.roleKey}. Edit their access instead of inviting them again.`,
      409
    );
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  const now = new Date();
  const assignment = await RoleAssignment.create({
    userId: user.id,
    email: emailClean,
    roleKey,
    roleLevel: getRoleLevel(roleKey),
    scopeType: effectiveScope,
    status: 'ACTIVE',
    jobTitle,
    validFrom,
    validUntil,
    invitedBy: actorId,
    invitedAt: now,
    acceptedAt: now,
  });

  if (effectiveScope === 'BRANCH') {
    await RoleAssignmentBranch.bulkCreate(
      targetBranchIds.map((branchId) => ({ assignmentId: assignment.id, branchId }))
    );
  }

  if (overrides.length > 0) {
    await AssignmentOverride.bulkCreate(
      overrides.map((o) => ({
        assignmentId: assignment.id,
        branchId: o.branchId || null,
        permissionKey: o.permissionKey,
        effect: o.effect,
        dataScope: o.dataScope || null,
        constraints: o.constraints || null,
        createdBy: actorId,
      }))
    );
  }

  // Index + cache, in the same request. Never a background job — a host who adds
  // someone expects them to be able to log in immediately.
  await membershipService.syncUserOrgIndex(tenantId, user.id, tenantDb);
  await accessService.bumpUserPermissionVersion(user.id);

  await auditService.record(ctx, {
    action: 'team.invite',
    targetType: 'role_assignment',
    targetId: assignment.id,
    after: { email: emailClean, roleKey, scopeType: effectiveScope, branchIds: targetBranchIds },
  });

  await notifyInvitee(ctx, user, assignment, targetBranchIds).catch(() => {});

  return { assignment, user, tempPassword };
};

/**
 * Change role, branch scope, status or validity.
 */
const updateAssignment = async (ctx, assignmentId, changes) => {
  const { tenantDb, tenantId, grants: actorGrants, userId: actorId } = ctx;
  const { RoleAssignment, RoleAssignmentBranch, Branch } = tenantDb.models;

  const assignment = await RoleAssignment.findByPk(assignmentId, {
    include: [{ model: RoleAssignmentBranch, as: 'branchLinks', required: false }],
  });
  if (!assignment) throw createError('Team member not found', 404);

  accessService.assertNotSelf(actorId, assignment.userId);
  accessService.assertCanManageAssignment(actorGrants, assignment);

  const before = auditService.snapshot(assignment, [
    'roleKey', 'scopeType', 'status', 'jobTitle', 'validUntil',
  ]);
  const patch = {};

  if (changes.roleKey && changes.roleKey !== assignment.roleKey) {
    if (!isKnownRole(changes.roleKey)) throw createError(`Unknown role: ${changes.roleKey}`, 400);
    accessService.assertCanAssignRole(actorGrants, changes.roleKey);
    patch.roleKey = changes.roleKey;
    patch.roleLevel = getRoleLevel(changes.roleKey);
  }

  if (changes.status && changes.status !== assignment.status) {
    if (!['ACTIVE', 'SUSPENDED'].includes(changes.status)) {
      throw createError('Status must be ACTIVE or SUSPENDED. Use revoke to remove access.', 400);
    }
    patch.status = changes.status;
  }

  if ('jobTitle' in changes) patch.jobTitle = changes.jobTitle;
  if ('validFrom' in changes) patch.validFrom = changes.validFrom;
  if ('validUntil' in changes) patch.validUntil = changes.validUntil;

  // ── Scope ─────────────────────────────────────────────────────────────────
  const wantsAll = changes.assignToAllBranches === true || changes.scopeType === 'ORG';
  if (wantsAll) {
    patch.scopeType = 'ORG';
  } else if (Array.isArray(changes.branchIds)) {
    const targetBranchIds = [...new Set(changes.branchIds)].filter(Boolean);
    if (targetBranchIds.length === 0) {
      throw createError('Select at least one branch, or assign to all branches', 400);
    }
    const found = await Branch.findAll({
      where: { id: { [Op.in]: targetBranchIds } },
      attributes: ['id'],
    });
    if (found.length !== targetBranchIds.length) {
      throw createError('One or more selected branches do not exist', 400);
    }
    patch.scopeType = 'BRANCH';

    await RoleAssignmentBranch.destroy({ where: { assignmentId } });
    await RoleAssignmentBranch.bulkCreate(
      targetBranchIds.map((branchId) => ({ assignmentId, branchId }))
    );
  }

  if (patch.scopeType === 'ORG') {
    await RoleAssignmentBranch.destroy({ where: { assignmentId } });
  }

  await assignment.update(patch);

  await membershipService.syncUserOrgIndex(tenantId, assignment.userId, tenantDb);
  await accessService.bumpUserPermissionVersion(assignment.userId);

  await auditService.record(ctx, {
    action: 'team.update',
    targetType: 'role_assignment',
    targetId: assignmentId,
    before,
    after: auditService.snapshot(assignment, ['roleKey', 'scopeType', 'status', 'jobTitle', 'validUntil']),
  });

  return assignment;
};

/**
 * Replace this person's overrides wholesale.
 *
 * PUT, not PATCH, and deliberately. Last-write-wins on a partial permission patch
 * is how two managers silently undo each other's access changes: both load the
 * screen, both toggle one thing, the second save resurrects what the first
 * revoked. Send the whole set or send nothing.
 */
const setOverrides = async (ctx, assignmentId, overrides = []) => {
  const { tenantDb, tenantId, grants: actorGrants, userId: actorId } = ctx;
  const { RoleAssignment, AssignmentOverride } = tenantDb.models;

  const assignment = await RoleAssignment.findByPk(assignmentId, {
    include: [{ model: AssignmentOverride, as: 'overrides', required: false }],
  });
  if (!assignment) throw createError('Team member not found', 404);

  accessService.assertNotSelf(actorId, assignment.userId);
  accessService.assertCanManageAssignment(actorGrants, assignment);
  accessService.assertCanGrantOverrides(actorGrants, overrides);

  for (const o of overrides) {
    if (!isKnownPermission(o.permissionKey)) {
      throw createError(`Unknown permission: ${o.permissionKey}`, 400);
    }
    if (!['ALLOW', 'DENY'].includes(o.effect)) {
      throw createError(`Override effect must be ALLOW or DENY, got "${o.effect}"`, 400);
    }
    const perm = getPermission(o.permissionKey);
    if (perm && perm.orgOnly && assignment.scopeType !== 'ORG' && o.effect === 'ALLOW') {
      throw createError(
        `"${perm.label}" can only be granted to someone assigned to all branches`,
        400
      );
    }
  }

  const before = (assignment.overrides || []).map((o) => ({
    permissionKey: o.permissionKey,
    effect: o.effect,
    dataScope: o.dataScope,
  }));

  await AssignmentOverride.destroy({ where: { assignmentId } });
  if (overrides.length > 0) {
    await AssignmentOverride.bulkCreate(
      overrides.map((o) => ({
        assignmentId,
        branchId: o.branchId || null,
        permissionKey: o.permissionKey,
        effect: o.effect,
        dataScope: o.dataScope || null,
        constraints: o.constraints || null,
        createdBy: actorId,
      }))
    );
  }

  await accessService.bumpUserPermissionVersion(assignment.userId);
  await membershipService.syncUserOrgIndex(tenantId, assignment.userId, tenantDb);

  await auditService.record(ctx, {
    action: 'team.permission.override',
    targetType: 'role_assignment',
    targetId: assignmentId,
    before: { overrides: before },
    after: { overrides: overrides.map((o) => ({ permissionKey: o.permissionKey, effect: o.effect, dataScope: o.dataScope })) },
  });

  return getAssignment(tenantDb, tenantId, assignmentId);
};

/**
 * Withdraw access.
 *
 * Never a hard delete. The row survives as REVOKED so audit trails and historical
 * joins keep working, and so "who approved this payment in March" still has an
 * answer after the person leaves.
 */
const revokeAssignment = async (ctx, assignmentId) => {
  const { tenantDb, tenantId, grants: actorGrants, userId: actorId } = ctx;
  const { RoleAssignment } = tenantDb.models;

  const assignment = await RoleAssignment.findByPk(assignmentId);
  if (!assignment) throw createError('Team member not found', 404);

  accessService.assertNotSelf(actorId, assignment.userId);
  accessService.assertCanManageAssignment(actorGrants, assignment);

  if (assignment.roleKey === 'OWNER') {
    throw createError('The owner cannot be removed. Transfer ownership first.', 403);
  }

  const before = auditService.snapshot(assignment, ['roleKey', 'status', 'scopeType']);

  await assignment.update({
    status: 'REVOKED',
    revokedAt: new Date(),
    revokedBy: actorId,
  });

  // Immediate revocation. Bumping the version orphans every cached grant set for
  // this user, so their next request resolves to nothing — no TTL wait.
  await accessService.bumpUserPermissionVersion(assignment.userId);
  await membershipService.syncUserOrgIndex(tenantId, assignment.userId, tenantDb);

  await auditService.record(ctx, {
    action: 'team.revoke',
    targetType: 'role_assignment',
    targetId: assignmentId,
    before,
    after: { status: 'REVOKED' },
  });

  return assignment;
};

const notifyInvitee = async (ctx, user, assignment, branchIds) => {
  const notificationsService = require('./notifications.service');
  const { Tenant } = require('../models/platform');
  const { Branch } = ctx.tenantDb.models;

  const tenant = await Tenant.findByPk(ctx.tenantId, { attributes: ['gymName', 'businessName'] });
  const gymName = tenant ? tenant.gymName || tenant.businessName : 'a gym';
  const meta = ROLE_META[assignment.roleKey] || {};

  let scopeText = 'all branches';
  if (assignment.scopeType === 'BRANCH' && branchIds.length > 0) {
    const branches = await Branch.findAll({
      where: { id: { [Op.in]: branchIds } },
      attributes: ['branchName'],
    });
    scopeText = branches.map((b) => b.branchName).join(', ');
  }

  await notificationsService.createNotification({
    userId: user.id,
    role: 'traveler',
    type: 'team_invite',
    title: `You're now ${meta.name || assignment.roleKey} at ${gymName}`,
    message: `You have been given ${meta.name || assignment.roleKey} access to ${scopeText}.`,
    data: { assignmentId: assignment.id, tenantId: ctx.tenantId, roleKey: assignment.roleKey },
  });
};

module.exports = {
  listTeam,
  getAssignment,
  inviteMember,
  updateAssignment,
  setOverrides,
  revokeAssignment,
  serializeAssignment,
  ASSIGNMENT_FIELDS,
};
