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

/**
 * @swagger
 * /billing/android/sync:
 *   post:
 *     summary: Verify and apply an Android Play Billing purchase
 *     description: >
 *       Sibling to /billing/ios/sync. The purchase token is independently
 *       re-verified against Google's Play Developer API.
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [purchaseToken, productId]
 *             properties:
 *               purchaseToken: { type: string }
 *               productId: { type: string }
 *     responses:
 *       200: { description: Subscription synced }
 */
router.post('/android/sync', authenticate, controller.syncAndroidPurchase);

/**
 * @swagger
 * /billing/webhooks/google:
 *   post:
 *     summary: Real-time Developer Notifications (RTDN) receiver
 *     description: >
 *       No bearer auth — Google Cloud Pub/Sub push isn't carrying one.
 *       Authenticated instead by a secret ?token= query param, checked
 *       before this reaches the handler (see the middleware below).
 *     tags: [Billing]
 *     responses:
 *       200: { description: Notification applied }
 *       401: { description: Missing/invalid push token }
 */
const verifyRtdnToken = (req, res, next) => {
  const crypto = require('crypto');
  const expected = process.env.GOOGLE_PLAY_RTDN_TOKEN;
  const provided = typeof req.query.token === 'string' ? req.query.token : '';
  // Constant-time comparison — a plain !== leaks timing information about
  // how many leading characters matched, same class of concern signature
  // checks elsewhere in this codebase (Apple's JWS, Stripe's HMAC) are
  // already immune to by construction.
  const expectedBuf = Buffer.from(expected || '');
  const providedBuf = Buffer.from(provided);
  const matches =
    !!expected && expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
  if (!matches) {
    return res.status(401).json({ received: false, message: 'Invalid push token' });
  }
  next();
};
router.post('/webhooks/google', verifyRtdnToken, controller.googleRtdnWebhook);

/**
 * @swagger
 * /billing/stripe/checkout-session:
 *   post:
 *     summary: Create a Stripe Checkout session for a GymsEra catalog plan
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [billingPlanId, billingCycle, successUrl, cancelUrl]
 *             properties:
 *               billingPlanId: { type: string, format: uuid }
 *               billingCycle: { type: string, enum: [MONTHLY, YEARLY] }
 *               successUrl: { type: string }
 *               cancelUrl: { type: string }
 *     responses:
 *       200: { description: Checkout session created }
 */
router.post('/stripe/checkout-session', authenticate, controller.createStripeCheckoutSession);

/**
 * @swagger
 * /billing/stripe/change-plan:
 *   post:
 *     summary: Change an existing Stripe subscriber's plan (same-provider upgrade/downgrade)
 *     description: >
 *       Updates the existing Stripe subscription's price in place instead of
 *       starting a new checkout — keeps the same Stripe subscription id, so
 *       the resulting webhook applies as a plain update, not a migration.
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [billingPlanId, billingCycle]
 *             properties:
 *               billingPlanId: { type: string, format: uuid }
 *               billingCycle: { type: string, enum: [MONTHLY, YEARLY] }
 *     responses:
 *       200: { description: Plan change requested }
 */
router.post('/stripe/change-plan', authenticate, controller.changeStripePlan);

/**
 * @swagger
 * /billing/stripe/portal-session:
 *   post:
 *     summary: Create a restricted Stripe Billing Portal session
 *     description: >
 *       Payment method / invoices / cancellation only — plan changes are
 *       disabled in the Portal Configuration used here; GymsEra's own
 *       catalog is always the only source of which plans exist.
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [returnUrl]
 *             properties:
 *               returnUrl: { type: string }
 *     responses:
 *       200: { description: Billing portal session created }
 */
router.post('/stripe/portal-session', authenticate, controller.createStripePortalSession);

/**
 * @swagger
 * /billing/webhooks/stripe:
 *   post:
 *     summary: Stripe webhook receiver
 *     description: >
 *       No bearer auth — verified instead via Stripe's own signature scheme
 *       against the raw request body. The only authoritative trigger for
 *       granting a Stripe purchase; the frontend redirect never is.
 *     tags: [Billing]
 *     responses:
 *       200: { description: Event applied }
 *       400: { description: Signature verification or processing failed }
 */
router.post('/webhooks/stripe', controller.stripeWebhook);

module.exports = router;
