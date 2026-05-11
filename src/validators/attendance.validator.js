const { body, query } = require('express-validator');

// ── POST /attendance/qr-scan ───────────────────────────────────────────────────
const qrScan = [
  body('qrCode')
    .notEmpty().withMessage('qrCode is required')
    .isString().isLength({ min: 10, max: 100 }),
  body('branchId')
    .notEmpty().withMessage('branchId is required')
    .isUUID(4).withMessage('branchId must be a valid UUID'),
  body('deviceId')
    .optional({ nullable: true })
    .isString().isLength({ max: 100 }),
];

// ── POST /attendance/manual ────────────────────────────────────────────────────
const manual = [
  body('userId')
    .notEmpty().withMessage('userId is required')
    .isUUID(4).withMessage('userId must be a valid UUID'),
  body('branchId')
    .notEmpty().withMessage('branchId is required')
    .isUUID(4).withMessage('branchId must be a valid UUID'),
  body('subscriptionId')
    .notEmpty().withMessage('subscriptionId is required')
    .isUUID(4).withMessage('subscriptionId must be a valid UUID'),
  body('notes')
    .optional({ nullable: true })
    .isString().isLength({ max: 300 }),
];

// ── GET /attendance ────────────────────────────────────────────────────────────
const list = [
  query('branchId')
    .optional()
    .isUUID(4).withMessage('branchId must be a valid UUID'),
  query('date')
    .optional()
    .isISO8601().withMessage('date must be a valid ISO date (YYYY-MM-DD)'),
  query('userId')
    .optional()
    .isUUID(4).withMessage('userId must be a valid UUID'),
  query('page')
    .optional()
    .isInt({ min: 1 }),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }),
];

module.exports = { qrScan, manual, list };
