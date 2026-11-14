const { Router } = require('express');
const controller = require('../controllers/subscriptions.controller');
const validators = require('../validators/subscriptions.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const tenantContext = require('../middleware/tenantContext');
const can = require('../middleware/can');
const upload = require('../middleware/upload');
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
router.post('/', validate.strict(validators.subscribe), controller.subscribe);

/**
 * @swagger
 * /subscriptions/quote:
 *   get:
 *     summary: What POST /subscriptions will charge for this plan and branch (Phase 7 P7a)
 *     tags: [Subscriptions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: planId, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: gymListingId, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: branchId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: price, joiningFee (0 when waived), securityFee, totalPrice, currency
 *       404:
 *         description: Plan or branch not found
 *       409:
 *         description: gym_not_bookable (the gym is not live for travellers)
 */
router.get('/quote', validate(validators.quote), controller.quote);

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
router.post('/:id/freeze', validate.strict(validators.freeze), controller.freeze);

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
router.post('/:id/cancel', validate.strict(validators.cancel), controller.cancel);

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
router.post('/:id/renew', validate.strict(validators.renew), controller.renew);
router.post('/:id/change-plan', validate.strict(validators.changePlan), controller.changePlan);

// ── Member: subscription detail with invoice + payment ────────────────────────
router.get('/:id/detail', controller.getMySubscriptionDetail);

/**
 * @swagger
 * /subscriptions/{id}/refund-request:
 *   get:
 *     summary: Member — may I ask for a refund of this subscription, and my request if any (NEW-253)
 *     tags: [Subscriptions]
 *     responses:
 *       200: { description: "{ refundsAllowed, canRequest, reasonCode, suggestedAmount, currency, windowEndsAt, request }" }
 *   post:
 *     summary: Member — ask for a refund of my cancelled subscription (one per subscription; the gym decides)
 *     tags: [Subscriptions]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { reason: { type: string, maxLength: 500 } } }
 *     responses:
 *       201: { description: Requested }
 *       200: { description: "Same pending request (duplicate: true)" }
 *       409: { description: "not_cancelled / refund_already_requested" }
 *       422: { description: "refunds_disabled / no_refundable_payment / already_refunded / refund_window_closed" }
 */
router.get('/:id/refund-request', validate(validators.cancel), controller.myRefundStatus);
router.post('/:id/refund-request', validate.strict(validators.refundRequest), controller.requestMyRefund);
router.get('/:id/qr-token', controller.getSubscriptionQrToken);

// ── Member: upload payment proof for a pending subscription ───────────────────
router.post('/:id/proof', upload.image('image'), upload.handleMulterError, validate.allowBody([]), controller.uploadSubscriptionProof);

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
router.post('/preview', tenantContext, authorize(...staffRoles), validate.allowBody(['planId', 'startDate', 'autoRenew', 'branchId']), controller.preview);

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
// NEW-49: listing needs subscriptions.view at one or more branches.
router.get('/staff', tenantContext, authorize(...staffRoles), can.atAnyBranch('subscriptions.view'), controller.listForStaff);

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
/**
 * @swagger
 * /subscriptions/staff/refund-requests:
 *   get:
 *     summary: Staff — members' refund requests at the branches the caller sees (NEW-253); ?status=PENDING&branchId=
 *     tags: [Subscriptions]
 * /subscriptions/staff/refund-requests/{requestId}/decide:
 *   post:
 *     summary: Staff with a direct payments.refund — APPROVE (the refund, optional lower amount) or REJECT
 *     tags: [Subscriptions]
 *     responses:
 *       403: { description: refund_not_permitted }
 *       409: { description: refund_request_decided }
 * /subscriptions/staff/refund-policy:
 *   get:
 *     summary: The gym's refund policy { refundsAllowed, refundWindowDays } (?branchId= picks the gym)
 *     tags: [Subscriptions]
 *   put:
 *     summary: Change it (direct payments.refund; Owner / Org admin by default)
 *     tags: [Subscriptions]
 */
router.get('/staff/refund-requests', tenantContext, authorize(...staffRoles), can.atAnyBranch('subscriptions.view'), controller.listRefundRequests);
router.post('/staff/refund-requests/:requestId/decide', tenantContext, authorize(...staffRoles), validate.strict(validators.decideRefund), controller.decideRefundRequest);
router.get('/staff/refund-policy', tenantContext, authorize(...staffRoles), controller.getRefundPolicy);
router.put('/staff/refund-policy', tenantContext, authorize(...staffRoles), validate.strict(validators.refundPolicy), controller.updateRefundPolicy);
router.get('/staff/:id', tenantContext, authorize(...staffRoles), controller.getForStaff);

/**
 * @swagger
 * /subscriptions/staff/{id}/activate:
 *   post:
 *     summary: Staff — manually activate a PENDING subscription (bypass payment)
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
 *         description: Subscription activated
 *       409:
 *         description: Already active or cancelled
 */
router.post('/staff/:id/activate', tenantContext, authorize(...staffRoles), validate.allowBody([]), controller.activateSubscription);
router.post('/staff', tenantContext, authorize(...staffRoles), validate.allowBody(['branchId', 'notes', 'paymentMethod', 'planId', 'startDate', 'userId']), controller.createStaffSubscription);

/**
 * @swagger
 * /subscriptions/staff/{id}/freeze:
 *   post:
 *     summary: Staff — freeze a member's ACTIVE subscription (approval command subscriptions.pause, NEW-250)
 *     description: The end date moves by the frozen days, up to the plan's freeze limit. Optional Idempotency-Key header.
 *     tags: [Subscriptions]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: "Frozen: { status: EXECUTED, subscription }" }
 *       202: { description: "Sent for approval: { status: PENDING, requestId }" }
 *       403: { description: No subscriptions.pause at the subscription's branch }
 *       404: { description: No such subscription in the caller's tenant, or a branch the caller cannot see }
 *       409: { description: Not ACTIVE }
 * /subscriptions/staff/{id}/cancel:
 *   post:
 *     summary: Staff — cancel a member's subscription at once (approval command subscriptions.cancel, NEW-250)
 *     tags: [Subscriptions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refund: { type: boolean, description: "NEW-253: also return the payment (needs payments.refund and the gym's refund policy on)" }
 *               refundAmount: { type: number, description: "Default: the suggested prorated amount; at most the refundable balance" }
 *               refundReason: { type: string, maxLength: 500 }
 *     responses:
 *       200: { description: "Cancelled: { status: EXECUTED, subscription, refund?: { status: EXECUTED | PENDING } }" }
 *       202: { description: "Sent for approval: { status: PENDING, requestId }" }
 *       403: { description: No subscriptions.cancel at the subscription's branch }
 *       404: { description: No such subscription in the caller's tenant, or a branch the caller cannot see }
 *       409: { description: Already cancelled or expired }
 */
router.post('/staff/:id/freeze', tenantContext, authorize(...staffRoles), validate.strict(validators.freeze), controller.staffFreeze);
router.post('/staff/:id/cancel', tenantContext, authorize(...staffRoles), validate.strict(validators.staffCancel), controller.staffCancel);
// NEW-253: what the cancel dialog may offer (policy, suggested and maximum refund, the caller's refund tier).
router.get('/staff/:id/refund-quote', tenantContext, authorize(...staffRoles), validate(validators.cancel), controller.staffRefundQuote);

module.exports = router;
