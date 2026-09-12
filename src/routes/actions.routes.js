/**
 * Approvable action routes.
 *
 * One route serves every gated action in the catalogue. `can()` enforces the base
 * permission; the engine then reads the `.direct` twin off the same resolved grant
 * set to choose between executing and queueing.
 */
const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const tenantContext = require('../middleware/tenantContext');
const { attachGrants } = require('../middleware/can');
const controller = require('../controllers/actions.controller');
const accessService = require('../services/access.service');
const { createError } = require('../utils/response.utils');

const router = Router();
router.use(authenticate, tenantContext);

/**
 * The permission to check is the URL parameter itself, so it cannot be known when
 * the route is declared. Resolve grants first, then enforce the key the caller
 * named — which is exactly what can() does, one step later.
 */
const canPerformNamedAction = async (req, _res, next) => {
  try {
    if (!req.grants.has(req.params.actionKey)) {
      return next(createError('You do not have permission to perform this action here', 403));
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

/**
 * @swagger
 * /actions/available:
 *   get:
 *     summary: Which gated actions the caller can take, and at which tier
 *     tags: [Actions]
 *     parameters:
 *       - { in: query, name: branchId, schema: { type: string }, required: true }
 *     responses:
 *       200:
 *         description: Each action with tier DIRECT, REQUEST or OFF
 */
router.get('/available', attachGrants(), controller.available);

/**
 * @swagger
 * /actions/{actionKey}:
 *   post:
 *     summary: Perform an approvable action
 *     description: >
 *       Executes immediately when the caller holds the action's `.direct` twin,
 *       otherwise creates an approval request. Same command handler either way.
 *     tags: [Actions]
 *     parameters:
 *       - { in: path, name: actionKey, required: true, schema: { type: string }, example: members.create }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               branchId:       { type: string }
 *               payload:        { type: object }
 *               idempotencyKey: { type: string }
 *     responses:
 *       200: { description: Executed immediately }
 *       202: { description: Sent for approval }
 *       403: { description: Not permitted }
 */
router.post('/:actionKey', attachGrants(), canPerformNamedAction, controller.perform);

module.exports = router;
