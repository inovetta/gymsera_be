const { Router } = require('express');
const tenantsController = require('../controllers/tenants.controller');
const tenantsValidators = require('../validators/tenants.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const upload = require('../middleware/upload');

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
 *               organizationName:
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
  validate.strict(tenantsValidators.updateMyTenant, { stage: 2 }),
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
 *             required: [email]
 *             properties:
 *               organizationName:
 *                 type: string
 *                 description: Optional (R-112). Build 26 sends none; the brand is saved on Step 2 (gym-profile).
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
  validate.strict(tenantsValidators.register, { stage: 2, allow: ['areaId', 'areaRequestId'] }),
  tenantsController.register
);

/**
 * @swagger
 * /tenants/{id}/first-business:
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
 *             required: [firstBusinessName]
 *             properties:
 *               organizationName:
 *                 type: string
 *                 description: The brand / organisation name (R-112), 3 to 60 characters; 422 brand_name_invalid / brand_name_blocked.
 *                 example: Iron Temple
 *               firstBusinessName:
 *                 type: string
 *                 example: Iron Temple Fitness
 *               firstBusinessDescription:
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
  '/:organizationId/first-business',
  authenticate,
  authorize('GYM_HOST'),
  validate.strict(tenantsValidators.submitGymProfile, { stage: 2 }),
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
  '/:organizationId/select-package',
  authenticate,
  authorize('GYM_HOST'),
  validate.strict(tenantsValidators.selectPackage, { stage: 2 }),
  tenantsController.selectPackage
);

/**
 * @swagger
 * /tenants/{id}/first-business/images:
 *   post:
 *     summary: Upload Step 4 (branch photos) images during onboarding
 *     description: >
 *       No Branch row exists yet at this point — provisioning only runs on
 *       admin approval — so these are held on the platform Tenant row's
 *       firstBranchDraft.imagesJson until then, same as every other Step
 *       2/4 field.
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
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               images:
 *                 type: array
 *                 items: { type: string, format: binary }
 *     responses:
 *       200: { description: Images uploaded }
 *   put:
 *     summary: Replace the full onboarding images list (how a removal round-trips)
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
 *             required: [imagesJson]
 *             properties:
 *               imagesJson:
 *                 type: array
 *                 items: { type: string, format: uri }
 *     responses:
 *       200: { description: Images updated }
 */
router.post(
  '/:organizationId/first-business/images',
  authenticate,
  authorize('GYM_HOST'),
  upload.images('images', 10),
  upload.handleMulterError,
  validate.allowBody([]), tenantsController.uploadOnboardingImages
);
router.put(
  '/:organizationId/first-business/images',
  authenticate,
  authorize('GYM_HOST'),
  validate.allowBody(['imagesJson']),
  tenantsController.replaceOnboardingImages
);

// FLOW-04: a rejected host reopens the same application (REJECTED → DRAFT), edits it and submits again.
router.post(
  '/:organizationId/reapply',
  authenticate,
  authorize('GYM_HOST'),
  validate.allowBody([]),
  tenantsController.reapplyTenant
);

router.post(
  '/:organizationId/finalize',
  authenticate,
  authorize('GYM_HOST'),
  validate.allowBody(['paymentMethod', 'bankTransferRef']),
  tenantsController.finalizeApplication
);

// ── KYC Document endpoints (SEC-10) ──────────────────────────────────────────
router.post(
  '/:organizationId/kyc-documents',
  authenticate,
  upload.documents('documents', 5),
  upload.handleMulterError,
  validate.allowBody(['documentType']), tenantsController.uploadKycDocuments
);

router.get(
  '/:organizationId/kyc-documents',
  authenticate,
  tenantsController.getKycDocuments
);

router.get(
  '/:organizationId/kyc-documents/:documentId/stream',
  authenticate,
  tenantsController.streamKycDocument
);

router.delete(
  '/:organizationId/kyc-documents/:documentId',
  authenticate,
  validate.allowBody([]),
  tenantsController.deleteKycDocument
);

module.exports = router;

