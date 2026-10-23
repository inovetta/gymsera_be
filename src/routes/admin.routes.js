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
const idempotency = require('../middleware/idempotency');

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
  validate.strict([
    body('ownerEmail').trim().toLowerCase().notEmpty().isEmail().withMessage('Valid owner email is required'),
    body('ownerFullName').trim().notEmpty().withMessage('Owner full name is required'),
    body('ownerPhone').optional({ nullable: true }).trim(),
    body('businessName').trim().notEmpty().withMessage('Business name is required'),
    body('email').trim().toLowerCase().notEmpty().isEmail().withMessage('Valid business email is required'),
    body('phone').optional({ nullable: true }).trim(),
    body('cityId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Invalid city ID'),
    body('packageId').optional({ nullable: true }).isUUID().withMessage('Invalid package ID'),
  ], { stage: 2 }),
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
 *     summary: Approve a tenant and provision it (resumable, FLOW-02)
 *     description: Sets tenant status to APPROVED and provisions the tenant database in six recorded steps. Calling it again on an APPROVED tenant resumes from the last finished step.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema: { type: string, maxLength: 128 }
 *         description: One key per approve/resume click; a repeat replays the first answer.
 *     responses:
 *       200:
 *         description: Tenant provisioned and ACTIVE (data.provisioning.step = 6)
 *       202:
 *         description: Another run is provisioning this tenant; data.provisioning has its step
 *       400:
 *         description: Tenant is not in a reviewable state
 *       404:
 *         description: Tenant not found
 *       502:
 *         description: A provisioning step failed; the tenant stays APPROVED and can be resumed
 */
router.post('/tenants/:id/approve', idempotency(), validate.allowBody([]), adminController.approveTenant);

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
  validate.strict([body('reason').trim().notEmpty().withMessage('Rejection reason is required')], { stage: 2 }),
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
  validate.strict([body('reason').trim().notEmpty().withMessage('Suspension reason is required')], { stage: 2 }),
  adminController.suspendTenant
);

router.post('/tenants/:id/reactivate', validate.allowBody([]), adminController.reactivateTenant);

router.get('/tenants/:id/branches', adminController.getTenantBranches);

router.patch(
  '/tenants/:id/branches/:branchId/status',
  validate.strict([
    body('status').isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED']).withMessage('status must be ACTIVE, INACTIVE, or SUSPENDED'),
    body('reason').optional({ nullable: true }).trim(),
  ], { stage: 2 }),
  adminController.updateTenantBranchStatus
);

router.post(
  '/tenants/:id/branches/:branchId/suspend',
  validate.strict([body('reason').trim().notEmpty().withMessage('Suspension reason is required')], { stage: 2 }),
  adminController.suspendTenantBranch
);

router.post(
  '/tenants/:id/branches/:branchId/unsuspend',
  validate.allowBody([]), adminController.unsuspendTenantBranch
);

router.delete(
  '/tenants/:id/branches/:branchId',
  validate.allowBody(['confirmOrganizationDeletion']), adminController.deleteTenantBranch
);

router.get('/tenants/:id/members', adminController.getTenantMembers);
// SEC-17: the only way to see a member's full e-mail and phone; every call is audited.
router.post('/tenants/:id/members/:userId/reveal', validate.allowBody(['reason']), adminController.revealTenantMemberContact);

router.get('/tenants/:id/membership-plans', adminController.getTenantMembershipPlans);

// ── Tenant image uploads ───────────────────────────────────────────────────────
router.post('/tenants/:id/logo', upload.image('logo'), upload.handleMulterError, validate.allowBody([]), adminController.uploadTenantLogo);
router.post('/tenants/:id/cover', upload.image('cover'), upload.handleMulterError, validate.allowBody([]), adminController.uploadTenantCover);

