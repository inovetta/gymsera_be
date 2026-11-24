const { Router } = require('express');
const { body, param, query } = require('express-validator');
const adminController     = require('../controllers/admin.controller');
const reportsController   = require('../controllers/reports.controller');
const discoveryController = require('../controllers/discovery.controller');
const discoveryValidators = require('../validators/discovery.validator');
const moderationController = require('../controllers/moderation.controller');
const moderationValidators = require('../validators/moderation.validator');
const gymsValidators = require('../validators/gyms.validator');
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
 * /admin/organizations:
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
  '/organizations',
  validate.strict([
    body('ownerEmail').trim().toLowerCase().notEmpty().isEmail().withMessage('Valid owner email is required'),
    body('ownerFullName').trim().notEmpty().withMessage('Owner full name is required'),
    body('ownerPhone').optional({ nullable: true }).trim(),
    body('organizationName').trim().notEmpty().withMessage('Business name is required'),
    body('email').trim().toLowerCase().notEmpty().isEmail().withMessage('Valid business email is required'),
    body('phone').optional({ nullable: true }).trim(),
    body('cityId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Invalid city ID'),
    body('packageId').optional({ nullable: true }).isUUID().withMessage('Invalid package ID'),
  ], { stage: 2 }),
  adminController.createTenant
);

router.get('/organizations', adminController.listTenants);

