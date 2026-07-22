const { body, query, param } = require('express-validator');

const DURATION_TYPES = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'];

// ── Public listing —  GET /membership-plans?gymListingId=<uuid> ───────────────
const listPublic = [
  query('gymListingId')
    .notEmpty().withMessage('gymListingId is required')
    .isUUID(4).withMessage('gymListingId must be a valid UUID'),
  query('branchId')
    .optional()
    .isUUID(4).withMessage('branchId must be a valid UUID'),
];

// ── Public single plan — GET /membership-plans/:id?gymListingId=<uuid> ────────
const getPublic = [
  param('id')
    .isUUID(4).withMessage('id must be a valid UUID'),
  query('gymListingId')
    .notEmpty().withMessage('gymListingId is required')
    .isUUID(4).withMessage('gymListingId must be a valid UUID'),
];

// ── Create plan — POST /membership-plans ──────────────────────────────────────
const createPlan = [
  body('name')
    .trim()
    .notEmpty().withMessage('name is required')
    .isLength({ max: 200 }).withMessage('name must be at most 200 characters'),
  body('description')
    .optional({ nullable: true })
    .isString(),
  body('branchId')
    .optional({ nullable: true })
    .isUUID(4).withMessage('branchId must be a valid UUID'),
  body('durationType')
    .notEmpty().withMessage('durationType is required')
    .isIn(DURATION_TYPES).withMessage(`durationType must be one of: ${DURATION_TYPES.join(', ')}`),
  body('durationValue')
    .notEmpty().withMessage('durationValue is required')
    .isInt({ min: 1 }).withMessage('durationValue must be a positive integer'),
  body('price')
    .notEmpty().withMessage('price is required')
    .isFloat({ min: 0 }).withMessage('price must be a non-negative number'),
  body('joiningFee')
    .optional({ nullable: true })
    .isFloat({ min: 0 }).withMessage('joiningFee must be a non-negative number'),
  body('securityFee')
    .optional({ nullable: true })
    .isFloat({ min: 0 }).withMessage('securityFee must be a non-negative number'),
  body('visitLimit')
    .optional({ nullable: true })
    .isInt({ min: 1 }).withMessage('visitLimit must be a positive integer'),
  body('freezeLimitDays')
    .optional({ nullable: true })
    .isInt({ min: 0 }).withMessage('freezeLimitDays must be a non-negative integer'),
  body('isTrial')
    .optional()
    .isBoolean(),
  body('isPublic')
    .optional()
    .isBoolean().withMessage('isPublic must be a boolean'),
];

// ── Update plan — PATCH /membership-plans/:id ─────────────────────────────────
const updatePlan = [
  param('id')
    .isUUID(4).withMessage('id must be a valid UUID'),
  body('name')
    .optional()
    .trim()
    .notEmpty()
    .isLength({ max: 200 }),
  body('description')
    .optional({ nullable: true })
    .isString(),
  body('durationType')
    .optional()
    .isIn(DURATION_TYPES).withMessage(`durationType must be one of: ${DURATION_TYPES.join(', ')}`),
  body('durationValue')
    .optional()
    .isInt({ min: 1 }).withMessage('durationValue must be a positive integer'),
  body('price')
    .optional()
    .isFloat({ min: 0 }).withMessage('price must be a non-negative number'),
  body('joiningFee')
    .optional({ nullable: true })
    .isFloat({ min: 0 }),
  body('securityFee')
    .optional({ nullable: true })
    .isFloat({ min: 0 }),
  body('visitLimit')
    .optional({ nullable: true })
    .isInt({ min: 1 }),
  body('freezeLimitDays')
    .optional({ nullable: true })
    .isInt({ min: 0 }),
  body('isTrial')
    .optional()
    .isBoolean(),
  body('isPublic')
    .optional()
    .isBoolean().withMessage('isPublic must be a boolean'),
  body('status')
    .optional()
    .isIn(['ACTIVE', 'INACTIVE']).withMessage('status must be ACTIVE or INACTIVE'),
];

// ── Delete plan — DELETE /membership-plans/:id ────────────────────────────────
const deletePlan = [
  param('id').isUUID(4).withMessage('id must be a valid UUID'),
];

module.exports = { listPublic, getPublic, createPlan, updatePlan, deletePlan };
