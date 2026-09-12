/**
 * Approvals routes — the inbox and the policies behind it.
 */
const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const tenantContext = require('../middleware/tenantContext');
const can = require('../middleware/can');
const { attachGrants } = require('../middleware/can');
const controller = require('../controllers/approvals.controller');

const router = Router();
router.use(authenticate, tenantContext);

/**
 * @swagger
 * /approvals:
 *   get:
 *     summary: Requests waiting on the caller
 *     tags: [Approvals]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [PENDING, APPROVED, REJECTED, ALL] } }
 *     responses:
 *       200: { description: Approval requests scoped to branches the caller can decide for }
 */
router.get('/', can('approvals.view', { orgWide: true }), controller.list);

/**
 * @swagger
 * /approvals/mine:
 *   get:
 *     summary: Requests the caller submitted
 *     description: Needs no permission — everyone can see what they themselves asked for.
 *     tags: [Approvals]
 */
router.get('/mine', attachGrants({ orgWide: true }), controller.listMine);

/**
 * @swagger
 * /approvals/policies:
 *   get:
 *     summary: Who decides which actions, and within what SLA
 *     tags: [Approvals]
 */
router.get('/policies', can('approvals.view', { orgWide: true }), controller.listPolicies);

/**
 * @swagger
 * /approvals/policies/{actionKey}:
 *   put:
 *     summary: Set the approval policy for an action
 *     tags: [Approvals]
 */
router.put('/policies/:actionKey', can('roles.manage', { orgWide: true }), controller.upsertPolicy);

/**
 * @swagger
 * /approvals/{id}/approve:
 *   post:
 *     summary: Approve a request and execute it
 *     description: >
 *       Re-validates and then runs the same command handler the direct path uses.
 *       The status transition is a conditional UPDATE, so two approvers racing
 *       cannot both execute.
 *     tags: [Approvals]
 *     responses:
 *       200: { description: Approved and executed }
 *       409: { description: Already decided by someone else }
 */
router.post('/:id/approve', can('approvals.decide', { orgWide: true }), controller.approve);

/**
 * @swagger
 * /approvals/{id}/reject:
 *   post:
 *     summary: Reject a request, with a reason
 *     tags: [Approvals]
 */
router.post('/:id/reject', can('approvals.decide', { orgWide: true }), controller.reject);

/**
 * @swagger
 * /approvals/{id}/cancel:
 *   post:
 *     summary: Withdraw your own pending request
 *     tags: [Approvals]
 */
router.post('/:id/cancel', attachGrants({ orgWide: true }), controller.cancel);

module.exports = router;