/**
 * @swagger
 * /admin/organizations/{id}:
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
router.get('/organizations/:organizationId', adminController.getTenant);

/**
 * @swagger
 * /admin/organizations/{id}/approve:
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
router.post('/organizations/:organizationId/approve', idempotency(), validate.allowBody(['photosChecked']), adminController.approveTenant);
// R-84 (NEW-158): take a photo off an application before approving it (audited).
router.delete(
  '/organizations/:organizationId/approval-photos',
  validate.strict([body('imageUrl').isString().trim().notEmpty().withMessage('imageUrl is required')], { stage: 2 }),
  adminController.removeApprovalPhoto
);

/**
 * @swagger
 * /admin/organizations/{id}/reject:
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
  '/organizations/:organizationId/reject',
  validate.strict([body('reason').trim().notEmpty().withMessage('Rejection reason is required')], { stage: 2 }),
  adminController.rejectTenant
);

/**
 * @swagger
 * /admin/organizations/{id}/suspend:
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
  '/organizations/:organizationId/suspend',
  validate.strict([body('reason').trim().notEmpty().withMessage('Suspension reason is required')], { stage: 2 }),
  adminController.suspendTenant
);

router.post('/organizations/:organizationId/reactivate', validate.allowBody([]), adminController.reactivateTenant);

router.get('/organizations/:organizationId/branches', adminController.getTenantBranches);

router.patch(
  '/organizations/:organizationId/branches/:branchId/status',
  validate.strict([
    body('status').isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED']).withMessage('status must be ACTIVE, INACTIVE, or SUSPENDED'),
    body('reason').optional({ nullable: true }).trim(),
  ], { stage: 2 }),
  adminController.updateTenantBranchStatus
);

router.post(
  '/organizations/:organizationId/branches/:branchId/suspend',
  validate.strict([body('reason').trim().notEmpty().withMessage('Suspension reason is required')], { stage: 2 }),
  adminController.suspendTenantBranch
);

router.post(
  '/organizations/:organizationId/branches/:branchId/unsuspend',
  validate.allowBody([]), adminController.unsuspendTenantBranch
);

router.delete(
  '/organizations/:organizationId/branches/:branchId',
  validate.allowBody(['confirmBusinessDeletion']), adminController.deleteTenantBranch
);

router.get('/organizations/:organizationId/members', adminController.getTenantMembers);
// SEC-17: the only way to see a member's full e-mail and phone; every call is audited.
router.post('/organizations/:organizationId/members/:userId/reveal', validate.allowBody(['reason']), adminController.revealTenantMemberContact);

router.get('/organizations/:organizationId/membership-plans', adminController.getTenantMembershipPlans);

// ── Tenant image uploads ───────────────────────────────────────────────────────
router.post('/organizations/:organizationId/first-business/logo', upload.image('logo'), upload.handleMulterError, validate.allowBody([]), adminController.uploadTenantLogo);
router.post('/organizations/:organizationId/first-business/cover', upload.image('cover'), upload.handleMulterError, validate.allowBody([]), adminController.uploadTenantCover);

// ── NEW-265 Part A (A6): area requests (CMS › Cities & Areas › Unmatched areas) ─────
const areaRequestsController = require('../controllers/area-requests.controller');
const areaRequestIdParam = param('id').isInt({ min: 1 }).withMessage('Invalid area request id');
router.get('/area-requests', validate([
  query('status').optional().isIn(['pending_review', 'approved', 'merged', 'rejected']).withMessage('Unknown status'),
  query('cityId').optional().isInt({ min: 1 }),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('limit must be between 1 and 50'),
]), areaRequestsController.list);
router.post('/area-requests/:id/approve', validate.strict([
  areaRequestIdParam,
  body('name').optional().isString(),
  body('latitude').optional({ nullable: true }),
  body('longitude').optional({ nullable: true }),
  body('applyToGroup').optional().isBoolean(),
]), areaRequestsController.approve);
router.post('/area-requests/:id/merge', validate.strict([
  areaRequestIdParam,
  body('areaId').isInt({ min: 1 }).withMessage('areaId must be a positive integer'),
  body('applyToGroup').optional().isBoolean(),
]), areaRequestsController.merge);
router.post('/area-requests/:id/reject', validate.strict([
  areaRequestIdParam,
  body('reason').optional().isString(),
  body('applyToGroup').optional().isBoolean(),
]), areaRequestsController.reject);
router.post('/area-requests/:id/retry', validate.strict([areaRequestIdParam]), areaRequestsController.retry);
router.get('/areas/:areaId/aliases', validate([param('areaId').isInt({ min: 1 })]), areaRequestsController.listAliases);
router.delete('/area-aliases/:id', validate.strict([param('id').isInt({ min: 1 })]), areaRequestsController.deleteAlias);

// ── Gym listing management ─────────────────────────────────────────────────────
router.get('/businesses/:businessId', adminController.getGymListing);
router.post('/organizations/:organizationId/businesses', validate.allowBody(['name', 'description', 'genderType', 'contactPhone', 'website', 'cityId', 'areaId', 'latitude', 'longitude', 'facilitiesJson']), adminController.createGymListing);
router.patch('/businesses/:businessId', validate.allowBody(['name', 'description', 'genderType', 'contactPhone', 'website', 'cityId', 'areaId', 'latitude', 'longitude', 'facilitiesJson', 'isFeatured', 'status']), adminController.updateGymListing);
router.post('/businesses/:businessId/logo', upload.image('logo'), upload.handleMulterError, validate.allowBody([]), adminController.uploadGymListingLogo);
router.post('/businesses/:businessId/cover', upload.image('cover'), upload.handleMulterError, validate.allowBody([]), adminController.uploadGymListingCover);
router.post('/businesses/:businessId/images', upload.images('images', 10), upload.handleMulterError, validate.allowBody([]), adminController.uploadGymListingImages);
router.delete('/businesses/:businessId/images', validate.allowBody(['imageUrl']), adminController.deleteGymListingImage);

// ── Admin branch management ────────────────────────────────────────────────────
// NEW-140 (P9): the CMS admin form picks the place from Google through /places, like the host forms;
// the location fields get the host routes' range and place-id rules (gyms.validator.js branchLocation).
router.post(
  '/organizations/:organizationId/branches',
  validate.strict(gymsValidators.adminBranchLocation, { stage: 2, allow: ['facilities', 'businessId', 'branchName', 'timezone', 'currency', 'address', 'phone', 'openingTime', 'closingTime', 'hours', 'facilitiesJson', 'imagesJson', 'tagline', 'category', 'description', 'establishedYear', 'floorArea', 'addressLine1', 'addressLine2', 'postalCode', 'packages'] }),
  adminController.createAdminTenantBranch
);
router.patch(
  '/organizations/:organizationId/branches/:branchId',
  validate.strict(gymsValidators.adminBranchLocation, { stage: 2, allow: ['branchName', 'address', 'phone', 'openingTime', 'closingTime', 'hours', 'facilitiesJson', 'status', 'facilities'] }),
  adminController.updateAdminTenantBranch
);
router.post('/organizations/:organizationId/branches/:branchId/images', upload.images('images', 10), upload.handleMulterError, validate.allowBody([]), adminController.uploadAdminBranchImages);
router.delete('/organizations/:organizationId/branches/:branchId/images', validate.allowBody(['imageUrl']), adminController.deleteAdminBranchImage);
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
    query('organizationId')
      .optional()
      .custom((v) => v === 'none' || /^[0-9a-fA-F-]{36}$/.test(String(v)))
      .withMessage('organizationId must be a tenant id or "none"'),
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
    query('organizationId').optional().matches(ID36).withMessage('organizationId must be a tenant id'),
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
router.get('/organizations/:organizationId/subscriptions', adminController.getTenantSubscriptions);

// Read-only capacity integrity report — does this tenant's reservedSlots
// agree with the capacity_events ledger, and does overQuotaCount match
// reality? Reports only; repairing is a deliberate human decision.
router.get('/organizations/:organizationId/capacity-audit', adminController.getTenantCapacityAudit);
router.post(
  '/organizations/:organizationId/subscriptions',
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
router.patch('/organizations/:organizationId/subscriptions/:subId/revoke', validate.allowBody([]), adminController.revokeTenantSubscription);
// Pay later (BILL-13): confirm the bank transfer → the GRACE plan becomes ACTIVE (audited).
router.post(
  '/organizations/:organizationId/subscriptions/:subId/verify-payment',
  validate.strict([body('bankTransferRef').optional({ nullable: true }).isString().isLength({ max: 100 })], { stage: 2 }),
  adminController.verifyPayLaterPayment
);

// ── Host plan payments by bank transfer (P9c item D, R-95) ─────────────────────
const planPaymentsController = require('../controllers/plan-payments.controller');
router.get('/plan-payments', planPaymentsController.adminList);
router.get('/plan-payments/:id/proof', planPaymentsController.adminProof);
router.post('/plan-payments/:id/approve', validate.allowBody([], { stage: 1 }), planPaymentsController.adminApprove);
router.post('/plan-payments/:id/reject', validate.allowBody(['reason'], { stage: 1 }), planPaymentsController.adminReject);

// ── Tenant platform invoices ───────────────────────────────────────────────────
router.get('/organizations/:organizationId/invoices', adminController.getTenantInvoices);
router.post(
  '/organizations/:organizationId/invoices',
  validate.strict([
    body('subtotal').isFloat({ min: 0 }).withMessage('Subtotal must be a positive number'),
    body('dueDate').optional().isISO8601().withMessage('Invalid due date'),
    body('taxAmount').optional().isFloat({ min: 0 }),
    body('status').optional().isIn(['DRAFT', 'ISSUED', 'PAID', 'OVERDUE', 'CANCELLED']),
    // SEC-06: read by admin.service#createTenantInvoice
    body('organizationSubscriptionId').optional({ nullable: true }).isUUID(4),
    body('description').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('notes').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  ], { stage: 2 }),
  adminController.createTenantInvoice
);
router.patch(
  '/organizations/:organizationId/invoices/:invoiceId',
  validate.strict([
    body('status').optional().isIn(['DRAFT', 'ISSUED', 'PAID', 'OVERDUE', 'CANCELLED']),
    body('dueDate').optional().isISO8601(),
    // SEC-06: read by admin.service#updateTenantInvoice
    body('notes').optional({ nullable: true }).isString().isLength({ max: 2000 }),
    body('paidAt').optional({ nullable: true }).isISO8601(),
  ], { stage: 2 }),
  adminController.updateTenantInvoice
);
router.post('/organizations/:organizationId/invoices/:invoiceId/send-reminder', validate.allowBody([]), adminController.sendInvoiceReminder);
router.post('/organizations/:organizationId/invoices/:invoiceId/send-confirmation', validate.allowBody([]), adminController.sendInvoiceConfirmation);

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
router.delete('/organizations/:organizationId', validate.allowBody([]), adminController.deleteTenant);

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
 *         name: businessId
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
// NEW-256: content reports (CMS: Moderation › Reports) and the word list (Moderation › Word list).
// Platform admins only (router-level authorize above). Target response time: 24 hours.
router.get('/reports', validate(moderationValidators.adminList), moderationController.adminListReports);
router.get('/reports/:id', validate(moderationValidators.adminGet), moderationController.adminGetReport);
router.patch('/reports/:id', validate.strict(moderationValidators.adminAct), moderationController.adminActOnReport);
router.get('/moderation/words', moderationController.adminGetWords);
router.put('/moderation/words', validate.strict(moderationValidators.replaceWords), moderationController.adminReplaceWords);

// Alias: PATCH /admin/reviews/:id/moderate (CMS uses PATCH)
router.patch(
  '/reviews/:id/moderate',
  validate.strict(discoveryValidators.moderateReview, { stage: 2 }),
  discoveryController.moderateReview
);

module.exports = router;