// ── Gym listing management ─────────────────────────────────────────────────────
router.get('/tenants/:id/gym-listing', adminController.getGymListing);
router.post('/tenants/:id/gym-listing', validate.allowBody(['title', 'shortDescription', 'genderType', 'contactPhone', 'website', 'cityId', 'areaId', 'latitude', 'longitude', 'facilitiesJson']), adminController.createGymListing);
router.patch('/tenants/:id/gym-listing', validate.allowBody(['title', 'shortDescription', 'genderType', 'contactPhone', 'website', 'cityId', 'areaId', 'latitude', 'longitude', 'facilitiesJson', 'isFeatured', 'status']), adminController.updateGymListing);
router.post('/tenants/:id/gym-listing/logo', upload.image('logo'), upload.handleMulterError, validate.allowBody([]), adminController.uploadGymListingLogo);
router.post('/tenants/:id/gym-listing/cover', upload.image('cover'), upload.handleMulterError, validate.allowBody([]), adminController.uploadGymListingCover);
router.post('/tenants/:id/gym-listing/images', upload.images('images', 10), upload.handleMulterError, validate.allowBody([]), adminController.uploadGymListingImages);
router.delete('/tenants/:id/gym-listing/images', validate.allowBody(['imageUrl']), adminController.deleteGymListingImage);

// ── Admin branch management ────────────────────────────────────────────────────
router.post('/tenants/:id/branches', validate.allowBody(['facilities', 'gymListingId', 'branchName', 'timezone', 'currency', 'address', 'cityId', 'areaId', 'latitude', 'longitude', 'phone', 'openingTime', 'closingTime', 'facilitiesJson', 'imagesJson', 'tagline', 'category', 'description', 'establishedYear', 'floorArea', 'addressLine1', 'addressLine2', 'postalCode', 'packages']), adminController.createAdminTenantBranch);
router.patch('/tenants/:id/branches/:branchId', validate.allowBody(['branchName', 'address', 'cityId', 'areaId', 'phone', 'openingTime', 'closingTime', 'facilitiesJson', 'status', 'facilities', 'latitude', 'longitude']), adminController.updateAdminTenantBranch);
router.post('/tenants/:id/branches/:branchId/images', upload.images('images', 10), upload.handleMulterError, validate.allowBody([]), adminController.uploadAdminBranchImages);
router.delete('/tenants/:id/branches/:branchId/images', validate.allowBody(['imageUrl']), adminController.deleteAdminBranchImage);
router.patch(
  '/branches/:branchId/traveler-visibility',
  validate.strict([
    body('status').isIn(['active', 'deactivated']).withMessage('status must be active or deactivated'),
    body('reason').optional({ nullable: true }).trim(),
  ], { stage: 2 }),
  adminController.updateBranchTravelerVisibility
);

router.get(
  '/branches/:branchId/traveler-visibility/history',
  adminController.getBranchVisibilityHistory
);

// ── Billing events (OBS-05): the webhook/RTDN inbox, per tenant and status ─────
router.get(
  '/billing-events',
  validate([
    query('status').optional().isIn(['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED']).withMessage('Invalid status'),
    query('provider').optional().isIn(['APPLE', 'GOOGLE', 'STRIPE']).withMessage('Invalid provider'),
    query('tenantId')
      .optional()
      .custom((v) => v === 'none' || /^[0-9a-fA-F-]{36}$/.test(String(v)))
      .withMessage('tenantId must be a tenant id or "none"'),
  ]),
  adminController.listBillingEvents
);

// ── Platform audit trails (OBS-07): admin actions, or the HTTP mutation trail with ?source=requests ──
const ID36 = /^[0-9a-fA-F-]{36}$/;
router.get(
  '/audit-logs',
  validate([
    query('source').optional().isIn(['actions', 'requests']).withMessage('source must be actions or requests'),
    query('userId').optional().matches(ID36).withMessage('userId must be a user id'),
    query('tenantId').optional().matches(ID36).withMessage('tenantId must be a tenant id'),
    query('action').optional().isString().isLength({ max: 100 }).withMessage('action is too long'),
    query('targetType').optional().isString().isLength({ max: 50 }).withMessage('targetType is too long'),
    query('targetId').optional().isString().isLength({ max: 100 }).withMessage('targetId is too long'),
    query('method').optional().isIn(['POST', 'PUT', 'PATCH', 'DELETE']).withMessage('Invalid method'),
    query('from').optional().isISO8601().withMessage('from must be an ISO date'),
    query('to').optional().isISO8601().withMessage('to must be an ISO date'),
  ]),
  adminController.listAuditLogs
);

