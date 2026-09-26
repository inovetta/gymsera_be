const appleBilling = require('../services/apple-billing.service');
const googlePlayBilling = require('../services/google-play-billing.service');
const stripeBilling = require('../services/stripe-billing.service');
const billingEvents = require('../services/billing-event.service');
const { BillingPlan } = require('../models/platform');
const { sendSuccess, createError } = require('../utils/response.utils');

/**
 * GET /billing/plans
 *
 * The plan catalog, exactly as stored — every platform's app reads this
 * instead of ever hardcoding a product ID or price. Change a price, add a
 * step, wire up Android/Stripe: it's a BillingPlan row, this endpoint just
 * reflects it. `?platform=ios|android|web` trims the response to the
 * columns that platform actually needs, so the app never has to know about
 * the others' product IDs.
 */
const getPlans = async (req, res, next) => {
  try {
    const plans = await BillingPlan.findAll({
      where: { isActive: true },
      order: [['sortOrder', 'ASC']],
    });

    const platform = (req.query.platform || '').toLowerCase();
    const shaped = plans.map((p) => {
      const base = {
        // Needed by the website's checkout flow (POST /billing/stripe/checkout-session
        // takes billingPlanId) — iOS/Android purchase via their own product
        // IDs directly and don't need it, but it's harmless to include for
        // every platform rather than special-casing web alone.
        id: p.id,
        branchCount: p.branchCount,
        monthlyPrice: parseFloat(p.monthlyPrice),
        annualPrice: parseFloat(p.annualPrice),
        currency: p.currency,
      };
      if (platform === 'ios') {
        return { ...base, monthlyProductId: p.iosMonthlyProductId, annualProductId: p.iosAnnualProductId };
      }
      if (platform === 'android') {
        return {
          ...base,
          productId: p.androidProductId,
          monthlyBasePlanId: p.androidMonthlyBasePlanId,
          annualBasePlanId: p.androidAnnualBasePlanId,
        };
      }
      if (platform === 'web') {
        return { ...base, monthlyPriceId: p.stripeMonthlyPriceId, annualPriceId: p.stripeAnnualPriceId };
      }
      return base;
    });

    return sendSuccess(res, { plans: shaped }, 'Billing plans retrieved');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /billing/ios/sync
 *
 * The app calls this right after StoreKit reports a purchase succeeded.
 * We independently ask Apple what that transaction actually is — the app's
 * own claim is never trusted on its own — and only then update the
 * tenant's entitlement.
 */
const syncIosPurchase = async (req, res, next) => {
  try {
    const { transactionId, organizationId } = req.body;
    if (!transactionId) throw createError('transactionId is required', 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) throw createError('No tenant context for this account', 400);

    // organizationId is optional — the org the purchase was initiated from,
    // if the app knows it (e.g. the upsell flow reached from a specific
    // organization's "need more capacity" prompt). Used only to decide where
    // an upgrade's new capacity lands as a spendable slot; a downgrade never
    // reads it. Same entry point as the App Store notification processor.
    const subscription = await appleBilling.syncFromApple({
      transactionId,
      tenantId,
      originListingId: organizationId || null,
    });

    return sendSuccess(res, { subscription }, 'Subscription synced');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /billing/webhooks/apple
 *
 * App Store Server Notifications V2. No auth middleware in front of this
 * one (Apple isn't carrying a bearer token) — the JWS signature inside
 * `signedPayload` IS the authentication; see apple-billing.service.js.
 * Verified, then recorded in the billing_events inbox (keyed on Apple's
 * notificationUUID) and processed. A payload that fails verification is
 * rejected (400) and never stored. If the event cannot be recorded (e.g. the
 * database is down) this answers 500 so Apple redelivers — it used to answer
 * 200 and lose the event.
 */
const appleWebhook = async (req, res) => {
  let decoded;
  try {
    decoded = appleBilling.appleApi.verifyAndDecode(req.body.signedPayload);
  } catch (err) {
    console.warn('[Apple Webhook] Rejected unverifiable payload:', err.message);
    return res.status(400).json({ received: false });
  }
  try {
    await billingEvents.receiveEvent({
      provider: 'APPLE',
      providerEventId: decoded.notificationUUID,
      eventType: [decoded.notificationType, decoded.subtype].filter(Boolean).join(':') || null,
      rawPayload: { signedPayload: req.body.signedPayload },
    });
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Apple Webhook] Could not record notification:', err.message);
    return res.status(500).json({ received: false });
  }
};

/**
 * POST /billing/android/sync
 *
 * Sibling to syncIosPurchase — the app calls this right after Play Billing
 * reports a purchase succeeded. We independently ask Google's Play
 * Developer API what that purchase token actually is; the app's own claim
 * is never trusted on its own.
 */
const syncAndroidPurchase = async (req, res, next) => {
  try {
    const { purchaseToken, productId, organizationId } = req.body;
    if (!purchaseToken) throw createError('purchaseToken is required', 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) throw createError('No tenant context for this account', 400);

    // Same entry point as the RTDN processor.
    const subscription = await googlePlayBilling.syncFromGoogle({
      purchaseToken,
      tenantId,
      originListingId: organizationId || null,
    });

    // Server-side safety net alongside the client's own completePurchase
    // call — never blocks the response on it.
    googlePlayBilling.playApi
      .acknowledgePurchaseIfNeeded(purchaseToken, productId || subscription.productId)
      .catch((err) => console.warn('[Android Sync] Acknowledge safety-net failed:', err.message));

    return sendSuccess(res, { subscription }, 'Subscription synced');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /billing/webhooks/google
 *
 * Real-time Developer Notifications via Cloud Pub/Sub push. No embedded
 * signature like Apple's JWS — authenticated instead by a secret token on
 * this endpoint's own URL (see billing.routes.js), checked before this
 * handler runs. Recorded in the billing_events inbox keyed on the Pub/Sub
 * messageId, then processed; answers 500 only if the event could not be
 * recorded, so Pub/Sub redelivers.
 */
const googleRtdnWebhook = async (req, res) => {
  const messageId = req.body?.message?.messageId || req.body?.message?.message_id;
  if (!messageId) return res.status(400).json({ received: false, message: 'Missing Pub/Sub messageId' });
  try {
    await billingEvents.receiveEvent({
      provider: 'GOOGLE',
      providerEventId: messageId,
      eventType: 'rtdn',
      rawPayload: req.body,
    });
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Google RTDN Webhook] Could not record notification:', err.message);
    return res.status(500).json({ received: false });
  }
};

/**
 * POST /billing/stripe/checkout-session
 *
 * The app/website calls this after the host picks a plan from the central
 * catalog. Returns a Checkout URL to redirect to — the redirect back
 * afterward grants nothing by itself; only the webhook does.
 */
const createStripeCheckoutSession = async (req, res, next) => {
  try {
    const { billingPlanId, billingCycle, successUrl, cancelUrl } = req.body;
    if (!billingPlanId || !billingCycle) throw createError('billingPlanId and billingCycle are required', 400);
    if (!successUrl || !cancelUrl) throw createError('successUrl and cancelUrl are required', 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) throw createError('No tenant context for this account', 400);

    const session = await stripeBilling.createCheckoutSession(tenantId, billingPlanId, billingCycle, {
      successUrl,
      cancelUrl,
    });
    return sendSuccess(res, session, 'Checkout session created');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /billing/stripe/change-plan
 *
 * Same-provider (Stripe → Stripe) upgrade/downgrade — updates the existing
 * Stripe subscription's price in place rather than starting a new checkout.
 * The resulting webhook (customer.subscription.updated) is what actually
 * applies the change to TenantSubscription/capacity; this endpoint only
 * tells Stripe to make it.
 */
const changeStripePlan = async (req, res, next) => {
  try {
    const { billingPlanId, billingCycle } = req.body;
    if (!billingPlanId || !billingCycle) throw createError('billingPlanId and billingCycle are required', 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) throw createError('No tenant context for this account', 400);

    const result = await stripeBilling.changeSubscriptionPlan(tenantId, billingPlanId, billingCycle);
    return sendSuccess(res, result, 'Plan change requested');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /billing/stripe/portal-session
 *
 * Payment method / invoices / cancellation only — the Portal Configuration
 * used here has plan changes disabled, so Stripe can never offer a plan
 * outside the GymsEra catalog (see stripe-billing.service.js).
 */
const createStripePortalSession = async (req, res, next) => {
  try {
    const { returnUrl } = req.body;
    if (!returnUrl) throw createError('returnUrl is required', 400);

    const tenantId = req.user?.tenantId;
    if (!tenantId) throw createError('No tenant context for this account', 400);

    const session = await stripeBilling.createBillingPortalSession(tenantId, returnUrl);
    return sendSuccess(res, session, 'Billing portal session created');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /billing/webhooks/stripe
 *
 * Verified via Stripe's own signature scheme against the RAW request body
 * (req.rawBody, captured by app.js's express.json() verify hook — the
 * JSON-parsed req.body no longer matches the exact bytes Stripe signed),
 * then recorded in the billing_events inbox keyed on the Stripe event id and
 * processed. This is the ONLY authoritative trigger for granting a Stripe
 * purchase; the frontend's post-Checkout redirect never does.
 */
const stripeWebhook = async (req, res) => {
  let event;
  try {
    event = stripeBilling.stripeApi.verifyWebhookEvent(req.rawBody, req.headers['stripe-signature']);
  } catch (err) {
    console.warn('[Stripe Webhook] Rejected unverifiable event:', err.message);
    return res.status(400).json({ received: false });
  }
  try {
    await billingEvents.receiveEvent({
      provider: 'STRIPE',
      providerEventId: event.id,
      eventType: event.type,
      rawPayload: event,
    });
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook] Could not record event:', err.message);
    return res.status(500).json({ received: false });
  }
};

module.exports = {
  getPlans,
  syncIosPurchase,
  appleWebhook,
  syncAndroidPurchase,
  googleRtdnWebhook,
  createStripeCheckoutSession,
  changeStripePlan,
  createStripePortalSession,
  stripeWebhook,
};
