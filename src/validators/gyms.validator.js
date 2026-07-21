const { body, param, query } = require('express-validator');

const gymsValidators = {
  updateProfile: [
    body('name')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Gym name cannot be empty')
      .isLength({ max: 200 }),

    body('description').optional().isString(),

    body('contactPhone')
      .optional({ nullable: true, checkFalsy: true })
      .isMobilePhone()
      .withMessage('contactPhone must be a valid phone number'),

    body('contactEmail')
      .optional({ nullable: true, checkFalsy: true })
      .isEmail()
      .withMessage('contactEmail must be a valid email'),

    body('website')
      .optional({ nullable: true, checkFalsy: true })
      .isURL()
      .withMessage('website must be a valid URL'),

    body('genderType')
      .optional()
      .isIn(['MIXED', 'MALE_ONLY', 'FEMALE_ONLY'])
      .withMessage('genderType must be MIXED, MALE_ONLY, or FEMALE_ONLY'),

    body('logoUrl').optional({ nullable: true, checkFalsy: true }).isString().withMessage('logoUrl must be a string'),
    body('coverImageUrl').optional({ nullable: true, checkFalsy: true }).isString().withMessage('coverImageUrl must be a string'),

    body('socialLinksJson')
      .optional({ nullable: true })
      .isObject()
      .withMessage('socialLinksJson must be a JSON object'),

    body('paymentDetailsJson')
      .optional({ nullable: true })
      .isObject()
      .withMessage('paymentDetailsJson must be a JSON object'),
  ],

  createBranch: [
    body('branchName')
      .trim()
      .notEmpty()
      .withMessage('Branch name is required')
      .isLength({ max: 200 }),

    body('address').optional().isString(),

    body('cityId')
      .optional({ nullable: true, checkFalsy: true })
      .isInt({ min: 1 })
      .withMessage('cityId must be a positive integer'),

    body('areaId')
      .optional({ nullable: true, checkFalsy: true })
      .isInt({ min: 1 })
      .withMessage('areaId must be a positive integer'),

    body('latitude')
      .optional({ nullable: true, checkFalsy: true })
      .isDecimal()
      .withMessage('latitude must be a decimal number'),

    body('longitude')
      .optional({ nullable: true, checkFalsy: true })
      .isDecimal()
      .withMessage('longitude must be a decimal number'),

    body('phone')
      .optional({ nullable: true, checkFalsy: true })
      .isMobilePhone()
      .withMessage('phone must be a valid phone number'),

    body('openingTime')
      .optional({ nullable: true, checkFalsy: true })
      .matches(/^\d{2}:\d{2}$/)
      .withMessage('openingTime must be in HH:MM format'),

    body('closingTime')
      .optional({ nullable: true, checkFalsy: true })
      .matches(/^\d{2}:\d{2}$/)
      .withMessage('closingTime must be in HH:MM format'),

    body('facilitiesJson')
      .optional({ nullable: true })
      .isArray()
      .withMessage('facilitiesJson must be an array'),

    body('facilitiesJson.*').optional().isString(),

    body('imagesJson')
      .optional({ nullable: true })
      .isArray()
      .withMessage('imagesJson must be an array of URLs'),

    body('tagline').optional().isString(),
    body('category').optional().isString(),
    body('description').optional().isString(),
    body('establishedYear').optional({ nullable: true, checkFalsy: true }).isInt(),
    body('floorArea').optional({ nullable: true, checkFalsy: true }).isInt(),
    body('addressLine1').optional().isString(),
    body('addressLine2').optional().isString(),
    body('postalCode').optional().isString(),
    body('country').optional().isString(),
    body('packages').optional().isArray(),
  ],

  updateBranch: [
    param('branchId').isUUID(4).withMessage('Invalid branch ID'),

    body('branchName')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Branch name cannot be empty')
      .isLength({ max: 200 }),

    body('status')
      .optional()
      .isIn(['ACTIVE', 'INACTIVE'])
      .withMessage('status must be ACTIVE or INACTIVE'),

    body('address').optional().isString(),
    body('cityId').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('areaId').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('latitude').optional({ nullable: true, checkFalsy: true }).isDecimal(),
    body('longitude').optional({ nullable: true, checkFalsy: true }).isDecimal(),
    body('phone').optional({ nullable: true, checkFalsy: true }).isMobilePhone(),
    body('openingTime').optional({ nullable: true, checkFalsy: true }).matches(/^\d{2}:\d{2}$/),
    body('closingTime').optional({ nullable: true, checkFalsy: true }).matches(/^\d{2}:\d{2}$/),
    body('facilitiesJson').optional({ nullable: true }).isArray(),
    body('imagesJson').optional({ nullable: true }).isArray(),
  ],

  assignStaff: [
    param('branchId').isUUID(4).withMessage('Invalid branch ID'),

    body('userId')
      .notEmpty()
      .withMessage('userId is required')
      .isUUID(4)
      .withMessage('userId must be a valid UUID'),

    body('designation')
      .optional({ nullable: true, checkFalsy: true })
      .isString()
      .isLength({ max: 100 }),
  ],

  removeStaff: [
    param('branchId').isUUID(4).withMessage('Invalid branch ID'),
    param('staffId').isUUID(4).withMessage('Invalid staff ID'),
  ],
};

module.exports = gymsValidators;
