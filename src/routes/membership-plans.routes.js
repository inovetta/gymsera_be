const { Router } = require('express');
const controller = require('../controllers/membership-plans.controller');
const validators = require('../validators/membership-plans.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const tenantContext = require('../middleware/tenantContext');
const upload = require('../middleware/upload');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: MembershipPlans
 *   description: Gym membership plan management and public browsing
 */

// ── Public routes (no auth required) ─────────────────────────────────────────

/**
 * @swagger
 * /membership-plans:
 *   get:
 *     summary: List active membership plans for a gym (public)
 *     tags: [MembershipPlans]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: gymListingId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: GymListing UUID (from discovery endpoint)
 *       - in: query
 *         name: branchId
 *         schema: { type: string, format: uuid }
 *         description: Filter to branch-specific plans only
 *     responses:
 *       200:
 *         description: List of active membership plans
 *       404:
 *         description: Gym not found or inactive
 */
router.get('/', validate(validators.listPublic), controller.listPublic);

// ── Host routes (auth + tenantContext required) ───────────────────────────────

/**
 * @swagger
 * /membership-plans/host:
 *   get:
 *     summary: List all plans for the authenticated host's gym
 *     tags: [MembershipPlans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: branchId
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: All plans (including inactive) for the host's gym
 */
router.get(
  '/host',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  controller.listForHost
);

/**
 * @swagger
 * /membership-plans/{id}:
 *   get:
 *     summary: Get a single membership plan (public)
 *     tags: [MembershipPlans]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: gymListingId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Membership plan detail
 *       404:
 *         description: Plan not found
 */
router.get('/:id', validate(validators.getPublic), controller.getPublic);

/**
 * @swagger
 * /membership-plans:
 *   post:
 *     summary: Create a new membership plan
 *     tags: [MembershipPlans]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, durationType, durationValue, price]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               branchId: { type: string, format: uuid }
 *               durationType:
 *                 type: string
 *                 enum: [DAILY, WEEKLY, MONTHLY, QUARTERLY, YEARLY]
 *               durationValue: { type: integer, minimum: 1 }
 *               price: { type: number, minimum: 0 }
 *               joiningFee: { type: number, minimum: 0 }
 *               securityFee: { type: number, minimum: 0 }
 *               visitLimit: { type: integer, minimum: 1 }
 *               freezeLimitDays: { type: integer, minimum: 0 }
 *               isTrial: { type: boolean }
 *     responses:
 *       201:
 *         description: Plan created
 */
router.post(
  '/',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  validate(validators.createPlan),
  controller.createPlan
);

/**
 * @swagger
 * /membership-plans/{id}:
 *   patch:
 *     summary: Update a membership plan
 *     tags: [MembershipPlans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Plan updated
 */
router.patch(
  '/:id',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  validate(validators.updatePlan),
  controller.updatePlan
);

/**
 * @swagger
 * /membership-plans/{id}:
 *   delete:
 *     summary: Archive (soft-delete) a membership plan
 *     tags: [MembershipPlans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Plan archived
 */
router.delete(
  '/:id',
  authenticate,
  authorize('GYM_HOST'),
  tenantContext,
  validate(validators.deletePlan),
  controller.deletePlan
);

/**
 * @swagger
 * /membership-plans/{id}/status:
 *   post:
 *     summary: Toggle plan active/inactive status
 *     tags: [MembershipPlans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Status toggled
 */
router.post(
  '/:id/status',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  controller.toggleStatus
);

/**
 * @swagger
 * /membership-plans/{id}/poster:
 *   post:
 *     summary: Upload a poster image for a membership plan
 *     tags: [MembershipPlans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               image: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Poster updated
 */
router.post(
  '/:id/poster',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  upload.image('image'),
  upload.handleMulterError,
  controller.uploadPoster
);

module.exports = router;
