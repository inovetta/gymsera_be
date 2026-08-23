const { Router } = require('express');
const controller = require('../controllers/trainers.controller');
const validators = require('../validators/trainers.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const tenantContext = require('../middleware/tenantContext');

const router = Router();

// All trainer management routes require auth + GYM_HOST/BRANCH_MANAGER + tenant context
router.use(authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'));

/**
 * @swagger
 * tags:
 *   name: Trainers
 *   description: Host-managed trainer profiles and branch assignment
 */

/**
 * @swagger
 * /trainers:
 *   get:
 *     summary: List trainer profiles for the gym
 *     tags: [Trainers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: branchId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ACTIVE, INACTIVE] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated list of trainers
 */
router.get('/', validate(validators.listTrainers), controller.listTrainers);

/**
 * @swagger
 * /trainers:
 *   post:
 *     summary: Create a trainer profile for a platform user
 *     tags: [Trainers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:             { type: string, format: uuid }
 *               branchId:           { type: string, format: uuid }
 *               specialization:     { type: string }
 *               bio:                { type: string }
 *               yearsExperience:    { type: integer, minimum: 0 }
 *               certificationsJson: { type: array }
 *               availabilityJson:   { type: object }
 *     responses:
 *       201:
 *         description: Trainer profile created
 *       409:
 *         description: Trainer already exists for this user
 */
router.post(
  '/',
  authorize('GYM_HOST'),
  validate(validators.createTrainer),
  controller.createTrainer
);

/**
 * @swagger
 * /trainers/{id}:
 *   patch:
 *     summary: Update a trainer profile
 *     tags: [Trainers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Trainer updated
 */
router.patch('/:id', validate(validators.updateTrainer), controller.updateTrainer);

/**
 * @swagger
 * /trainers/{id}/assign:
 *   post:
 *     summary: Assign a trainer to a branch
 *     tags: [Trainers]
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
 *             required: [branchId]
 *             properties:
 *               branchId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Trainer assigned to branch
 */
router.post(
  '/:id/assign',
  authorize('GYM_HOST'),
  validate(validators.assignTrainer),
  controller.assignTrainer
);

module.exports = router;
