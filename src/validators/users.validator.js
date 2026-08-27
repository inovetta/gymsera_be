const { body, query, param } = require('express-validator');
const { UserRole } = require('../constants/roles');

const userValidators = {
  /** POST /users/search */
  search: [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('q').optional().trim(),
    query('role')
      .optional()
      .isIn(Object.values(UserRole))
      .withMessage('Invalid role filter'),
    query('status')
      .optional()
      .isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED'])
      .withMessage('Invalid status filter'),
  ],

  /** POST /users — staff creates member */
  createMember: [
    body('fullName')
      .trim()
      .notEmpty().withMessage('Full name is required')
      .isLength({ max: 100 }),
    body('email')
      .trim()
      .toLowerCase()
      .notEmpty().withMessage('Email is required')
      .isEmail().withMessage('Valid email required'),
    body('phone')
      .optional({ nullable: true, checkFalsy: true })
      .isMobilePhone().withMessage('Valid phone number required'),
    body('password')
      .optional({ nullable: true, checkFalsy: true })
      .isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('gender')
      .optional({ nullable: true, checkFalsy: true })
      .isIn(['MALE', 'FEMALE', 'OTHER']),
    body('dateOfBirth')
      .optional({ nullable: true, checkFalsy: true })
      .isDate().withMessage('Valid date required (YYYY-MM-DD)'),
  ],

  /** PUT /users/:id */
  update: [
    param('id').isUUID().withMessage('Invalid user ID'),
    body('fullName')
      .optional().trim().isLength({ max: 100 }),
    body('phone')
      .optional({ nullable: true, checkFalsy: true })
      .isMobilePhone().withMessage('Valid phone number required'),
    body('gender')
      .optional({ nullable: true, checkFalsy: true })
      .isIn(['MALE', 'FEMALE', 'OTHER']),
    body('dateOfBirth')
      .optional({ nullable: true, checkFalsy: true })
      .isDate().withMessage('Valid date required (YYYY-MM-DD)'),
    body('emergencyContactName').optional().trim().isLength({ max: 100 }),
    body('emergencyContactPhone')
      .optional({ nullable: true, checkFalsy: true })
      .isMobilePhone(),
    body('fitnessGoal').optional().trim().isLength({ max: 200 }),
    body('medicalNotes').optional().trim(),
    body('heightCm').optional({ nullable: true, checkFalsy: true }).isFloat({ min: 0 }),
    body('weightKg').optional({ nullable: true, checkFalsy: true }).isFloat({ min: 0 }),
  ],

  /** POST /users/:id/status */
  setStatus: [
    param('id').isUUID().withMessage('Invalid user ID'),
    body('status')
      .notEmpty().withMessage('Status is required')
      .isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED'])
      .withMessage('Status must be ACTIVE, INACTIVE or SUSPENDED'),
    body('reason').optional().trim().isLength({ max: 500 }),
  ],

  /** POST /users/:id/password */
  adminResetPassword: [
    param('id').isUUID().withMessage('Invalid user ID'),
    body('newPassword')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/[A-Z]/).withMessage('Must contain uppercase')
      .matches(/[a-z]/).withMessage('Must contain lowercase')
      .matches(/[0-9]/).withMessage('Must contain a number')
      .matches(/[^A-Za-z0-9]/).withMessage('Must contain a special character'),
  ],

  /** GET /users/:id or GET /users/customer/:code */
  getId: [param('id').isUUID().withMessage('Invalid user ID')],
  getByCode: [param('code').notEmpty().withMessage('Customer code is required')],

  /** Account statement */
  accountStatement: [
    param('id').isUUID().withMessage('Invalid user ID'),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('from').optional().isDate(),
    query('to').optional().isDate(),
  ],
};

module.exports = userValidators;
