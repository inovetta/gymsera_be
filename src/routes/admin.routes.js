const { Router } = require('express');
const { body, param, query } = require('express-validator');
const adminController     = require('../controllers/admin.controller');
const reportsController   = require('../controllers/reports.controller');
const discoveryController = require('../controllers/discovery.controller');
const discoveryValidators = require('../validators/discovery.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');

const router = Router();

// All admin routes require authentication + PLATFORM_ADMIN role
router.use(authenticate, authorize('PLATFORM_ADMIN'));

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Platform administration — tenant review and management
 */

/**
 * @swagger
 * /admin/tenants:
 *   get:
 *     summary: List all tenants (paginated, filterable by status)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING_REVIEW, UNDER_REVIEW, APPROVED, REJECTED, SUSPENDED, ACTIVE]
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated list of tenants
 */
router.get('/tenants', adminController.listTenants);

/**
 * @swagger
 * /admin/tenants/{id}:
 *   get:
 *     summary: Get full tenant detail
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Tenant detail
 *       404:
 *         description: Tenant not found
 */
router.get('/tenants/:id', adminController.getTenant);

/**
 * @swagger
 * /admin/tenants/{id}/approve:
 *   post:
 *     summary: Approve a tenant and trigger database provisioning
 *     description: Sets tenant status to APPROVED and enqueues a Bull job to provision the tenant MySQL database. The status moves to ACTIVE once provisioning completes.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Tenant approved, provisioning queued
 *       400:
 *         description: Tenant is not in a reviewable state
 *       404:
 *         description: Tenant not found
 */
router.post('/tenants/:id/approve', adminController.approveTenant);

/**
 * @swagger
 * /admin/tenants/{id}/reject:
 *   post:
 *     summary: Reject a tenant application
 *     description: Sets tenant status to REJECTED and sends a notification email to the gym host.
 *     tags: [Admin]
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
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for rejection (communicated to the gym host)
 *                 example: KYC documents are incomplete — please resubmit with a valid business license.
 *     responses:
 *       200:
 *         description: Tenant rejected and host notified
 *       400:
 *         description: Missing reason or tenant not in reviewable state
 *       404:
 *         description: Tenant not found
 */
router.post(
  '/tenants/:id/reject',
  validate([body('reason').trim().notEmpty().withMessage('Rejection reason is required')]),
  adminController.rejectTenant
);

/**
 * @swagger
 * /admin/reports/platform:
 *   get:
 *     summary: Platform-wide analytics summary (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Platform analytics
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         gyms:    { type: object }
 *                         members: { type: object }
 */
router.get('/reports/platform', reportsController.platformSummary);

// ─────────────────────────────────────────────────────────────────────────────
// Review moderation (admin)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/reviews:
 *   get:
 *     summary: List all gym reviews (admin moderation queue)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, APPROVED, REJECTED]
 *         description: Filter by review status (omit for all)
 *       - in: query
 *         name: gymListingId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated review list
 */
router.get('/reviews', discoveryController.adminListReviews);

/**
 * @swagger
 * /admin/reviews/{id}/moderate:
 *   post:
 *     summary: Approve or reject a review
 *     tags: [Admin]
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
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [approve, reject]
 *               adminNote:
 *                 type: string
 *                 maxLength: 300
 *     responses:
 *       200:
 *         description: Review status updated; gym averageRating recalculated on approve
 *       404:
 *         description: Review not found
 */
router.post(
  '/reviews/:id/moderate',
  validate(discoveryValidators.moderateReview),
  discoveryController.moderateReview
);

module.exports = router;
