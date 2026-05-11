const { Router } = require('express');
const controller = require('../controllers/subscriptions.controller');
const validators = require('../validators/subscriptions.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const tenantContext = require('../middleware/tenantContext');
const { UserRole } = require('../constants/roles');

const router = Router();

// All subscription routes require the user to be authenticated
router.use(authenticate);

/**
 * @swagger
 * tags:
 *   name: Subscriptions
 *   description: Member gym subscription lifecycle
 */

/**
 * @swagger
 * /subscriptions:
 *   post:
 *     summary: Subscribe to a gym membership plan
 *     tags: [Subscriptions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [planId, gymListingId, branchId]
 *             properties:
 *               planId:
 *                 type: string
 *                 format: uuid
 *                 description: MembershipPlan UUID (from tenant DB)
 *               gymListingId:
 *                 type: string
 *                 format: uuid
 *                 description: GymListing UUID (from discovery endpoint)
 *               branchId:
 *                 type: string
 *                 format: uuid
 *                 description: Branch UUID to subscribe to
 *               autoRenew:
 *                 type: boolean
 *                 default: false
 *               sourceChannel:
 *                 type: string
 *                 enum: [ONLINE, WALK_IN, STAFF]
 *                 default: ONLINE
 *     responses:
 *       201:
 *         description: Subscription created with QR code token
 *       409:
 *         description: Active subscription already exists at this branch
 */
router.post('/', validate(validators.subscribe), controller.subscribe);

/**
 * @swagger
 * /subscriptions/{id}/freeze:
 *   post:
 *     summary: Freeze an active subscription for a date range
 *     tags: [Subscriptions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: MemberSubscription UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [freezeFrom, freezeTo]
 *             properties:
 *               freezeFrom:
 *                 type: string
 *                 format: date
 *               freezeTo:
 *                 type: string
 *                 format: date
 *     responses:
 *       200:
 *         description: Subscription frozen
 *       400:
 *         description: Plan does not allow freezing or limit exceeded
 *       409:
 *         description: Subscription not in ACTIVE state
 */
router.post('/:id/freeze', validate(validators.freeze), controller.freeze);

/**
 * @swagger
 * /subscriptions/{id}/cancel:
 *   post:
 *     summary: Cancel a subscription
 *     tags: [Subscriptions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Subscription cancelled
 *       409:
 *         description: Already cancelled or expired
 */
router.post('/:id/cancel', validate(validators.cancel), controller.cancel);

/**
 * @swagger
 * /subscriptions/{id}/renew:
 *   post:
 *     summary: Renew a subscription — extends end date by one plan cycle
 *     tags: [Subscriptions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Subscription renewed with new end date and QR token
 *       409:
 *         description: Subscription is cancelled or plan no longer available
 */
router.post('/:id/renew', validate(validators.renew), controller.renew);

// ── Staff-facing routes (GYM_HOST | BRANCH_MANAGER) ──────────────────────────

const staffRoles = [UserRole.GYM_HOST, UserRole.BRANCH_MANAGER, UserRole.PLATFORM_ADMIN];

/**
 * @swagger
 * /subscriptions/preview:
 *   post:
 *     summary: Dry-run subscription preview (date + price calculation)
 *     tags: [Subscriptions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [planId]
 *             properties:
 *               planId: { type: string, format: uuid }
 *               startDate: { type: string, format: date }
 *               autoRenew: { type: boolean }
 *     responses:
 *       200:
 *         description: Calculated subscription preview
 */
router.post('/preview', authorize(...staffRoles), tenantContext, controller.preview);

/**
 * @swagger
 * /subscriptions/staff:
 *   get:
 *     summary: Staff — list all subscriptions with filters
 *     tags: [Subscriptions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, ACTIVE, FROZEN, EXPIRED, CANCELLED] }
 *       - in: query
 *         name: branchId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: userId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated subscription list
 */
router.get('/staff', authorize(...staffRoles), tenantContext, controller.listForStaff);

/**
 * @swagger
 * /subscriptions/staff/{id}:
 *   get:
 *     summary: Staff — get subscription detail
 *     tags: [Subscriptions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Subscription detail with payment history
 *       404:
 *         description: Subscription not found
 */
router.get('/staff/:id', authorize(...staffRoles), tenantContext, controller.getForStaff);

module.exports = router;
