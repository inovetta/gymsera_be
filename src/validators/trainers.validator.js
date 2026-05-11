const { body, param, query } = require('express-validator');

// ── POST /trainers ─────────────────────────────────────────────────────────────
const createTrainer = [
  body('userId')
    .notEmpty().withMessage('userId is required')
    .isUUID(4).withMessage('userId must be a valid UUID'),
  body('branchId')
    .optional({ nullable: true })
    .isUUID(4).withMessage('branchId must be a valid UUID'),
  body('specialization')
    .optional({ nullable: true })
    .isString().isLength({ max: 200 }),
  body('bio')
    .optional({ nullable: true })
    .isString(),
  body('yearsExperience')
    .optional({ nullable: true })
    .isInt({ min: 0, max: 60 }).withMessage('yearsExperience must be between 0 and 60'),
  body('certificationsJson')
    .optional({ nullable: true })
    .isArray().withMessage('certificationsJson must be an array'),
  body('availabilityJson')
    .optional({ nullable: true })
    .isObject().withMessage('availabilityJson must be an object'),
];

// ── GET /trainers ──────────────────────────────────────────────────────────────
const listTrainers = [
  query('branchId')
    .optional()
    .isUUID(4).withMessage('branchId must be a valid UUID'),
  query('status')
    .optional()
    .isIn(['ACTIVE', 'INACTIVE']).withMessage('status must be ACTIVE or INACTIVE'),
  query('page')
    .optional()
    .isInt({ min: 1 }),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }),
];

// ── PATCH /trainers/:id ────────────────────────────────────────────────────────
const updateTrainer = [
  param('id').isUUID(4).withMessage('id must be a valid UUID'),
  body('specialization')
    .optional({ nullable: true })
    .isString().isLength({ max: 200 }),
  body('bio')
    .optional({ nullable: true })
    .isString(),
  body('yearsExperience')
    .optional({ nullable: true })
    .isInt({ min: 0, max: 60 }),
  body('certificationsJson')
    .optional({ nullable: true })
    .isArray(),
  body('availabilityJson')
    .optional({ nullable: true })
    .isObject(),
  body('status')
    .optional()
    .isIn(['ACTIVE', 'INACTIVE']).withMessage('status must be ACTIVE or INACTIVE'),
];

// ── POST /trainers/:id/assign ──────────────────────────────────────────────────
const assignTrainer = [
  param('id').isUUID(4).withMessage('id must be a valid UUID'),
  body('branchId')
    .notEmpty().withMessage('branchId is required')
    .isUUID(4).withMessage('branchId must be a valid UUID'),
];

module.exports = { createTrainer, listTrainers, updateTrainer, assignTrainer };
