const { Router } = require('express');
const authController = require('../controllers/auth.controller');
const authValidators = require('../validators/auth.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication and identity endpoints
 */

// ── POST /auth/register ───────────────────────────────────────────────────────
/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user account
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fullName, email, password]
 *             properties:
 *               fullName:
 *                 type: string
 *                 example: Ahmed Hassan
 *               email:
 *                 type: string
 *                 format: email
 *                 example: ahmed@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: Str0ng!Pass
 *               phone:
 *                 type: string
 *                 example: "+923001234567"
 *     responses:
 *       201:
 *         description: Registration successful, OTP sent to email
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         userId:
 *                           type: string
 *                           format: uuid
 *                         email:
 *                           type: string
 *       409:
 *         description: Email already registered
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: Validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/register', validate(authValidators.register), authController.register);

// ── POST /auth/otp/verify ─────────────────────────────────────────────────────
/**
 * @swagger
 * /auth/otp/verify:
 *   post:
 *     summary: Verify email OTP and activate account
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, code]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               code:
 *                 type: string
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Account verified — returns access + refresh tokens
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         accessToken:
 *                           type: string
 *                         refreshToken:
 *                           type: string
 *                         user:
 *                           type: object
 *       400:
 *         description: Invalid or expired OTP
 */
router.post('/otp/verify', validate(authValidators.verifyOtp), authController.verifyOtp);

// ── POST /auth/otp/resend ─────────────────────────────────────────────────────
/**
 * @swagger
 * /auth/otp/resend:
 *   post:
 *     summary: Resend email verification OTP
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: OTP resent (same message whether email exists or not)
 */
router.post('/otp/resend', validate(authValidators.resendOtp), authController.resendOtp);

// ── POST /auth/login ──────────────────────────────────────────────────────────
/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login with email and password
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: ahmed@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: Str0ng!Pass
 *     responses:
 *       200:
 *         description: Login successful — returns access + refresh tokens
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         accessToken:
 *                           type: string
 *                         refreshToken:
 *                           type: string
 *                         user:
 *                           type: object
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: Account not verified or suspended
 */
router.post('/login', validate(authValidators.login), authController.login);

// ── POST /auth/social/google ──────────────────────────────────────────────────
/**
 * @swagger
 * /auth/social/google:
 *   post:
 *     summary: Login or register via Google ID Token
 *     description: Validates a Google ID token from the client (Firebase/Google Sign-In). Creates the user on first login.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Google ID token from the client
 *     responses:
 *       200:
 *         description: Google login successful — returns access + refresh tokens
 *       401:
 *         description: Invalid Google ID token
 */
router.post('/social/google', validate(authValidators.googleLogin), authController.googleLogin);

// ── POST /auth/refresh ────────────────────────────────────────────────────────
/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Rotate refresh token — issue a new access + refresh token pair
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: New token pair issued
 *       401:
 *         description: Invalid, expired, or revoked refresh token
 */
router.post('/refresh', validate(authValidators.refreshToken), authController.refreshToken);

// ── POST /auth/password-reset/request ────────────────────────────────────────
/**
 * @swagger
 * /auth/password-reset/request:
 *   post:
 *     summary: Request a password reset OTP via email
 *     description: Always returns success to prevent email enumeration.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Reset code sent (if account exists)
 */
router.post(
  '/password-reset/request',
  validate(authValidators.passwordResetRequest),
  authController.passwordResetRequest
);

// ── POST /auth/password-reset/confirm ────────────────────────────────────────
/**
 * @swagger
 * /auth/password-reset/confirm:
 *   post:
 *     summary: Confirm password reset using OTP and set new password
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, code, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               code:
 *                 type: string
 *                 example: "123456"
 *               password:
 *                 type: string
 *                 format: password
 *                 description: New password (must meet strength requirements)
 *     responses:
 *       200:
 *         description: Password reset successful
 *       400:
 *         description: Invalid or expired code
 */
router.post(
  '/password-reset/confirm',
  validate(authValidators.passwordResetConfirm),
  authController.passwordResetConfirm
);

// ── GET /auth/me ──────────────────────────────────────────────────────────────
/**
 * @swagger
 * /auth/me:
 *   get:
 *     summary: Introspect current JWT — returns decoded token payload (no DB call)
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token payload returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         sub:
 *                           type: string
 *                           format: uuid
 *                         email:
 *                           type: string
 *                         role:
 *                           type: string
 *                         tenantId:
 *                           type: string
 *                           nullable: true
 *                         isVerified:
 *                           type: boolean
 *       401:
 *         description: Missing or invalid token
 */
router.get('/me', authenticate, authController.me);

module.exports = router;
