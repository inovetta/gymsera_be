const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const controller = require('../controllers/billing.controller');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Billing
 *   description: Branch-count subscription catalog and store-verified purchase sync
 */

/**
 * @swagger
 * /billing/plans:
 *   get:
 *     summary: The branch-count pricing staircase
 *     description: >
 *       Every platform's app reads this instead of hardcoding a product ID
 *       or price — pass `?platform=ios|android|web` to get just that
 *       platform's product identifiers alongside the display price.
 *     tags: [Billing]
 *     parameters:
 *       - { in: query, name: platform, schema: { type: string, enum: [ios, android, web] } }
 *     responses:
 *       200: { description: Billing plans retrieved }
 */
router.get('/plans', controller.getPlans);

/**
 * @swagger
 * /billing/ios/sync:
 *   post:
 *     summary: Verify and apply an iOS StoreKit purchase
 *     description: >
 *       Called by the app right after a purchase completes. The transaction
 *       is independently re-verified against Apple's own API — the app's
 *       claim that it paid is never trusted on its own.
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [transactionId]
 *             properties:
 *               transactionId: { type: string }
 *     responses:
 *       200: { description: Subscription synced }
 */
router.post('/ios/sync', authenticate, controller.syncIosPurchase);

/**
 * @swagger
 * /billing/webhooks/apple:
 *   post:
 *     summary: App Store Server Notifications V2 receiver
 *     description: >
 *       No bearer auth — Apple isn't carrying one. The JWS signature inside
 *       the payload itself is the authentication (see apple-billing.service.js).
 *     tags: [Billing]
 *     responses:
 *       200: { description: Always 200s, even on an unverifiable payload — see handler }
 */
router.post('/webhooks/apple', controller.appleWebhook);

module.exports = router;
