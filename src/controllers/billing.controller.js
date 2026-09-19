const appleBilling = require('../services/apple-billing.service');
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

    const decodedTransaction = await appleBilling.getTransactionInfo(transactionId);
    // organizationId is optional — the org the purchase was initiated from,
    // if the app knows it (e.g. the upsell flow reached from a specific
    // organization's "need more capacity" prompt). Used only to decide where
    // an upgrade's new capacity lands as a spendable slot; a downgrade never
    // reads it.
    const subscription = await appleBilling.syncSubscriptionFromTransaction(tenantId, decodedTransaction, {
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
 * Always 200s on a signature failure too (logged, not surfaced) — Apple
 * retries on non-2xx, and a permanently-invalid payload would just retry
 * forever for no benefit.
 */
const appleWebhook = async (req, res) => {
  try {
    await appleBilling.handleNotification(req.body.signedPayload);
  } catch (err) {
    console.warn('[Apple Webhook] Notification not applied:', err.message);
  }
  return res.status(200).json({ received: true });
};

module.exports = { getPlans, syncIosPurchase, appleWebhook };
