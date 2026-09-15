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
 * /approvals/{id}/collect:
 *   post:
 *     summary: Mark a still-PENDING request as collected — cash already in hand
 *     description: >
 *       For request-tier "Add member" submissions: lets whoever is physically
 *       holding the payment mark it collected immediately, rather than that
 *       attribution silently becoming whoever later approves the request.
 *       Requires payments.record on the request's own branch — checked inside
 *       the service, not here, since the branch isn't known from the URL.
 *     tags: [Approvals]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               method: { type: string, enum: [CASH, BANK_TRANSFER, CARD, WALLET] }
 *               notes:  { type: string }
 *     responses:
 *       200: { description: Marked as collected }
 *       409: { description: Already collected, or already decided }
 */
router.post('/:id/collect', attachGrants({ orgWide: true }), controller.collect);

/**
 * @swagger
 * /approvals/{id}/cancel:
 *   post:
 *     summary: Withdraw your own pending request
 *     tags: [Approvals]
 */
router.post('/:id/cancel', attachGrants({ orgWide: true }), controller.cancel);

module.exports = router;
