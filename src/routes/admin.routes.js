const { Router } = require('express');
const { body, param, query } = require('express-validator');
const adminController     = require('../controllers/admin.controller');
const reportsController   = require('../controllers/reports.controller');
const discoveryController = require('../controllers/discovery.controller');
const discoveryValidators = require('../validators/discovery.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const upload = require('../middleware/upload');

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
router.post(
  '/tenants',
  validate([
    body('ownerEmail').trim().toLowerCase().notEmpty().isEmail().withMessage('Valid owner email is required'),
    body('ownerFullName').trim().notEmpty().withMessage('Owner full name is required'),
    body('ownerPhone').optional({ nullable: true }).trim(),
    body('businessName').trim().notEmpty().withMessage('Business name is required'),
    body('email').trim().toLowerCase().notEmpty().isEmail().withMessage('Valid business email is required'),
    body('phone').optional({ nullable: true }).trim(),
    body('cityId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Invalid city ID'),
    body('packageId').optional({ nullable: true }).isUUID().withMessage('Invalid package ID'),
  ]),
  adminController.createTenant
);

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
 * /admin/tenants/{id}/suspend:
 *   post:
 *     summary: Suspend an active tenant
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
 *                 example: Repeated violations of platform terms.
 *     responses:
 *       200:
 *         description: Tenant suspended
 *       400:
 *         description: Tenant is not active or reason is missing
 *       404:
 *         description: Tenant not found
 */
router.post(
  '/tenants/:id/suspend',
  validate([body('reason').trim().notEmpty().withMessage('Suspension reason is required')]),
  adminController.suspendTenant
);

router.post('/tenants/:id/reactivate', adminController.reactivateTenant);

router.get('/tenants/:id/branches', adminController.getTenantBranches);

router.patch(
  '/tenants/:id/branches/:branchId/status',
  validate([body('status').isIn(['ACTIVE', 'INACTIVE']).withMessage('status must be ACTIVE or INACTIVE')]),
  adminController.updateTenantBranchStatus
);

router.get('/tenants/:id/members', adminController.getTenantMembers);

router.get('/tenants/:id/membership-plans', adminController.getTenantMembershipPlans);

// ── Tenant image uploads ───────────────────────────────────────────────────────
router.post('/tenants/:id/logo', upload.image('logo'), upload.handleMulterError, adminController.uploadTenantLogo);
router.post('/tenants/:id/cover', upload.image('cover'), upload.handleMulterError, adminController.uploadTenantCover);

// ── Gym listing management ─────────────────────────────────────────────────────
router.get('/tenants/:id/gym-listing', adminController.getGymListing);
router.post('/tenants/:id/gym-listing', adminController.createGymListing);
router.patch('/tenants/:id/gym-listing', adminController.updateGymListing);
router.post('/tenants/:id/gym-listing/logo', upload.image('logo'), upload.handleMulterError, adminController.uploadGymListingLogo);
router.post('/tenants/:id/gym-listing/cover', upload.image('cover'), upload.handleMulterError, adminController.uploadGymListingCover);
router.post('/tenants/:id/gym-listing/images', upload.images('images', 10), upload.handleMulterError, adminController.uploadGymListingImages);
router.delete('/tenants/:id/gym-listing/images', adminController.deleteGymListingImage);

// ── Admin branch management ────────────────────────────────────────────────────
router.post('/tenants/:id/branches', adminController.createAdminTenantBranch);
router.patch('/tenants/:id/branches/:branchId', adminController.updateAdminTenantBranch);
router.post('/tenants/:id/branches/:branchId/images', upload.images('images', 10), upload.handleMulterError, adminController.uploadAdminBranchImages);
router.delete('/tenants/:id/branches/:branchId/images', adminController.deleteAdminBranchImage);
router.patch(
  '/branches/:branchId/traveler-visibility',
  validate([
    body('status').isIn(['active', 'deactivated']).withMessage('status must be active or deactivated'),
    body('reason').optional({ nullable: true }).trim(),
  ]),
  adminController.updateBranchTravelerVisibility
);

router.get(
  '/branches/:branchId/traveler-visibility/history',
  adminController.getBranchVisibilityHistory
);

// ── Tenant subscriptions ───────────────────────────────────────────────────────
router.get('/tenants/:id/subscriptions', adminController.getTenantSubscriptions);
router.post(
  '/tenants/:id/subscriptions',
  validate([
    body('packageId').isUUID().withMessage('Valid package ID is required'),
    body('startDate').optional().isISO8601().withMessage('Invalid start date'),
    body('billingCycle').optional().isIn(['MONTHLY', 'QUARTERLY', 'YEARLY']),
    body('amount').optional().isFloat({ min: 0 }),
    body('autoRenew').optional().isBoolean(),
    body('createInvoice').optional().isBoolean(),
  ]),
  adminController.assignTenantSubscription
);
router.patch('/tenants/:id/subscriptions/:subId/revoke', adminController.revokeTenantSubscription);

// ── Tenant platform invoices ───────────────────────────────────────────────────
router.get('/tenants/:id/invoices', adminController.getTenantInvoices);
router.post(
  '/tenants/:id/invoices',
  validate([
    body('subtotal').isFloat({ min: 0 }).withMessage('Subtotal must be a positive number'),
    body('dueDate').optional().isISO8601().withMessage('Invalid due date'),
    body('taxAmount').optional().isFloat({ min: 0 }),
    body('status').optional().isIn(['DRAFT', 'ISSUED', 'PAID', 'OVERDUE', 'CANCELLED']),
  ]),
  adminController.createTenantInvoice
);
router.patch(
  '/tenants/:id/invoices/:invoiceId',
  validate([
    body('status').optional().isIn(['DRAFT', 'ISSUED', 'PAID', 'OVERDUE', 'CANCELLED']),
    body('dueDate').optional().isISO8601(),
  ]),
  adminController.updateTenantInvoice
);
router.post('/tenants/:id/invoices/:invoiceId/send-reminder', adminController.sendInvoiceReminder);
router.post('/tenants/:id/invoices/:invoiceId/send-confirmation', adminController.sendInvoiceConfirmation);

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

// ── Delete tenant ─────────────────────────────────────────────────────────────
router.delete('/tenants/:id', adminController.deleteTenant);

// ── Manual subscription sync ──────────────────────────────────────────────────
router.post('/subscriptions/sync', adminController.syncSubscriptions);

// ── Platform stats & analytics ────────────────────────────────────────────────
router.get('/stats', adminController.getPlatformStats);
router.get('/analytics', adminController.getPlatformAnalytics);

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
// Alias: PATCH /admin/reviews/:id/moderate (CMS uses PATCH)
router.patch(
  '/reviews/:id/moderate',
  validate(discoveryValidators.moderateReview),
  discoveryController.moderateReview
);

module.exports = router;
