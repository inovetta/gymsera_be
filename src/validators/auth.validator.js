const { body } = require('express-validator');

/**
 * Password strength rule — reusable across register and password-reset/confirm.
 * Min 8 chars, at least one uppercase, one lowercase, one digit, one special char.
 */
const strongPassword = () =>
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/)
    .withMessage('Password must contain at least one special character');

const authValidators = {
  register: [
    body('fullName')
      .trim()
      .notEmpty()
      .withMessage('Full name is required')
      .isLength({ max: 100 })
      .withMessage('Full name must be 100 characters or fewer'),

    body('email')
      .trim()
      .toLowerCase()
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('A valid email address is required'),

    strongPassword(),

    body('phone')
      .optional({ nullable: true, checkFalsy: true })
      .isMobilePhone()
      .withMessage('A valid phone number is required'),
  ],

  login: [
    body('email')
      .trim()
      .toLowerCase()
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('A valid email address is required'),

    body('password').notEmpty().withMessage('Password is required'),
  ],

  verifyOtp: [
    body('email')
      .trim()
      .toLowerCase()
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('A valid email address is required'),

    body('code')
      .trim()
      .notEmpty()
      .withMessage('OTP code is required')
      .matches(/^\d{6}$/)
      .withMessage('OTP code must be a 6-digit number'),
  ],

  resendOtp: [
    body('email')
      .trim()
      .toLowerCase()
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('A valid email address is required'),
  ],

  googleLogin: [
    body('idToken').notEmpty().withMessage('Google ID token is required'),
  ],

  refreshToken: [
    body('refreshToken').notEmpty().withMessage('Refresh token is required'),
  ],

  passwordResetRequest: [
    body('email')
      .trim()
      .toLowerCase()
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('A valid email address is required'),
  ],

  passwordResetConfirm: [
    body('email')
      .trim()
      .toLowerCase()
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('A valid email address is required'),

    body('code')
      .trim()
      .notEmpty()
      .withMessage('OTP code is required')
      .matches(/^\d{6}$/)
      .withMessage('OTP code must be a 6-digit number'),

    strongPassword(),
  ],
};

module.exports = authValidators;
