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

/**
 * NEW-302: the email of every auth body. A space inside an address is never valid, but it is what a "+"
 * becomes when a client puts the address in a URL query without encoding it (builds 27 / 28 open
 * `/auth/otp-verify?email=a+b@x.com`, and `Uri.queryParameters` decodes "+" as a space). So, after
 * trimming, each space inside the address is read as "+" before the format check and every lookup.
 */
const plusFromSpaces = (value) => (typeof value === 'string' ? value.trim().replace(/ /g, '+') : value);

const emailField = () =>
  body('email')
    .customSanitizer(plusFromSpaces)
    .toLowerCase()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('A valid email address is required');

const authValidators = {
  register: [
    body('fullName')
      .trim()
      .notEmpty()
      .withMessage('Full name is required')
      .isLength({ max: 100 })
      .withMessage('Full name must be 100 characters or fewer'),

    emailField(),

    strongPassword(),

    body('phone')
      .optional({ nullable: true, checkFalsy: true })
      .isMobilePhone()
      .withMessage('A valid phone number is required'),
  ],

  login: [
    emailField(),

    body('password').notEmpty().withMessage('Password is required'),
  ],

  verifyOtp: [
    emailField(),

    body('code')
      .trim()
      .notEmpty()
      .withMessage('OTP code is required')
      .matches(/^\d{6}$/)
      .withMessage('OTP code must be a 6-digit number'),
  ],

  resendOtp: [
    emailField(),
  ],

  googleLogin: [
    body('idToken').notEmpty().withMessage('Google ID token is required'),
  ],

  appleLogin: [
    body('identityToken').notEmpty().withMessage('Apple identity token is required'),
    body('authorizationCode').optional().isString().isLength({ max: 2000 }),
    // Apple sends the name only on the first sign-in, so the app passes it along.
    body('fullName').optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
  ],

  refreshToken: [
    body('refreshToken').notEmpty().withMessage('Refresh token is required'),
  ],

  passwordResetRequest: [
    emailField(),
  ],

  passwordResetConfirm: [
    emailField(),

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
module.exports.plusFromSpaces = plusFromSpaces;
