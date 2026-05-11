const { body, param } = require('express-validator');

const packagesValidators = {
  createPackage: [
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Package name is required')
      .isLength({ max: 100 })
      .withMessage('Package name must be 100 characters or fewer'),

    body('description').optional().isString(),

    body('price')
      .notEmpty()
      .withMessage('Price is required')
      .isDecimal({ decimal_digits: '0,2' })
      .withMessage('Price must be a valid decimal number')
      .custom((v) => parseFloat(v) >= 0)
      .withMessage('Price must be non-negative'),

    body('billingCycle')
      .optional()
      .isIn(['MONTHLY', 'QUARTERLY', 'YEARLY'])
      .withMessage('billingCycle must be MONTHLY, QUARTERLY, or YEARLY'),

    body('maxBranches')
      .optional()
      .isInt({ min: 1 })
      .withMessage('maxBranches must be a positive integer'),

    body('maxTrainers')
      .optional()
      .isInt({ min: 1 })
      .withMessage('maxTrainers must be a positive integer'),

    body('maxMembers')
      .optional()
      .isInt({ min: 1 })
      .withMessage('maxMembers must be a positive integer'),

    body('featureFlagsJson')
      .optional()
      .isObject()
      .withMessage('featureFlagsJson must be a JSON object'),
  ],

  updatePackage: [
    param('id').isUUID(4).withMessage('Invalid package ID'),

    body('name')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Package name cannot be empty')
      .isLength({ max: 100 }),

    body('description').optional().isString(),

    body('price')
      .optional()
      .isDecimal({ decimal_digits: '0,2' })
      .withMessage('Price must be a valid decimal number')
      .custom((v) => parseFloat(v) >= 0)
      .withMessage('Price must be non-negative'),

    body('billingCycle')
      .optional()
      .isIn(['MONTHLY', 'QUARTERLY', 'YEARLY'])
      .withMessage('billingCycle must be MONTHLY, QUARTERLY, or YEARLY'),

    body('maxBranches').optional().isInt({ min: 1 }),
    body('maxTrainers').optional().isInt({ min: 1 }),
    body('maxMembers').optional().isInt({ min: 1 }),

    body('featureFlagsJson').optional().isObject(),

    body('status')
      .optional()
      .isIn(['ACTIVE', 'INACTIVE'])
      .withMessage('status must be ACTIVE or INACTIVE'),
  ],
};

module.exports = packagesValidators;