// ── Tenant subscriptions ───────────────────────────────────────────────────────
router.get('/tenants/:id/subscriptions', adminController.getTenantSubscriptions);

// Read-only capacity integrity report — does this tenant's reservedSlots
// agree with the capacity_events ledger, and does overQuotaCount match
// reality? Reports only; repairing is a deliberate human decision.
router.get('/tenants/:id/capacity-audit', adminController.getTenantCapacityAudit);
router.post(
  '/tenants/:id/subscriptions',
  validate.strict([
    body('packageId').isUUID().withMessage('Valid package ID is required'),
    body('startDate').optional().isISO8601().withMessage('Invalid start date'),
    body('billingCycle').optional().isIn(['MONTHLY', 'QUARTERLY', 'YEARLY']),
    body('amount').optional().isFloat({ min: 0 }),
    body('autoRenew').optional().isBoolean(),
    body('createInvoice').optional().isBoolean(),
  ], { stage: 2 }),
  adminController.assignTenantSubscription
);
router.patch('/tenants/:id/subscriptions/:subId/revoke', validate.allowBody([]), adminController.revokeTenantSubscription);
// Pay later (BILL-13): confirm the bank transfer → the GRACE plan becomes ACTIVE (audited).
router.post(
  '/tenants/:id/subscriptions/:subId/verify-payment',
  validate.strict([body('bankTransferRef').optional({ nullable: true }).isString().isLength({ max: 100 })], { stage: 2 }),
  adminController.verifyPayLaterPayment
);

// ── Tenant platform invoices ───────────────────────────────────────────────────
router.get('/tenants/:id/invoices', adminController.getTenantInvoices);
router.post(
  '/tenants/:id/invoices',
  validate.strict([
    body('subtotal').isFloat({ min: 0 }).withMessage('Subtotal must be a positive number'),
    body('dueDate').optional().isISO8601().withMessage('Invalid due date'),
    body('taxAmount').optional().isFloat({ min: 0 }),
    body('status').optional().isIn(['DRAFT', 'ISSUED', 'PAID', 'OVERDUE', 'CANCELLED']),
    // SEC-06: read by admin.service#createTenantInvoice
    body('tenantSubscriptionId').optional({ nullable: true }).isUUID(4),
    body('description').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('notes').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  ], { stage: 2 }),
  adminController.createTenantInvoice
);
router.patch(
  '/tenants/:id/invoices/:invoiceId',
  validate.strict([
    body('status').optional().isIn(['DRAFT', 'ISSUED', 'PAID', 'OVERDUE', 'CANCELLED']),
    body('dueDate').optional().isISO8601(),
    // SEC-06: read by admin.service#updateTenantInvoice
    body('notes').optional({ nullable: true }).isString().isLength({ max: 2000 }),
    body('paidAt').optional({ nullable: true }).isISO8601(),
  ], { stage: 2 }),
  adminController.updateTenantInvoice
);
router.post('/tenants/:id/invoices/:invoiceId/send-reminder', validate.allowBody([]), adminController.sendInvoiceReminder);
router.post('/tenants/:id/invoices/:invoiceId/send-confirmation', validate.allowBody([]), adminController.sendInvoiceConfirmation);

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
router.delete('/tenants/:id', validate.allowBody([]), adminController.deleteTenant);

// ── Manual subscription sync ──────────────────────────────────────────────────
router.post('/subscriptions/sync', validate.allowBody([]), adminController.syncSubscriptions);

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
  validate.strict(discoveryValidators.moderateReview, { stage: 2 }),
  discoveryController.moderateReview
);
// Alias: PATCH /admin/reviews/:id/moderate (CMS uses PATCH)
router.patch(
  '/reviews/:id/moderate',
  validate.strict(discoveryValidators.moderateReview, { stage: 2 }),
  discoveryController.moderateReview
);

module.exports = router;
