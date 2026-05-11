const { body, param, query } = require('express-validator');

const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'WALLET', 'ONLINE', 'POS', 'TEST'];
const PAYMENT_FOR     = ['MEMBERSHIP', 'TRAINER', 'PRODUCT', 'OTHER'];

// ── POST /payments ─────────────────────────────────────────────────────────────
const recordPayment = [
  body('userId')
    .notEmpty().withMessage('userId is required')
    .isUUID(4).withMessage('userId must be a valid UUID'),
  body('paymentFor')
    .optional()
    .isIn(PAYMENT_FOR).withMessage(`paymentFor must be one of: ${PAYMENT_FOR.join(', ')}`),
  body('referenceEntityId')
    .optional({ nullable: true })
    .isUUID(4).withMessage('referenceEntityId must be a valid UUID'),
  body('method')
    .notEmpty().withMessage('method is required')
    .isIn(PAYMENT_METHODS).withMessage(`method must be one of: ${PAYMENT_METHODS.join(', ')}`),
  body('gatewayName')
    .optional({ nullable: true })
    .isString().isLength({ max: 50 }),
  body('gatewayTransactionId')
    .optional({ nullable: true })
    .isString().isLength({ max: 200 }),
  body('amount')
    .notEmpty().withMessage('amount is required')
    .isFloat({ min: 0.01 }).withMessage('amount must be greater than 0'),
  body('currency')
    .optional()
    .isString().isLength({ max: 5 }),
  body('notes')
    .optional({ nullable: true })
    .isString().isLength({ max: 500 }),
];

// ── GET /payments ──────────────────────────────────────────────────────────────
const listPayments = [
  query('userId')
    .optional()
    .isUUID(4).withMessage('userId must be a valid UUID'),
  query('status')
    .optional()
    .isIn(['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'])
    .withMessage('Invalid status'),
  query('method')
    .optional()
    .isIn(PAYMENT_METHODS).withMessage('Invalid method'),
  query('from')
    .optional()
    .isISO8601().withMessage('from must be a valid date'),
  query('to')
    .optional()
    .isISO8601().withMessage('to must be a valid date'),
  query('page')
    .optional()
    .isInt({ min: 1 }),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }),
];

// ── POST /payments/:id/verify ──────────────────────────────────────────────────
const verifyPayment = [
  param('id').isUUID(4).withMessage('id must be a valid UUID'),
  body('notes')
    .optional({ nullable: true })
    .isString().isLength({ max: 500 }),
];

// ── GET /invoices/:id ──────────────────────────────────────────────────────────
const getInvoice = [
  param('id').isUUID(4).withMessage('id must be a valid UUID'),
];

module.exports = { recordPayment, listPayments, verifyPayment, getInvoice };
