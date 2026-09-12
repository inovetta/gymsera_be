/**
 * Team & Access routes.
 *
 * One router replaces the separate admin-management and staff-management surfaces.
 * Every route is guarded by a permission key, never a role name — which is what
 * lets a host invent a role without a backend deploy.
 */
const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const tenantContext = require('../middleware/tenantContext');
const can = require('../middleware/can');
const controller = require('../controllers/team.controller');

const router = Router();
router.use(authenticate, tenantContext);

// ── Catalogue ────────────────────────────────────────────────────────────────
// Read-only metadata that drives the role picker and permission editor.

/**
 * @swagger
 * /team/meta/roles:
 *   get:
 *     summary: Roles available to the caller, with their permission presets
 *     tags: [Team & Access]
 *     responses:
 *       200: { description: Roles, with assignableByMe per role }
 */
router.get('/meta/roles', can('team.view', { orgWide: true }), controller.listRoles);

/**
 * @swagger
 * /team/meta/permissions:
 *   get:
 *     summary: The permission catalogue, grouped by module
 *     tags: [Team & Access]
 *     responses:
 *       200: { description: Modules, each with its permissions and flags }
 */
router.get('/meta/permissions', can('team.view', { orgWide: true }), controller.listPermissions);

// ── Team ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /team:
 *   get:
 *     summary: List the team — every role in one list
 *     tags: [Team & Access]
 *     parameters:
 *       - { in: query, name: role,   schema: { type: string }, description: Filter by role key }
 *       - { in: query, name: branch, schema: { type: string }, description: Filter by branch }
 *       - { in: query, name: status, schema: { type: string, enum: [INVITED, ACTIVE, SUSPENDED, REVOKED] } }
 *     responses:
 *       200: { description: Team members with role, scope and custom-access flag }
 */
router.get('/', can('team.view', { orgWide: true }), controller.listTeam);

/**
 * @swagger
 * /team/audit:
 *   get:
 *     summary: Audit trail of access changes
 *     tags: [Team & Access]
 */
router.get('/audit', can('audit.view', { orgWide: true }), controller.listAudit);

/**
 * @swagger
 * /team/invites:
 *   post:
 *     summary: Add a team member in any role
 *     tags: [Team & Access]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, roleKey]
 *             properties:
 *               email:                { type: string }
 *               fullName:             { type: string }
 *               phone:                { type: string }
 *               roleKey:              { type: string, enum: [ORG_ADMIN, MANAGER, BR_ADMIN, DESK, TRAINER, SUPPORT] }
 *               assignToAllBranches:  { type: boolean }
 *               branchIds:            { type: array, items: { type: string } }
 *               jobTitle:             { type: string }
 *               validUntil:           { type: string, format: date-time }
 *               overrides:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     permissionKey: { type: string }
 *                     effect:        { type: string, enum: [ALLOW, DENY] }
 *                     dataScope:     { type: string, enum: [ALL, ASSIGNED, OWN] }
 *     responses:
 *       201: { description: Team member created }
 *       403: { description: Role is at or above your own level }
 *       409: { description: Already on the team }
 */
router.post('/invites', can('team.invite', { orgWide: true }), controller.invite);

/**
 * @swagger
 * /team/{assignmentId}:
 *   get:
 *     summary: One team member, with their effective permissions
 *     tags: [Team & Access]
 */
router.get('/:assignmentId', can('team.view', { orgWide: true }), controller.getMember);

/**
 * @swagger
 * /team/{assignmentId}:
 *   patch:
 *     summary: Change role, branch scope, status or validity
 *     tags: [Team & Access]
 */
router.patch('/:assignmentId', can('team.role.assign', { orgWide: true }), controller.update);

/**
 * @swagger
 * /team/{assignmentId}/permissions:
 *   put:
 *     summary: Replace this member's permission overrides
 *     description: >
 *       Replace semantics, deliberately. A partial patch lets two managers editing
 *       the same person silently undo each other's changes.
 *     tags: [Team & Access]
 */
router.put('/:assignmentId/permissions', can('team.permission.override', { orgWide: true }), controller.setPermissions);

/**
 * @swagger
 * /team/{assignmentId}:
 *   delete:
 *     summary: Revoke access (never a hard delete)
 *     tags: [Team & Access]
 */
router.delete('/:assignmentId', can('team.role.assign', { orgWide: true }), controller.revoke);

module.exports = router;
