const { Router } = require('express');
const paymentsController = require('../controllers/payments.controller');
const paymentsValidators = require('../validators/payments.validator');
const validate           = require('../middleware/validate');
const authenticate       = require('../middleware/authenticate');
const tenantContext      = require('../middleware/tenantContext');

const router = Router();

// Invoice routes require auth + tenant context (member or host can view)
router.use(authenticate, tenantContext);

/**
 * @swagger
 * tags:
 *   name: Invoices
 *   description: Invoice retrieval — members see own invoices; hosts/managers see all
 */

/**
 * @swagger
 * /invoices:
 *   get:
 *     summary: List invoices (members see own; hosts/managers see all)
 *     tags: [Invoices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema: { type: string, format: uuid }
 *         description: Filter by member (host/manager only)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [ISSUED, PAID, CANCELLED, OVERDUE]
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *         description: Filter from date (YYYY-MM-DD)
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
 *         description: Paginated invoice list
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
 *                         invoices:
 *                           type: array
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         total: { type: integer }
 *                         page: { type: integer }
 *                         limit: { type: integer }
 *                         totalPages: { type: integer }
 */
router.get('/', paymentsController.listInvoices);

/**
 * @swagger
 * /invoices/{id}:
 *   get:
 *     summary: Get invoice detail (members see own invoices; host sees all)
 *     tags: [Invoices]
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
 *                         invoice:
 *                           type: object
 *                           properties:
 *                             id:           { type: string, format: uuid }
 *                             invoiceNo:    { type: string, example: 'INV-20250507-AB12C3' }
 *                             invoiceType:  { type: string }
 *                             subtotal:     { type: number }
 *                             totalAmount:  { type: number }
 *                             status:       { type: string, enum: [ISSUED, PAID, CANCELLED, OVERDUE] }
 *                             dueDate:      { type: string, format: date }
 *                             paidAt:       { type: string, format: date-time }
 *       404:
 *         description: Invoice not found
 */
router.get('/:id', validate(paymentsValidators.getInvoice), paymentsController.getInvoice);

module.exports = router;

