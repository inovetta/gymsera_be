const { Router } = require('express');
const controller     = require('../controllers/payments.controller');
const validators     = require('../validators/payments.validator');
const validate       = require('../middleware/validate');
const authenticate   = require('../middleware/authenticate');
const authorize      = require('../middleware/authorize');
const tenantContext  = require('../middleware/tenantContext');
const upload         = require('../middleware/upload');

const router = Router();

// All payment routes require auth + tenant context
router.use(authenticate, authorize('GYM_HOST', 'BRANCH_MANAGER'), tenantContext);

/**
 * @swagger
 * tags:
 *   name: Payments
 *   description: Payment recording, verification, and invoicing
 */

/**
 * @swagger
 * /payments:
 *   post:
 *     summary: Record a payment for a member (cash / bank / card / wallet)
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, method, amount]
 *             properties:
 *               userId:               { type: string, format: uuid }
 *               paymentFor:
 *                 type: string
 *                 enum: [MEMBERSHIP, TRAINER, PRODUCT, OTHER]
 *               referenceEntityId:    { type: string, format: uuid }
 *               method:
 *                 type: string
 *                 enum: [CASH, BANK_TRANSFER, CARD, WALLET, ONLINE, POS, TEST]
 *                 description: Use TEST method with X-Test-Payment-Key header for dev/QA — auto-completes as paid
 *               gatewayName:          { type: string }
 *               gatewayTransactionId: { type: string }
 *               amount:               { type: number, minimum: 0.01 }
 *               currency:             { type: string, default: PKR }
 *               notes:                { type: string }
 *     parameters:
 *       - in: header
 *         name: X-Test-Payment-Key
 *         schema: { type: string }
 *         description: Required only when method is TEST (dev/QA env — matches PAYMENT_TEST_KEY env var)
 *     responses:
 *       201:
 *         description: Payment recorded; invoice auto-generated for membership payments
 */
router.post(
  '/',
  // TEST payment key guard — only enforced when method === TEST
  (req, _res, next) => {
    if (req.body && req.body.method === 'TEST') {
      const key = req.headers['x-test-payment-key'];
      const expected = process.env.PAYMENT_TEST_KEY;
      if (!expected || !key || key !== expected) {
        const err = new Error('Invalid or missing X-Test-Payment-Key header for TEST payment method');
        err.statusCode = 403;
        return next(err);
      }
    }
    next();
  },
  validate(validators.recordPayment),
  controller.recordPayment
);

/**
 * @swagger
 * /payments:
 *   get:
 *     summary: List payments for the gym (host/manager view)
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: branchId
 *         schema: { type: string, format: uuid }
 *         description: Filter by branch
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, STAFF_COLLECTED, COMPLETED, FAILED, REFUNDED] }
 *       - in: query
 *         name: method
 *         schema: { type: string, enum: [CASH, BANK_TRANSFER, CARD, WALLET] }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated list of payments
 */
router.get('/', validate(validators.listPayments), controller.listPayments);
router.get('/:id', controller.getPaymentById);

/**
 * @swagger
 * /payments/{id}/verify:
 *   post:
 *     summary: Tenant final approval — marks PENDING or STAFF_COLLECTED payment as COMPLETED (GYM_HOST only)
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Payment verified; linked invoice marked PAID; subscription activated
 *       403:
 *         description: Only gym host can verify payments
 *       409:
 *         description: Payment is not in a verifiable state
 */
router.post('/:id/verify', authorize('GYM_HOST'), validate(validators.verifyPayment), controller.verifyPayment);

/**
 * @swagger
 * /payments/{id}/action:
 *   post:
 *     summary: Act on a payment — collect (staff step 1), verify (tenant final step 2), or reject
 *     tags: [Payments]
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
 *                 enum: [collect, verify, reject]
 *                 description: |
 *                   collect — staff marks PENDING → STAFF_COLLECTED (step 1 of 2)
 *                   verify  — GYM_HOST only; PENDING or STAFF_COLLECTED → COMPLETED (step 2 of 2; activates subscription)
 *                   reject  — either role; marks as FAILED
 *               notes: { type: string }
 *               rejectedReason: { type: string }
 *     responses:
 *       200:
 *         description: Payment action applied
 *       403:
 *         description: Only gym host can verify payments
 */
router.post('/:id/action', controller.verifyOrReject);

/**
 * @swagger
 * /payments/{id}/proof:
 *   post:
 *     summary: Upload bank receipt / proof image for a payment
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
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
 *         description: Proof uploaded
 */
router.post('/:id/proof', upload.image('image'), upload.handleMulterError, controller.uploadProof);

/**
 * @swagger
 * /payments/collection-action:
 *   post:
 *     summary: Staff batch-marks PENDING payments as STAFF_COLLECTED (step 1 of 2-step verification)
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paymentIds]
 *             properties:
 *               paymentIds:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Payments marked as collected
 */
router.post('/collection-action', controller.collectionAction);

/**
 * @swagger
 * /invoices/{id}:
 *   get:
 *     summary: Get invoice detail
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Invoice detail
 *       404:
 *         description: Invoice not found
 */

module.exports = router;
