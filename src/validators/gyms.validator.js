const { body, param, query } = require('express-validator');

const gymsValidators = {
  updateProfile: [
    // SEC-06: listing fields gym.service#updateProfile writes
    body('imagesJson').optional({ nullable: true }).isArray().withMessage('imagesJson must be an array'),
    body('tagline').optional({ nullable: true }).isString().isLength({ max: 200 }),
    body('category').optional({ nullable: true }).isString().isLength({ max: 100 }),
    body('establishedYear').optional({ nullable: true }).isInt({ min: 1800, max: 2100 }),
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

    body('password').optional().isString(),
    body('provider').optional().isString(),
    body('idToken').optional().isString(),
  ],

  createBranch: [
    // SEC-06: the organization the branch is built in (gym.service#createBranch reads data.gymListingId)
    body('gymListingId').optional({ nullable: true }).isUUID(4).withMessage('gymListingId must be a valid UUID'),
    body('branchName')
      .trim()
      .notEmpty()
      .withMessage('Branch name is required')
      .isLength({ max: 200 }),

    // GLB-01 / GLB-02: format only here; the service checks the IANA zone and the supported-currency list.
    body('timezone').optional().isString().isLength({ min: 1, max: 64 }),
    body('currency').optional().isString().isLength({ min: 3, max: 3 }).withMessage('currency must be a 3-letter code'),
    body('address').optional().isString(),

    body('cityId')
      .optional({ nullable: true, checkFalsy: true })
      .isInt({ min: 1 })
      .withMessage('cityId must be a positive integer'),

    body('areaId')
      .optional({ nullable: true, checkFalsy: true })
      .isInt({ min: 1 })
      .withMessage('areaId must be a positive integer'),

    // Phase 7 P3: in range, not just any decimal (latitude 123 used to be stored).
    body('latitude')
      .optional({ nullable: true, checkFalsy: true })
      .isFloat({ min: -90, max: 90 })
      .withMessage('latitude must be between -90 and 90'),

    body('longitude')
      .optional({ nullable: true, checkFalsy: true })
      .isFloat({ min: -180, max: 180 })
      .withMessage('longitude must be between -180 and 180'),

    body('googlePlaceId')
      .optional({ nullable: true, checkFalsy: true })
      .matches(/^[A-Za-z0-9_-]{1,255}$/)
      .withMessage('googlePlaceId is not a Google place id'),

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
    body('packages')
      .isArray({ min: 1 })
      .withMessage('At least 1 membership package/plan is required for every branch'),
    body('packages.*.name')
      .trim()
      .notEmpty()
      .withMessage('Package name is required'),
    body('packages.*.price')
      .notEmpty()
      .withMessage('Package price is required')
      .isFloat({ min: 0 })
      .withMessage('Package price must be a valid number >= 0'),
    body('packages.*.durationType')
      .optional()
      .isString()
      .withMessage('durationType must be a string'),
  ],

  updateBranch: [
    // SEC-06: clients send the current status back; the service refuses a change (branch_status_immutable_here)
    body('status').optional().isString(),
    param('branchId').isUUID(4).withMessage('Invalid branch ID'),

    body('branchName')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Branch name cannot be empty')
      .isLength({ max: 200 }),

    // `status` is intentionally absent. A branch's ACTIVE/INACTIVE state is
    // only ever changed by the delete/restore endpoints, which settle branch
    // capacity as part of the transition — see gym.service.js#updateBranch,
    // which rejects a status change here outright. A no-op (sending the
    // branch's current status back, as the CMS edit form does) still passes.
    // GLB-01 / GLB-02: format only here; the service checks the IANA zone and the supported-currency list.
    body('timezone').optional().isString().isLength({ min: 1, max: 64 }),
    body('currency').optional().isString().isLength({ min: 3, max: 3 }).withMessage('currency must be a 3-letter code'),
    body('address').optional().isString(),
    body('cityId').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('areaId').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('latitude').optional({ nullable: true, checkFalsy: true }).isFloat({ min: -90, max: 90 }).withMessage('latitude must be between -90 and 90'),
    body('longitude').optional({ nullable: true, checkFalsy: true }).isFloat({ min: -180, max: 180 }).withMessage('longitude must be between -180 and 180'),
    body('googlePlaceId').optional({ nullable: true, checkFalsy: true }).matches(/^[A-Za-z0-9_-]{1,255}$/).withMessage('googlePlaceId is not a Google place id'),
    body('phone').optional({ nullable: true, checkFalsy: true }).isMobilePhone(),
    body('openingTime').optional({ nullable: true, checkFalsy: true }).matches(/^\d{2}:\d{2}$/),
    body('closingTime').optional({ nullable: true, checkFalsy: true }).matches(/^\d{2}:\d{2}$/),
    body('facilitiesJson').optional({ nullable: true }).isArray(),
    body('imagesJson').optional({ nullable: true }).isArray(),
  ],

  // Phase 7 P3: PATCH /host/branches/:branchId/listing-content (location fields only; the rest is free-form there).
  branchLocation: [
    body('latitude').optional({ nullable: true, checkFalsy: true }).isFloat({ min: -90, max: 90 }).withMessage('latitude must be between -90 and 90'),
    body('longitude').optional({ nullable: true, checkFalsy: true }).isFloat({ min: -180, max: 180 }).withMessage('longitude must be between -180 and 180'),
    body('googlePlaceId').optional({ nullable: true, checkFalsy: true }).matches(/^[A-Za-z0-9_-]{1,255}$/).withMessage('googlePlaceId is not a Google place id'),
    body('cityId').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('areaId').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
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
