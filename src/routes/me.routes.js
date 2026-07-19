const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');
const meValidators = require('../validators/me.validator');
const subscriptionValidators = require('../validators/subscriptions.validator');
const meController = require('../controllers/me.controller');
const subscriptionsController = require('../controllers/subscriptions.controller');

const router = Router();

// All /me routes require authentication
router.use(authenticate);

/**
 * @swagger
 * tags:
 *   name: Me
 *   description: Authenticated user self-service endpoints
 */

/**
 * @swagger
 * /me/profile:
 *   get:
 *     summary: Get own full profile (DB lookup)
 *     tags: [Me]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Full user profile
 */
router.get('/profile', meController.getProfile);

/**
 * @swagger
 * /me/profile:
 *   put:
 *     summary: Update own name, phone, fitness fields
 *     tags: [Me]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fullName: { type: string }
 *               phone: { type: string }
 *               gender: { type: string, enum: [MALE, FEMALE, OTHER] }
 *               dateOfBirth: { type: string, format: date }
 *               heightCm: { type: number }
 *               weightKg: { type: number }
 *               fitnessGoal: { type: string }
 *     responses:
 *       200:
 *         description: Updated profile
 */
router.put('/profile', validate(meValidators.updateProfile), meController.updateProfile);
// Alias: PATCH /me/profile (web portal sends PATCH)
router.patch('/profile', validate(meValidators.updateProfile), meController.updateProfile);

/**
 * @swagger
 * /me/password:
 *   post:
 *     summary: Change own password (must supply current password)
 *     tags: [Me]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string }
 *               newPassword: { type: string }
 *     responses:
 *       200:
 *         description: Password changed
 *       401:
 *         description: Current password incorrect
 */
router.post('/password', validate(meValidators.changePassword), meController.changePassword);
// Alias: POST /me/change-password (web portal uses this path)
router.post('/change-password', validate(meValidators.changePassword), meController.changePassword);

/**
 * @swagger
 * /me/profile-image:
 *   post:
 *     summary: Upload own profile image
 *     tags: [Me]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               image: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Profile image updated
 */
router.post('/profile-image', upload.image('image'), upload.handleMulterError, meController.uploadProfileImage);
// Alias: POST /me/profile/image (web portal uses this path)
router.post('/profile/image', upload.image('image'), upload.handleMulterError, meController.uploadProfileImage);

/**
 * @swagger
 * /me/subscriptions:
 *   get:
 *     summary: List all of the authenticated user's gym memberships (cross-tenant)
 *     tags: [Me]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, ACTIVE, FROZEN, EXPIRED, CANCELLED]
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 50 }
 */
router.get(
  '/subscriptions',
  validate(subscriptionValidators.listMySubscriptions),
  subscriptionsController.listMySubscriptions
);

/**
 * @swagger
 * /me/account-statement:
 *   get:
 *     summary: Combined subscriptions + payments history
 *     tags: [Me]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 */
router.get('/account-statement', validate(meValidators.accountStatement), meController.accountStatement);

/**
 * @swagger
 * /me/account-statement/export:
 *   get:
 *     summary: Download account statement as PDF
 *     tags: [Me]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: PDF download
 *         content:
 *           application/pdf: {}
 */
router.get('/account-statement/export', meController.accountStatementExport);

/**
 * @swagger
 * /me/payment-requests:
 *   get:
 *     summary: View own pending payment requests
 *     tags: [Me]
 *     security:
 *       - bearerAuth: []
 */
router.get('/payment-requests', meController.getPaymentRequests);

/**
 * @swagger
 * /me/payment-request:
 *   post:
 *     summary: Submit a manual payment request
 *     tags: [Me]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subscriptionId, method, amount]
 *             properties:
 *               subscriptionId: { type: string, format: uuid }
 *               method: { type: string, enum: [CASH, BANK_TRANSFER, ONLINE, POS] }
 *               amount: { type: number }
 *               notes: { type: string }
 *     responses:
 *       201:
 *         description: Payment request submitted
 */
router.post('/payment-request', validate(meValidators.submitPaymentRequest), meController.submitPaymentRequest);

/**
 * @swagger
 * /me/payment-requests/{id}/proof:
 *   post:
 *     summary: Upload bank receipt image for a payment request
 *     tags: [Me]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               image: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Proof uploaded
 */
router.post(
  '/payment-requests/:id/proof',
  validate(meValidators.proofId),
  upload.image('image'),
  upload.handleMulterError,
  meController.uploadPaymentProof
);

// ── Aliases for web portal (uses /payments instead of /payment-requests) ──────
router.get('/payments', meController.getPaymentRequests);
router.post('/payments', validate(meValidators.submitPaymentRequest), meController.submitPaymentRequest);
router.post(
  '/payments/:id/proof',
  validate(meValidators.proofId),
  upload.image('image'),
  upload.handleMulterError,
  meController.uploadPaymentProof
);

// ── Subscription detail (member self-serve, no tenant context needed) ─────────
router.get('/subscriptions/:id', subscriptionsController.getMySubscriptionDetail);

// ── Attendance logs (cross-tenant, resolved via subscriptionId query param) ───
router.get('/attendance', meController.getMyAttendance);

// ── Wishlist / Saved Gyms ────────────────────────────────────────────────────
router.get('/saved-gyms', meController.getSavedGyms);
router.post('/saved-gyms/:gymId', meController.saveGym);
router.delete('/saved-gyms/:gymId', meController.unsaveGym);

// ── Account Deletion Request ──────────────────────────────────────────────────
router.post('/request-deletion', meController.requestDeletion);

// ── Traveler Inbox ────────────────────────────────────────────────────────────
router.get('/inbox', meController.listMyInbox);
router.get('/inbox/:conversationId', meController.getMyConversation);
router.post('/inbox/:conversationId/reply', meController.replyToMyConversation);
router.patch('/inbox/:conversationId/read', meController.markMyConversationRead);

module.exports = router;

