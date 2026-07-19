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

router.get('/seed-conversations', async (req, res, next) => {
  try {
    const { Tenant, GymListing, User, Conversation, Message } = require('../models/platform');
    const { Op } = require('sequelize');
    const crypto = require('crypto');

    const dummyConversations = [
      {
        type: 'MEMBER',
        messages: [
          { text: "Hey! Is the squat rack at the Warehouse location free around 5 PM? Looking to get a heavy session in.", senderType: 'USER' },
          { text: "Hi! Yes, the 5 PM slot is usually quiet on Tuesdays. We have three squat racks, so you should be good.", senderType: 'HOST' },
          { text: "Awesome. Do I need a new entry code or will my current one work?", senderType: 'USER' },
          { text: "Your current QR code will work fine. Valid for the next 30 days.", senderType: 'HOST' },
          { text: "Perfect. One more thing — can I bring a guest tomorrow?", senderType: 'USER' },
          { text: "Yes! Guests are welcome. Just register them at the reception with your member ID.", senderType: 'HOST' },
          { text: "Amazing, thanks! See you tomorrow.", senderType: 'USER' },
          { text: "See you then! Have a great workout 💪", senderType: 'HOST' }
        ]
      },
      {
        type: 'INQUIRY',
        messages: [
          { text: "Hi, I'm interested in joining. Do you offer student discounts on the Premium Monthly plan?", senderType: 'USER' },
          { text: "Hello! Yes, we offer a 15% discount for students with a valid student ID. You can register at the front desk.", senderType: 'HOST' },
          { text: "Regarding membership pause policy, what's the limit? Can I pause for 2 weeks?", senderType: 'USER' }
        ]
      },
      {
        type: 'MEMBER',
        messages: [
          { text: "Hey, my locker key isn't working today. Can someone help me at 5pm?", senderType: 'USER' }
        ]
      }
    ];

    const tenants = await Tenant.findAll();
    const users = await User.findAll({ where: { role: 'MEMBER' } });
    if (users.length === 0) {
      return res.json({ success: false, message: "No member users found to seed conversations" });
    }

    let seededCount = 0;

    for (const tenant of tenants) {
      const listings = await GymListing.findAll({ where: { tenantId: tenant.id } });
      for (const listing of listings) {
        if (!listing.branchId) continue;

        for (let i = 0; i < Math.min(dummyConversations.length, users.length); i++) {
          const user = users[i];
          const dummy = dummyConversations[i];

          let conversation = await Conversation.findOne({
            where: {
              tenantId: tenant.id,
              branchId: listing.branchId,
              userId: user.id,
              type: dummy.type
            }
          });

          if (!conversation) {
            conversation = await Conversation.create({
              tenantId: tenant.id,
              branchId: listing.branchId,
              userId: user.id,
              type: dummy.type,
              unreadCountHost: 0,
              unreadCountUser: 0
            });
          }

          let lastMsg = null;
          let unreadHost = 0;
          let unreadUser = 0;

          for (const msgData of dummy.messages) {
            const existingMsg = await Message.findOne({
              where: {
                conversationId: conversation.id,
                text: msgData.text
              }
            });

            if (!existingMsg) {
              const senderId = msgData.senderType === 'USER' ? user.id : tenant.ownerUserId;
              const createdMsg = await Message.create({
                conversationId: conversation.id,
                senderId: senderId || null,
                senderType: msgData.senderType,
                text: msgData.text,
                isRead: false
              });
              lastMsg = createdMsg;

              if (msgData.senderType === 'USER') {
                unreadHost++;
              } else if (msgData.senderType === 'HOST') {
                unreadUser++;
              }
            } else {
              lastMsg = existingMsg;
            }
          }

          if (lastMsg) {
            await conversation.update({
              lastMessageText: lastMsg.text,
              lastMessageAt: lastMsg.createdAt,
              unreadCountHost: unreadHost,
              unreadCountUser: unreadUser
            });
            seededCount++;
          }
        }
      }
    }

    return res.json({ success: true, seededCount });
  } catch (err) {
    next(err);
  }
});




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
router.get('/organizations', controller.listOrganizations);
router.get('/organizations/:gymId/branches', controller.listOrganizationBranches);
router.get('/top-hosts', controller.getTopHosts);
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

router.post(
  '/branches/:branchId/inquiries',
  authenticate,
  validate(validators.submitInquiry),
  controller.submitInquiry
);

router.get(
  '/branches/:branchId/reviews/summary',
  validate(validators.getBranchReviewsSummary),
  controller.getBranchReviewsSummary
);

router.get(
  '/branches/:branchId/reviews',
  validate(validators.getBranchReviews),
  controller.listBranchReviews
);

router.post(
  '/branches/:branchId/reviews',
  authenticate,
  validate(validators.submitBranchReview),
  controller.submitBranchReview
);

router.get('/debug-activate-branches', async (req, res, next) => {
  try {
    const { Tenant } = require('../models/platform');
    const registerTenantModels = require('../models/tenant');
    const { decrypt } = require('../utils/crypto.utils');
    const { Sequelize } = require('sequelize');

    const tenants = await Tenant.findAll();
    let logs = [];

    for (const tenant of tenants) {
      if (tenant.connectionStringEncrypted && tenant.connectionStringEncrypted !== 'PENDING_PROVISIONING') {
        const connUrl = decrypt(tenant.connectionStringEncrypted);
        const tenantSeq = new Sequelize(connUrl, {
          dialect: 'mysql',
          logging: false,
        });
        try {
          await tenantSeq.authenticate();
          const models = registerTenantModels(tenantSeq);
          const { Branch } = models;

          const [affectedCount] = await Branch.update(
            { travelerVisibilityStatus: 'active' },
            { where: { status: 'ACTIVE' } }
          );
          logs.push(`Updated ${affectedCount} active branches to visible on tenant: ${tenant.tenantCode}`);
        } catch (err) {
          logs.push(`Failed to update tenant: ${tenant.tenantCode}: ${err.message}`);
        } finally {
          await tenantSeq.close();
        }
      }
    }
    res.json({ success: true, logs });
  } catch (err) {
    next(err);
  }
});
module.exports = router;
