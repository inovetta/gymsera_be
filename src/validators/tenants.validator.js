const { body, param } = require('express-validator');

const tenantsValidators = {
  register: [
    // NEW-265 (A4): a pending area request instead of areaId (type-checked; the service checks the rest).
    body('areaRequestId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('areaRequestId must be a positive integer'),
    // R-112 (C2): optional. Build 26 types the brand on Step 2 (gym-profile); builds up to 25 still send
    // the generated "<full name>'s Gym Business" here, checked as before.
    body('organizationName')
      .optional({ nullable: true })
      .trim()
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
    param('organizationId').isUUID(4).withMessage('Invalid organization ID'),
    body('organizationName').trim().notEmpty().withMessage('Organization name is required'),
    body('firstBusinessName').trim().notEmpty().withMessage('Business name is required')
      .isLength({ max: 200 }).withMessage('Business name must be 200 characters or fewer'),
    body('firstBusinessDescription').optional({ nullable: true }).isString(),
    body('genderType')
      .optional({ nullable: true })
      .isIn(['MIXED', 'MALE_ONLY', 'FEMALE_ONLY'])
      .withMessage('genderType must be MIXED, MALE_ONLY, or FEMALE_ONLY'),
    body('logoUrl').optional({ nullable: true, checkFalsy: true }).isString().withMessage('logoUrl must be a string'),
    body('coverImageUrl').optional({ nullable: true, checkFalsy: true }).isString().withMessage('coverImageUrl must be a string'),
    require('./first-branch.validator').nested(),
  ],

  selectPackage: [
    param('organizationId').isUUID(4).withMessage('Invalid tenant ID'),

    body('packageId')
      .notEmpty()
      .withMessage('packageId is required')
      .isUUID(4)
      .withMessage('packageId must be a valid UUID'),
  ],

  updateMyTenant: [
    // R-112 (C4): the brand rules (C1) are in brand-name.service (422 brand_name_*).
    body('organizationName').optional().isString().withMessage('Brand name must be text'),

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

    // NEW-265 (A4, R-109 F3, R-111): the first-branch default area while DRAFT / PENDING_REVIEW (422 when ACTIVE).
    body('areaId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('areaId must be a positive integer'),
    body('areaRequestId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('areaRequestId must be a positive integer'),
  ],
};

module.exports = tenantsValidators;
