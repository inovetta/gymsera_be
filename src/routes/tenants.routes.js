const { Router } = require('express');
const tenantsController = require('../controllers/tenants.controller');
const tenantsValidators = require('../validators/tenants.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Tenants
 *   description: Gym host onboarding and tenant management
 */

/**
 * @swagger
 * /tenants/me:
 *   get:
 *     summary: Get the current gym host's tenant profile
 *     tags: [Tenants]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tenant profile
 *       404:
 *         description: No tenant found for this account
 */
router.get('/me', authenticate, authorize('GYM_HOST'), tenantsController.getMyTenant);

/**
 * @swagger
 * /tenants/me:
 *   patch:
 *     summary: Update the current gym host's business profile
 *     tags: [Tenants]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               businessName:
 *                 type: string
 *                 maxLength: 200
 *                 example: Iron Temple Fitness
 *               email:
 *                 type: string
 *                 format: email
 *                 example: info@irontemple.com
 *               phone:
 *                 type: string
 *                 example: "+923001234567"
 *               cityId:
 *                 type: integer
 *                 example: 1
 *     responses:
 *       200:
 *         description: Business profile updated
 *       404:
 *         description: No tenant registered for this account
 */
router.patch(
  '/me',
  authenticate,
  authorize('GYM_HOST'),
  validate(tenantsValidators.updateMyTenant),
  tenantsController.updateMyTenant
);

/**
 * @swagger
 * /tenants/register:
 *   post:
 *     summary: Register a new gym business (promotes caller to GYM_HOST role)
 *     description: Any verified user can register as a gym host. This creates a tenant in PENDING_REVIEW status and upgrades the caller's role to GYM_HOST.
 *     tags: [Tenants]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [businessName, email]
 *             properties:
 *               businessName:
 *                 type: string
 *                 example: Iron Temple Fitness
 *               email:
 *                 type: string
 *                 format: email
 *                 example: info@irontemple.com
 *               phone:
 *                 type: string
 *                 example: "+923001234567"
 *               cityId:
 *                 type: integer
 *                 example: 1
 *     responses:
 *       201:
 *         description: Gym business registered — now under review
 *       409:
 *         description: User has already registered a gym business
 */
router.post(
  '/register',
  authenticate,
  validate(tenantsValidators.register),
  tenantsController.register
);

/**
 * @swagger
 * /tenants/{id}/gym-profile:
 *   post:
 *     summary: Submit gym profile and KYC documents
 *     tags: [Tenants]
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
 *         application/json:
 *           schema:
 *             type: object
 *             required: [gymName]
 *             properties:
 *               gymName:
 *                 type: string
 *                 example: Iron Temple Fitness
 *               gymDescription:
 *                 type: string
 *               genderType:
 *                 type: string
 *                 enum: [MIXED, MALE_ONLY, FEMALE_ONLY]
 *               address:
 *                 type: string
 *               kycDocumentsJson:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uri
 *               logoUrl:
 *                 type: string
 *                 format: uri
 *               coverImageUrl:
 *                 type: string
 *                 format: uri
 *     responses:
 *       200:
 *         description: Gym profile submitted
 *       404:
 *         description: Tenant not found
 */
router.post(
  '/:id/gym-profile',
  authenticate,
  authorize('GYM_HOST'),
  validate(tenantsValidators.submitGymProfile),
  tenantsController.submitGymProfile
);

/**
 * @swagger
 * /tenants/{id}/select-package:
 *   post:
 *     summary: Select a SaaS subscription package
 *     tags: [Tenants]
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
 *         application/json:
 *           schema:
 *             type: object
 *             required: [packageId]
 *             properties:
 *               packageId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Package selected
 *       404:
 *         description: Tenant or package not found
 */
router.post(
  '/:id/select-package',
  authenticate,
  authorize('GYM_HOST'),
  validate(tenantsValidators.selectPackage),
  tenantsController.selectPackage
);

router.post(
  '/:id/finalize',
  authenticate,
  authorize('GYM_HOST'),
  tenantsController.finalizeApplication
);

module.exports = router;
