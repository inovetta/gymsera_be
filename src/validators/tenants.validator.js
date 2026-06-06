const { body, param } = require('express-validator');

const tenantsValidators = {
  register: [
    body('businessName')
      .trim()
      .notEmpty()
      .withMessage('Business name is required')
      .isLength({ max: 200 })
      .withMessage('Business name must be 200 characters or fewer'),

    body('email')
      .trim()
      .toLowerCase()
      .notEmpty()
      .withMessage('Business email is required')
      .isEmail()
      .withMessage('A valid email address is required'),

    body('phone')
      .optional({ nullable: true, checkFalsy: true })
      .isMobilePhone()
      .withMessage('A valid phone number is required'),

    body('cityId')
      .optional({ nullable: true, checkFalsy: true })
      .isInt({ min: 1 })
      .withMessage('cityId must be a positive integer'),
  ],

  submitGymProfile: [
    param('id').isUUID(4).withMessage('Invalid tenant ID'),

    body('gymName')
      .trim()
      .notEmpty()
      .withMessage('Gym name is required')
      .isLength({ max: 200 })
      .withMessage('Gym name must be 200 characters or fewer'),

    body('gymDescription').optional().isString(),

    body('genderType')
      .optional()
      .isIn(['MIXED', 'MALE_ONLY', 'FEMALE_ONLY'])
      .withMessage('genderType must be MIXED, MALE_ONLY, or FEMALE_ONLY'),

    body('address').optional().isString(),

    body('kycDocumentsJson')
      .optional()
      .isArray()
      .withMessage('kycDocumentsJson must be an array of document URLs'),

    body('kycDocumentsJson.*')
      .optional()
      .isURL()
      .withMessage('Each KYC document must be a valid URL'),

    body('logoUrl').optional().isURL().withMessage('logoUrl must be a valid URL'),
    body('coverImageUrl').optional().isURL().withMessage('coverImageUrl must be a valid URL'),
  ],

  selectPackage: [
    param('id').isUUID(4).withMessage('Invalid tenant ID'),

    body('packageId')
      .notEmpty()
      .withMessage('packageId is required')
      .isUUID(4)
      .withMessage('packageId must be a valid UUID'),
  ],

  updateMyTenant: [
    body('businessName')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Business name cannot be blank')
      .isLength({ max: 200 })
      .withMessage('Business name must be 200 characters or fewer'),

    body('email')
      .optional()
      .trim()
      .toLowerCase()
      .isEmail()
      .withMessage('A valid email address is required'),

    body('phone')
      .optional({ nullable: true, checkFalsy: true })
      .isMobilePhone()
      .withMessage('A valid phone number is required'),

    body('cityId')
      .optional({ nullable: true, checkFalsy: true })
      .isInt({ min: 1 })
      .withMessage('cityId must be a positive integer'),
  ],
};

module.exports = tenantsValidators;
