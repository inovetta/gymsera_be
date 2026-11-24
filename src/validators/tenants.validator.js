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
    param('organizationId').isUUID(4).withMessage('Invalid tenant ID'),

    body('firstBusinessName')
      .trim()
      .notEmpty()
      .withMessage('Gym name is required')
      .isLength({ max: 200 })
      .withMessage('Gym name must be 200 characters or fewer'),

    body('firstBusinessDescription').optional().isString(),

    // R-112 (C3): the brand / organisation name; the rules (C1) are in brand-name.service (422 brand_name_*).
    body('organizationName').optional().isString().withMessage('Brand name must be text'),

    // SEC-06: read by tenant.service#submitGymProfile
    body('latitude').optional({ nullable: true }).isFloat({ min: -90, max: 90 }).withMessage('latitude must be between -90 and 90'),
    body('longitude').optional({ nullable: true }).isFloat({ min: -180, max: 180 }).withMessage('longitude must be between -180 and 180'),

    body('genderType')
      .optional()
      .isIn(['MIXED', 'MALE_ONLY', 'FEMALE_ONLY'])
      .withMessage('genderType must be MIXED, MALE_ONLY, or FEMALE_ONLY'),

    body('address').optional().isString(),

    body('firstBranchDraft').optional().isObject().withMessage('firstBranchDraft must be an object'),
    // Phase 7 P3: the main branch's map pin and Google place, copied to the branch at approval.
    body('firstBranchDraft.latitude').optional({ nullable: true }).isFloat({ min: -90, max: 90 }).withMessage('latitude must be between -90 and 90'),
    body('firstBranchDraft.longitude').optional({ nullable: true }).isFloat({ min: -180, max: 180 }).withMessage('longitude must be between -180 and 180'),
    body('firstBranchDraft.placeId').optional({ nullable: true }).matches(/^[A-Za-z0-9_-]{1,255}$/).withMessage('placeId is not a Google place id'),
    body('firstBranchDraft.areaId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('areaId must be a positive integer'),
    // NEW-265 (A4): a pending area request for the draft first branch (null clears it).
    body('firstBranchDraft.areaRequestId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('areaRequestId must be a positive integer'),
    // NEW-266: the amenities picked in Become a Host (names), copied to the first branch at approval.
    body('firstBranchDraft.facilitiesJson').optional({ nullable: true }).isArray({ max: 50 }).withMessage('Amenities must be a list of up to 50 names'),
    body('firstBranchDraft.facilitiesJson.*').isString().withMessage('Each amenity must be a name')
      .bail().trim().isLength({ min: 1, max: 100 }).withMessage('Each amenity must be 1 to 100 characters'),
    body('firstBranchDraft.plans').optional().isArray().withMessage('firstBranchDraft.plans must be an array'),
    body('firstBranchDraft.plans.*.name').optional().trim().notEmpty().withMessage('Plan name cannot be empty'),
    body('firstBranchDraft.plans.*.price').optional().isFloat({ min: 0 }).withMessage('Plan price must be a valid number >= 0'),

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
