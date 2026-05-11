const { body, query, param } = require('express-validator');

const meValidators = {
  updateProfile: [
    body('fullName').optional().trim().isLength({ max: 100 }),
    body('phone')
      .optional({ nullable: true, checkFalsy: true })
      .isMobilePhone().withMessage('Valid phone number required'),
    body('gender')
      .optional({ nullable: true, checkFalsy: true })
      .isIn(['MALE', 'FEMALE', 'OTHER']),
    body('dateOfBirth')
      .optional({ nullable: true, checkFalsy: true })
      .isDate().withMessage('Valid date required (YYYY-MM-DD)'),
    body('heightCm')
      .optional({ nullable: true, checkFalsy: true })
      .isFloat({ min: 0 }),
    body('weightKg')
      .optional({ nullable: true, checkFalsy: true })
      .isFloat({ min: 0 }),
    body('fitnessGoal').optional().trim().isLength({ max: 200 }),
  ],

  changePassword: [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword')
      .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
      .matches(/[A-Z]/).withMessage('Must contain uppercase')
      .matches(/[a-z]/).withMessage('Must contain lowercase')
      .matches(/[0-9]/).withMessage('Must contain a number')
      .matches(/[^A-Za-z0-9]/).withMessage('Must contain a special character'),
  ],

  accountStatement: [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('from').optional().isDate(),
    query('to').optional().isDate(),
  ],

  submitPaymentRequest: [
    body('subscriptionId').isUUID().withMessage('Valid subscription ID required'),
    body('method')
      .notEmpty().withMessage('Payment method is required')
      .isIn(['CASH', 'BANK_TRANSFER', 'ONLINE', 'POS'])
      .withMessage('Invalid payment method'),
    body('amount')
      .isFloat({ min: 0.01 }).withMessage('Amount must be a positive number')
      .toFloat(),
    body('notes').optional().trim().isLength({ max: 500 }),
  ],

  proofId: [
    param('id').isUUID().withMessage('Invalid payment ID'),
  ],
};

module.exports = meValidators;
