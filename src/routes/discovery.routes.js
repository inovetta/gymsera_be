const { Router } = require('express');
const controller  = require('../controllers/discovery.controller');
const validators  = require('../validators/discovery.validator');
const validate    = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize    = require('../middleware/authorize');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Discovery
 *   description: Public gym discovery — home page, map, featured, top-rated, reviews
 */

// ─────────────────────────────────────────────────────────────────────────────
// Cities (public)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /discovery/cities:
 *   get:
 *     summary: List all cities with active gym counts — for home page city picker
 *     tags: [Discovery]
 *     security: []
 *     responses:
 *       200:
 *         description: Cities with gym count
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
 *                         cities:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:       { type: integer }
 *                               name:     { type: string }
 *                               gymCount: { type: integer }
 */
router.get('/cities', controller.listCities);

// ─────────────────────────────────────────────────────────────────────────────
// Special gym list endpoints — must come BEFORE /gyms/:id to avoid path clash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /discovery/gyms/featured:
 *   get:
 *     summary: Get featured gyms — for home page featured section
 *     tags: [Discovery]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 12, maximum: 50 }
 *     responses:
 *       200:
 *         description: Featured gym listings
 */
router.get('/gyms/featured', controller.featuredGyms);

/**
 * @swagger
 * /discovery/gyms/top-rated:
 *   get:
 *     summary: Get top-rated gyms — for home page top-rated section
 *     tags: [Discovery]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: cityId
 *         schema: { type: integer }
 *         description: Filter top-rated to a specific city
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 12, maximum: 50 }
 *     responses:
 *       200:
 *         description: Top-rated gym listings
 */
router.get('/gyms/top-rated', controller.topRatedGyms);

/**
 * @swagger
 * /discovery/gyms/nearby:
 *   get:
 *     summary: Find gyms near a location using GPS coordinates
 *     tags: [Discovery]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: lat
 *         required: true
 *         schema: { type: number, format: float }
 *         description: User's latitude
 *       - in: query
 *         name: lng
 *         required: true
 *         schema: { type: number, format: float }
 *         description: User's longitude
 *       - in: query
 *         name: radius
 *         schema: { type: number, default: 10 }
 *         description: Search radius in km (max 100)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Nearby gyms sorted by distance
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
 *                         gyms:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               distanceKm: { type: number }
 */
router.get('/gyms/nearby', validate(validators.nearbyGyms), controller.nearbyGyms);

/**
 * @swagger
 * /discovery/gyms/map:
 *   get:
 *     summary: Get lightweight gym pin data for map view (lat/lng + rating + logo)
 *     tags: [Discovery]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: cityId
 *         schema: { type: integer }
 *         description: Scope map pins to a specific city
 *     responses:
 *       200:
 *         description: Array of map pins
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
 *                         gyms:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:            { type: string, format: uuid }
 *                               title:         { type: string }
 *                               latitude:      { type: number }
 *                               longitude:     { type: number }
 *                               averageRating: { type: number }
 *                               logoUrl:       { type: string }
 */
router.get('/gyms/map', validate(validators.mapGyms), controller.mapGyms);

// ─────────────────────────────────────────────────────────────────────────────
// General gym directory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /discovery/gyms:
 *   get:
 *     summary: List active gyms — public directory with filters, city filter, and pagination
 *     tags: [Discovery]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: cityId
 *         schema: { type: integer }
 *         description: Filter by city — used on city gym listing page
 *       - in: query
 *         name: areaId
 *         schema: { type: integer }
 *       - in: query
 *         name: genderType
 *         schema: { type: string, enum: [MIXED, MALE_ONLY, FEMALE_ONLY] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: featured
 *         schema: { type: boolean }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 12, maximum: 50 }
 *     responses:
 *       200:
 *         description: Paginated gym listings
 */
router.get('/gyms', validate(validators.listGyms), controller.listGyms);

/**
 * @swagger
 * /discovery/gyms/{id}:
 *   get:
 *     summary: Get public gym detail including available membership plans
 *     tags: [Discovery]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Gym detail with membership plans
 *       404:
 *         description: Gym not found
 */
router.get('/gyms/:id', validate(validators.getGym), controller.getGym);
router.get('/gyms/:id/payment-details', authenticate, controller.getPaymentDetails);

// ─────────────────────────────────────────────────────────────────────────────
// Reviews
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /discovery/gyms/{id}/reviews:
 *   get:
 *     summary: List approved reviews for a gym (public)
 *     tags: [Discovery]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200:
 *         description: Paginated approved reviews
 */
router.get('/gyms/:id/reviews', validate(validators.getGym), controller.listReviews);

/**
 * @swagger
 * /discovery/gyms/{id}/reviews:
 *   post:
 *     summary: Submit a review for a gym (authenticated members only)
 *     description: Requires an active or past membership at this gym. One review per user per gym. Starts as PENDING until admin approves.
 *     tags: [Discovery]
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
 *             required: [rating]
 *             properties:
 *               rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *               title:
 *                 type: string
 *                 maxLength: 150
 *               body:
 *                 type: string
 *                 maxLength: 2000
 *     responses:
 *       201:
 *         description: Review submitted, pending admin approval
 *       403:
 *         description: Not a member of this gym
 *       409:
 *         description: Already reviewed this gym
 */
router.post(
  '/gyms/:id/reviews',
  authenticate,
  validate(validators.submitReview),
  controller.submitReview
);

module.exports = router;


/**
 * @swagger
 * tags:
 *   name: Discovery
 *   description: Public gym discovery and directory
 */

/**
 * @swagger
 * /discovery/gyms:
 *   get:
 *     summary: List active gyms — public directory with filters and pagination
 *     tags: [Discovery]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: cityId
 *         schema: { type: integer }
 *         description: Filter by city
 *       - in: query
 *         name: areaId
 *         schema: { type: integer }
 *         description: Filter by area within a city
 *       - in: query
 *         name: genderType
 *         schema:
 *           type: string
 *           enum: [MIXED, MALE_ONLY, FEMALE_ONLY]
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by gym name
 *       - in: query
 *         name: featured
 *         schema: { type: boolean }
 *         description: Show only featured gyms
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 12, maximum: 50 }
 *     responses:
 *       200:
 *         description: Paginated list of gym listings
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
 *                         gyms:
 *                           type: array
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         total: { type: integer }
 *                         page: { type: integer }
 *                         limit: { type: integer }
 *                         totalPages: { type: integer }
 */
router.get('/gyms', validate(validators.listGyms), controller.listGyms);

/**
 * @swagger
 * /discovery/gyms/{id}:
 *   get:
 *     summary: Get public gym detail including available membership plans
 *     tags: [Discovery]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: GymListing UUID
 *     responses:
 *       200:
 *         description: Gym listing detail with membership plans
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
 *                         gym:
 *                           type: object
 *                         membershipPlans:
 *                           type: array
 *       404:
 *         description: Gym not found or inactive
 */
router.get('/gyms/:id', validate(validators.getGym), controller.getGym);

module.exports = router;
