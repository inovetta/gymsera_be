const { Router } = require('express');
const packagesController = require('../controllers/platform-packages.controller');
const packagesValidators = require('../validators/platform-packages.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: PlatformPackages
 *   description: SaaS subscription packages available to gym hosts
 */

/**
 * @swagger
 * /platform-packages:
 *   get:
 *     summary: List all active packages
 *     description: Admins see all packages including inactive ones.
 *     tags: [PlatformPackages]
 *     security: []
 *     responses:
 *       200:
 *         description: List of packages
 */
router.get('/', packagesController.listPackages);

/**
 * @swagger
 * /platform-packages/{id}:
 *   get:
 *     summary: Get package detail
 *     tags: [PlatformPackages]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Package detail
 *       404:
 *         description: Package not found
 */
router.get('/:id', packagesController.getPackage);

/**
 * @swagger
 * /platform-packages:
 *   post:
 *     summary: Create a package (Admin only)
 *     tags: [PlatformPackages]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, price]
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               price:
 *                 type: number
 *               billingCycle:
 *                 type: string
 *                 enum: [MONTHLY, QUARTERLY, YEARLY]
 *               maxBranches:
 *                 type: integer
 *               maxTrainers:
 *                 type: integer
 *               maxMembers:
 *                 type: integer
 *               featureFlagsJson:
 *                 type: object
 *     responses:
 *       201:
 *         description: Package created
 */
router.post(
  '/',
  authenticate,
  authorize('PLATFORM_ADMIN'),
  validate(packagesValidators.createPackage),
  packagesController.createPackage
);

/**
 * @swagger
 * /platform-packages/{id}:
 *   patch:
 *     summary: Update a package (Admin only)
 *     tags: [PlatformPackages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
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
 *               price:
 *                 type: number
 *               billingCycle:
 *                 type: string
 *                 enum: [MONTHLY, QUARTERLY, YEARLY]
 *               maxBranches:
 *                 type: integer
 *               maxTrainers:
 *                 type: integer
 *               maxMembers:
 *                 type: integer
 *               featureFlagsJson:
 *                 type: object
 *               status:
 *                 type: string
 *                 enum: [ACTIVE, INACTIVE]
 *     responses:
 *       200:
 *         description: Package updated
 *       404:
 *         description: Package not found
 */
router.patch(
  '/:id',
  authenticate,
  authorize('PLATFORM_ADMIN'),
  validate(packagesValidators.updatePackage),
  packagesController.updatePackage
);

module.exports = router;
