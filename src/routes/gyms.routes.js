const { Router } = require('express');
const gymsController = require('../controllers/gyms.controller');
const gymsValidators = require('../validators/gyms.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const tenantContext = require('../middleware/tenantContext');
const upload = require('../middleware/upload');

const router = Router();

// All /gyms routes require a logged-in GYM_HOST (or BRANCH_MANAGER) + tenant DB
router.use(authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'));

/**
 * @swagger
 * tags:
 *   name: Gyms
 *   description: Gym profile and branch management for gym hosts
 */

// ── Gym profile ───────────────────────────────────────────────────────────────
/**
 * @swagger
 * /gyms/profile:
 *   get:
 *     summary: Get gym profile (auto-created on first access)
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Gym profile
 */
router.get('/profile', gymsController.getProfile);

router.post('/profile/logo', upload.image('logo'), upload.handleMulterError, gymsController.uploadLogo);
router.post('/profile/cover', upload.image('cover'), upload.handleMulterError, gymsController.uploadCover);
router.post('/profile/images', upload.images('images', 10), upload.handleMulterError, gymsController.uploadGymImages);
router.delete('/profile/images', gymsController.deleteGymImage);

/**
 * @swagger
 * /gyms/profile:
 *   patch:
 *     summary: Update gym profile — also syncs the public gym listing
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               contactPhone:
 *                 type: string
 *               contactEmail:
 *                 type: string
 *                 format: email
 *               website:
 *                 type: string
 *                 format: uri
 *               genderType:
 *                 type: string
 *                 enum: [MIXED, MALE_ONLY, FEMALE_ONLY]
 *               logoUrl:
 *                 type: string
 *                 format: uri
 *               coverImageUrl:
 *                 type: string
 *                 format: uri
 *               socialLinksJson:
 *                 type: object
 *     responses:
 *       200:
 *         description: Profile updated
 */
router.patch('/profile', validate(gymsValidators.updateProfile), gymsController.updateProfile);

// ── Branches ──────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /gyms/branches:
 *   get:
 *     summary: List all branches for the authenticated gym
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of branches
 */
router.get('/branches', gymsController.listBranches);

/**
 * @swagger
 * /gyms/branches:
 *   post:
 *     summary: Create a new branch (GYM_HOST only)
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [branchName]
 *             properties:
 *               branchName:
 *                 type: string
 *               address:
 *                 type: string
 *               cityId:
 *                 type: integer
 *               areaId:
 *                 type: integer
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               phone:
 *                 type: string
 *               openingTime:
 *                 type: string
 *                 example: "06:00"
 *               closingTime:
 *                 type: string
 *                 example: "22:00"
 *               facilitiesJson:
 *                 type: array
 *                 items:
 *                   type: string
 *               imagesJson:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uri
 *     responses:
 *       201:
 *         description: Branch created
 */
router.post(
  '/branches',
  authorize('GYM_HOST'),
  validate(gymsValidators.createBranch),
  gymsController.createBranch
);

/**
 * @swagger
 * /gyms/branches/{branchId}:
 *   get:
 *     summary: Get a single branch
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: branchId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Branch detail
 *       404:
 *         description: Branch not found
 */
router.get('/branches/:branchId', gymsController.getBranch);

/**
 * @swagger
 * /gyms/branches/{branchId}:
 *   patch:
 *     summary: Update a branch
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: branchId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Branch updated
 */
router.patch(
  '/branches/:branchId',
  validate(gymsValidators.updateBranch),
  gymsController.updateBranch
);

/**
 * @swagger
 * /gyms/branches/{branchId}:
 *   delete:
 *     summary: Deactivate a branch (soft delete)
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: branchId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Branch deactivated
 */
router.delete('/branches/:branchId', authorize('GYM_HOST'), gymsController.deleteBranch);

// ── Branch images ──────────────────────────────────────────────────────────────
router.post('/branches/:branchId/images', upload.images('images', 10), upload.handleMulterError, gymsController.uploadBranchImages);
router.delete('/branches/:branchId/images', gymsController.deleteBranchImage);

// ── Branch staff ──────────────────────────────────────────────────────────────
/**
 * @swagger
 * /gyms/branches/{branchId}/staff:
 *   get:
 *     summary: List active staff for a branch
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: branchId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: List of staff members
 */
router.get('/branches/:branchId/staff', gymsController.listStaff);

/**
 * @swagger
 * /gyms/branches/{branchId}/staff:
 *   post:
 *     summary: Assign a platform user as staff to a branch (GYM_HOST only)
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: branchId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *                 description: Platform user ID to assign
 *               designation:
 *                 type: string
 *                 example: Receptionist
 *     responses:
 *       201:
 *         description: Staff assigned
 *       409:
 *         description: User already assigned to this branch
 */
router.post(
  '/branches/:branchId/staff',
  authorize('GYM_HOST'),
  validate(gymsValidators.assignStaff),
  gymsController.assignStaff
);

/**
 * @swagger
 * /gyms/branches/{branchId}/staff/{staffId}:
 *   delete:
 *     summary: Remove a staff member from a branch (GYM_HOST only)
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: branchId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: staffId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Staff member removed
 */
router.delete(
  '/branches/:branchId/staff/:staffId',
  authorize('GYM_HOST'),
  validate(gymsValidators.removeStaff),
  gymsController.removeStaff
);

// ── Members (tenant-scoped) ───────────────────────────────────────────────────
// /members/search must be defined before /members to avoid :id conflicts
router.get('/members/search', gymsController.searchMember);
router.post('/members/enroll', gymsController.enrollMember);
router.get('/members', gymsController.listMembers);

// ── Gym-wide staff management (GYM_HOST only) ─────────────────────────────────
/**
 * @swagger
 * /gyms/staff:
 *   get:
 *     summary: List all active staff across all branches (GYM_HOST only)
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all staff members with their branch and user info
 */
router.get('/staff', authorize('GYM_HOST'), gymsController.listAllStaff);

/**
 * @swagger
 * /gyms/staff:
 *   post:
 *     summary: Create a new staff user (BRANCH_MANAGER) and assign to branches (GYM_HOST only)
 *     tags: [Gyms]
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
 *               fullName:             { type: string }
 *               email:                { type: string, format: email }
 *               phone:                { type: string }
 *               password:             { type: string, description: "Auto-generated if omitted" }
 *               designation:          { type: string, example: "Receptionist" }
 *               branchIds:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *                 description: Specific branches to assign (ignored if assignToAllBranches is true)
 *               assignToAllBranches:
 *                 type: boolean
 *                 description: If true, assign staff to all active branches
 *     responses:
 *       201:
 *         description: Staff user created and assigned to branches
 *       409:
 *         description: Email already registered
 */
router.post('/staff', authorize('GYM_HOST'), gymsController.createStaffUser);

/**
 * @swagger
 * /gyms/staff/{userId}:
 *   delete:
 *     summary: Remove a staff user from all branches (GYM_HOST only)
 *     tags: [Gyms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Staff removed from all branches
 */
router.delete('/staff/:userId', authorize('GYM_HOST'), gymsController.removeStaffUser);

module.exports = router;
