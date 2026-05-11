const { Router } = require('express');
const citiesController = require('../controllers/cities.controller');
const citiesValidators = require('../validators/cities.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Cities
 *   description: City and area management
 */

/**
 * @swagger
 * /cities:
 *   get:
 *     summary: List all cities
 *     description: Returns active cities. Admins also see inactive cities.
 *     tags: [Cities]
 *     security: []
 *     responses:
 *       200:
 *         description: List of cities
 */
router.get('/', citiesController.listCities);

/**
 * @swagger
 * /cities/{id}/areas:
 *   get:
 *     summary: List areas for a city
 *     tags: [Cities]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: City and its areas
 *       404:
 *         description: City not found
 */
router.get('/:id/areas', citiesController.listAreas);

/**
 * @swagger
 * /cities:
 *   post:
 *     summary: Create a city (Admin only)
 *     tags: [Cities]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *               isActive:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: City created
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  authorize('PLATFORM_ADMIN'),
  validate(citiesValidators.createCity),
  citiesController.createCity
);

/**
 * @swagger
 * /cities/{id}:
 *   patch:
 *     summary: Update a city (Admin only)
 *     tags: [Cities]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: City updated
 *       404:
 *         description: City not found
 */
router.patch(
  '/:id',
  authenticate,
  authorize('PLATFORM_ADMIN'),
  validate(citiesValidators.updateCity),
  citiesController.updateCity
);

/**
 * @swagger
 * /cities/{id}/areas:
 *   post:
 *     summary: Create an area in a city (Admin only)
 *     tags: [Cities]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       201:
 *         description: Area created
 */
router.post(
  '/:id/areas',
  authenticate,
  authorize('PLATFORM_ADMIN'),
  validate(citiesValidators.createArea),
  citiesController.createArea
);

/**
 * @swagger
 * /cities/{id}/areas/{areaId}:
 *   patch:
 *     summary: Update an area (Admin only)
 *     tags: [Cities]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: areaId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Area updated
 */
router.patch(
  '/:id/areas/:areaId',
  authenticate,
  authorize('PLATFORM_ADMIN'),
  validate(citiesValidators.updateArea),
  citiesController.updateArea
);

module.exports = router;
