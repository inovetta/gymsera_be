const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const tenantContext = require('../middleware/tenantContext');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');
const userValidators = require('../validators/users.validator');
const usersController = require('../controllers/users.controller');
const { UserRole } = require('../constants/roles');

const router = Router();

// All /users routes require authentication
router.use(authenticate);

const managerRoles = [UserRole.GYM_HOST, UserRole.BRANCH_MANAGER, UserRole.PLATFORM_ADMIN];

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: User/member management (staff access)
 */

/**
 * @swagger
 * /users:
 *   get:
 *     summary: Paginated member search
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Search by name, email or phone
 *       - in: query
 *         name: role
 *         schema: { type: string, enum: [MEMBER, TRAINER, GYM_HOST, BRANCH_MANAGER] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ACTIVE, INACTIVE, SUSPENDED] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated user list
 */
router.get(
  '/',
  authorize(...managerRoles),
  validate(userValidators.search),
  usersController.search
);

/**
 * @swagger
 * /users:
 *   post:
 *     summary: Staff creates a member account (bypasses OTP)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fullName, email]
 *             properties:
 *               fullName: { type: string }
 *               email: { type: string, format: email }
 *               phone: { type: string }
 *               password: { type: string }
 *               gender: { type: string, enum: [MALE, FEMALE, OTHER] }
 *               dateOfBirth: { type: string, format: date }
 *     responses:
 *       201:
 *         description: Member account created
 *       409:
 *         description: Email already registered
 */
router.post(
  '/',
  authorize(...managerRoles),
  validate(userValidators.createMember),
  usersController.create
);

/**
 * @swagger
 * /users/{id}:
 *   get:
 *     summary: Get user detail with profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User detail
 *       404:
 *         description: User not found
 */
router.get(
  '/:id',
  authorize(...managerRoles),
  tenantContext,
  validate(userValidators.getId),
  usersController.getById
);

/**
 * @swagger
 * /users/{id}:
 *   put:
 *     summary: Update user info (platform + tenant profile)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 */
router.put(
  '/:id',
  authorize(...managerRoles),
  tenantContext,
  validate(userValidators.update),
  usersController.update
);

/**
 * @swagger
 * /users/{id}/status:
 *   post:
 *     summary: Activate, deactivate or suspend a user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [ACTIVE, INACTIVE, SUSPENDED] }
 *               reason: { type: string }
 *     responses:
 *       200:
 *         description: Status updated
 */
router.post(
  '/:id/status',
  authorize(UserRole.GYM_HOST, UserRole.PLATFORM_ADMIN),
  validate(userValidators.setStatus),
  usersController.setStatus
);

/**
 * @swagger
 * /users/{id}/password:
 *   post:
 *     summary: Admin force-reset a user password
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/:id/password',
  authorize(UserRole.GYM_HOST, UserRole.PLATFORM_ADMIN),
  validate(userValidators.adminResetPassword),
  usersController.adminResetPassword
);

/**
 * @swagger
 * /users/{id}/profile-image:
 *   post:
 *     summary: Upload a profile image for a user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 */
router.post(
  '/:id/profile-image',
  authorize(...managerRoles),
  upload.image('image'),
  upload.handleMulterError,
  usersController.uploadProfileImage
);

/**
 * @swagger
 * /users/{id}/account-statement:
 *   get:
 *     summary: Full payment + membership history for a user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
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
router.get(
  '/:id/account-statement',
  authorize(...managerRoles),
  validate(userValidators.accountStatement),
  usersController.accountStatement
);

/**
 * @swagger
 * /users/{id}/account-statement/export:
 *   get:
 *     summary: Export account statement as PDF
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: PDF file
 *         content:
 *           application/pdf: {}
 */
router.get(
  '/:id/account-statement/export',
  authorize(...managerRoles),
  validate(userValidators.accountStatement),
  usersController.accountStatementExport
);

module.exports = router;
