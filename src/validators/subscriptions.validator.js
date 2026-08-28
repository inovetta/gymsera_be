const { body, param, query } = require('express-validator');

const SOURCE_CHANNELS = ['ONLINE', 'WALK_IN', 'STAFF'];

// ── POST /subscriptions — subscribe to a plan ─────────────────────────────────
const subscribe = [
  body('planId')
    .notEmpty().withMessage('planId is required')
    .isUUID(4).withMessage('planId must be a valid UUID'),
  body('gymListingId')
    .notEmpty().withMessage('gymListingId is required')
    .isUUID(4).withMessage('gymListingId must be a valid UUID'),
  body('branchId')
    .notEmpty().withMessage('branchId is required')
    .isUUID(4).withMessage('branchId must be a valid UUID'),
  body('autoRenew')
    .optional()
    .isBoolean(),
  body('sourceChannel')
    .optional()
    .isIn(SOURCE_CHANNELS).withMessage(`sourceChannel must be one of: ${SOURCE_CHANNELS.join(', ')}`),
];

// ── GET /me/subscriptions ─────────────────────────────────────────────────────
const listMySubscriptions = [
  query('status')
    .optional()
    .isIn(['PENDING', 'ACTIVE', 'FROZEN', 'EXPIRED', 'CANCELLED'])
    .withMessage('Invalid status value'),
  query('page')
    .optional()
    .isInt({ min: 1 }).withMessage('page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 50 }).withMessage('limit must be between 1 and 50'),
];

// ── POST /subscriptions/:id/freeze ────────────────────────────────────────────
const freeze = [
  param('id').isUUID(4).withMessage('id must be a valid UUID'),
  body('freezeFrom')
    .notEmpty().withMessage('freezeFrom is required')
    .isISO8601().withMessage('freezeFrom must be a valid date (YYYY-MM-DD)'),
  body('freezeTo')
    .notEmpty().withMessage('freezeTo is required')
    .isISO8601().withMessage('freezeTo must be a valid date (YYYY-MM-DD)')
    .custom((to, { req }) => {
      if (new Date(to) <= new Date(req.body.freezeFrom)) {
        throw new Error('freezeTo must be after freezeFrom');
      }
      return true;
    }),
];

// ── POST /subscriptions/:id/cancel ────────────────────────────────────────────
const cancel = [
  param('id').isUUID(4).withMessage('id must be a valid UUID'),
];

// ── POST /subscriptions/:id/renew ─────────────────────────────────────────────
const renew = [
  param('id').isUUID(4).withMessage('id must be a valid UUID'),
  body('planId').optional().isUUID(4).withMessage('planId must be a valid UUID'),
];

// ── POST /subscriptions/:id/change-plan ─────────────────────────────────────────────
const changePlan = [
  param('id').isUUID(4).withMessage('id must be a valid UUID'),
  body('planId').isUUID(4).withMessage('planId must be a valid UUID'),
];

module.exports = { subscribe, listMySubscriptions, freeze, cancel, renew, changePlan };
