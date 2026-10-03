const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const controller = require('../controllers/billing.controller');
const googlePlayBilling = require('../services/google-play-billing.service');

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
 * /billing/purchase-intent:
 *   post:
 *     summary: Check cross-provider conflicts and decide purchase mechanism (BILL-07)
 *     tags: [Billing]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [platform]
 *             properties:
 *               platform: { type: string, enum: [IOS, ANDROID, STRIPE, ios, android, web] }
 *               planId: { type: string, format: uuid }
 *     responses:
 *       200: { description: Purchase intent evaluated }
 */
router.post('/purchase-intent', authenticate, controller.purchaseIntent);

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
 * /billing/downgrade-preview:
 *   get:
 *     summary: What a downgrade to a smaller plan means (BILL-03)
 *     description: >
 *       New branch count, active branches and reserved slots, and whether the
 *       owner must choose which branches to keep before buying the smaller
 *       plan at the store. Owner only.
 *     tags: [Billing]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: billingPlanId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Downgrade preview }
 *       400: { description: Not a downgrade }
 *       409: { description: No in-app plan on this account }
 */
router.get('/downgrade-preview', authenticate, authorize('GYM_HOST'), controller.getDowngradePreview);

/**
 * @swagger
 * /billing/downgrade-choice:
 *   put:
 *     summary: Choose the branches to keep on a downgrade (BILL-03)
 *     description: >
 *       Stored with the plan's pendingChange. The plan changes only when the
 *       store applies the downgrade at renewal. Owner only.
 *     tags: [Billing]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [billingPlanId]
 *             properties:
 *               billingPlanId: { type: string }
 *               keepBranchIds: { type: array, items: { type: string } }
 *     responses:
 *       200: { description: Branch choice saved }
 *       400: { description: Invalid choice }
 *       409: { description: A different change is scheduled at the store }
 */
router.put('/downgrade-choice', authenticate, authorize('GYM_HOST'), controller.putDowngradeChoice);

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
 *       No user bearer auth. Google Cloud Pub/Sub push sends a Google-signed
 *       OIDC token in the Authorization header; it is verified (signature,
 *       audience, service account) before this reaches the handler (SEC-03).
 *     tags: [Billing]
 *     responses:
 *       200: { description: Notification applied }
 *       401: { description: Missing/invalid push token }
 */
const verifyRtdnPush = async (req, res, next) => {
  try {
    await googlePlayBilling.verifyRtdnPush(req.headers.authorization);
    next();
  } catch (err) {
    res.status(401).json({ received: false, message: err.message });
  }
};
router.post('/webhooks/google', verifyRtdnPush, controller.googleRtdnWebhook);

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
 * /billing/stripe/session/{id}:
 *   get:
 *     summary: Verify a Stripe Checkout Session server-side (return page)
 *     description: >
 *       Re-fetches the session from Stripe and reports whether it is paid and
 *       whether the webhook has granted the plan yet. Read-only. The return
 *       URL's query parameters are never trusted.
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ status, paymentStatus, confirmed, entitled }" }
 *       404: { description: Unknown session, or not this tenant's }
 */
router.get('/stripe/session/:id', authenticate, controller.getStripeCheckoutSession);

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
