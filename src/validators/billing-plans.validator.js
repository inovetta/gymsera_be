const { body, param } = require('express-validator');

const billingPlansValidators = {
  createPlan: [
    body('branchCount').notEmpty().isInt({ min: 1 }).withMessage('branchCount must be a positive integer'),
    body('monthlyPrice').notEmpty().isDecimal({ decimal_digits: '0,2' }).withMessage('monthlyPrice must be a valid decimal'),
    body('annualPrice').notEmpty().isDecimal({ decimal_digits: '0,2' }).withMessage('annualPrice must be a valid decimal'),
    body('currency').optional().isString().isLength({ min: 3, max: 3 }),
    body('isActive').optional().isBoolean(),
    body('sortOrder').optional().isInt(),
    body('iosMonthlyProductId').optional().isString(),
    body('iosAnnualProductId').optional().isString(),
    body('androidProductId').optional().isString(),
    body('androidMonthlyBasePlanId').optional().isString(),
    body('androidAnnualBasePlanId').optional().isString(),
  ],

  updatePlan: [
    param('id').isUUID(4).withMessage('Invalid billing plan ID'),
    body('branchCount').optional().isInt({ min: 1 }),
    body('monthlyPrice').optional().isDecimal({ decimal_digits: '0,2' }),
    body('annualPrice').optional().isDecimal({ decimal_digits: '0,2' }),
    body('currency').optional().isString().isLength({ min: 3, max: 3 }),
    body('isActive').optional().isBoolean(),
    body('sortOrder').optional().isInt(),
    body('iosMonthlyProductId').optional({ nullable: true }).isString(),
    body('iosAnnualProductId').optional({ nullable: true }).isString(),
    body('androidProductId').optional({ nullable: true }).isString(),
    body('androidMonthlyBasePlanId').optional({ nullable: true }).isString(),
    body('androidAnnualBasePlanId').optional({ nullable: true }).isString(),
  ],

  markSynced: [
    param('id').isUUID(4).withMessage('Invalid billing plan ID'),
    body('provider').isIn(['ios', 'android']).withMessage('provider must be "ios" or "android"'),
  ],
};

module.exports = billingPlansValidators;
