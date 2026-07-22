const { query, param, body } = require('express-validator');

const discoveryValidators = {
  listGyms: [
    query('cityId')
      .optional({ checkFalsy: true })
      .isInt({ min: 1 })
      .withMessage('cityId must be a positive integer'),

    query('areaId')
      .optional({ checkFalsy: true })
      .isInt({ min: 1 })
      .withMessage('areaId must be a positive integer'),

    query('genderType')
      .optional({ checkFalsy: true })
      .isIn(['MIXED', 'MALE_ONLY', 'FEMALE_ONLY'])
      .withMessage('genderType must be MIXED, MALE_ONLY, or FEMALE_ONLY'),

    query('search')
      .optional({ checkFalsy: true })
      .isString()
      .isLength({ max: 100 }),

    query('featured')
      .optional({ checkFalsy: true })
      .isBoolean()
      .withMessage('featured must be true or false'),

    query('page')
      .optional({ checkFalsy: true })
      .isInt({ min: 1 })
      .withMessage('page must be a positive integer'),

    query('limit')
      .optional({ checkFalsy: true })
      .isInt({ min: 1, max: 50 })
      .withMessage('limit must be between 1 and 50'),
  ],

  getGym: [
    param('id').isUUID(4).withMessage('Invalid gym listing ID'),
  ],

  nearbyGyms: [
    query('lat')
      .notEmpty().withMessage('lat is required')
      .isFloat({ min: -90, max: 90 }).withMessage('lat must be a valid latitude'),
    query('lng')
      .notEmpty().withMessage('lng is required')
      .isFloat({ min: -180, max: 180 }).withMessage('lng must be a valid longitude'),
    query('radius')
      .optional({ checkFalsy: true })
      .isFloat({ min: 0.5, max: 100 })
      .withMessage('radius must be between 0.5 and 100 km'),
    query('limit')
      .optional({ checkFalsy: true })
      .isInt({ min: 1, max: 50 }),
  ],

  mapGyms: [
    query('cityId')
      .optional({ checkFalsy: true })
      .isInt({ min: 1 }),
  ],

  submitReview: [
    param('id').isUUID(4).withMessage('Invalid gym listing ID'),
    body('rating')
      .notEmpty().withMessage('rating is required')
      .isInt({ min: 1, max: 5 }).withMessage('rating must be 1–5'),
    body('title')
      .optional({ checkFalsy: true })
      .isString()
      .isLength({ max: 150 }),
    body('body')
      .optional({ checkFalsy: true })
      .isString()
      .isLength({ max: 2000 }),
  ],

  moderateReview: [
    param('id').isUUID(4).withMessage('Invalid review ID'),
    body('action')
      .notEmpty()
      .customSanitizer((v) => (typeof v === 'string' ? v.toLowerCase() : v))
      .isIn(['approve', 'reject'])
      .withMessage('action must be approve or reject'),
    body('adminNote')
      .optional({ checkFalsy: true })
      .isString()
      .isLength({ max: 300 }),
  ],

  submitInquiry: [
    param('branchId').isUUID(4).withMessage('Invalid branch ID'),
    body('message')
      .notEmpty().withMessage('message is required')
      .isString().withMessage('message must be a string')
      .isLength({ min: 1, max: 2000 }).withMessage('message must be 1-2000 characters'),
  ],

  getBranchReviewsSummary: [
    param('branchId').isUUID(4).withMessage('Invalid branch ID'),
  ],

  getBranchReviews: [
    param('branchId').isUUID(4).withMessage('Invalid branch ID'),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1 }),
    query('sort').optional().isString(),
    query('filter').optional().isString(),
  ],

  submitBranchReview: [
    param('branchId').isUUID(4).withMessage('Invalid branch ID'),
    body('rating')
      .notEmpty().withMessage('rating is required')
      .isInt({ min: 1, max: 5 }).withMessage('rating must be 1–5'),
    body('text')
      .notEmpty().withMessage('text is required')
      .isString()
      .isLength({ min: 5, max: 2000 }).withMessage('text must be 5-2000 characters'),
    body('title')
      .optional({ checkFalsy: true })
      .isString()
      .isLength({ max: 150 }),
  ],
};

module.exports = discoveryValidators;

