/**
 * Stripe — website card-payment billing.
 *
 * Sibling to apple-billing.service.js / google-play-billing.service.js, same
 * shape, same rules. What's different is Stripe's own model:
 *
 *   - The frontend redirect after Checkout NEVER grants anything by itself
 *     — only handleWebhook, verified via Stripe's own signature scheme, is
 *     authoritative. This mirrors "never trust the client alone" applied to
 *     an entire payment flow, not just one purchase confirmation call.
 *   - We control Stripe server-side, unlike Apple/Google — a cross-provider
 *     migration away from Stripe can and does call a real cancellation API
 *     (cancelAtPeriodEnd, invoked by subscription-migration.service.js's
 *     callers after their transaction commits), never just a local status
 *     flip.
 *   - Stripe Prices are immutable by design. A BillingPlan catalog price
 *     edit never mutates a live Price object — syncStripePrice creates a
 *     NEW Price and repoints BillingPlan at it; every existing Stripe
 *     Subscription keeps referencing its original Price automatically,
 *     which is what makes "existing subscriber price" a real, protected
 *     concept for this provider (see BillingPlan.model.js's three-price-
 *     separation note) without any bespoke "locked price" field.
 *   - The Billing Portal is configured to allow only payment-method update,
 *     invoice history, and cancellation — never plan changes. GymsEra's own
 *     catalog is always the only source of which plans exist; Stripe must
 *     never be able to offer one outside it (createBillingPortalSession).
 *
 * Until a real Stripe account exists, `.env` holds Stripe TEST-mode keys and
 * BillingPlan rows have stripeSyncStatus: NOT_CONFIGURED — every function
 * below is real, production-shaped code against Stripe's real API; only the
 * account behind the keys is a test one (swapping to production later is a
 * key change, not a code change).
 */
const Stripe = require('stripe');
const { BillingPlan, Tenant, TenantSubscription } = require('../models/platform');
const { sequelize } = require('../database/platform');
const { createError } = require('../utils/response.utils');
const subscriptionQuotaService = require('./subscription-quota.service');
const subscriptionMigrationService = require('./subscription-migration.service');
const TenantDbManager = require('../database/TenantDbManager');

let _stripe = null;
const _client = () => {
  if (_stripe) return _stripe;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw createError('Stripe is not configured on the server', 500);
  _stripe = new Stripe(secretKey);
  return _stripe;
};

/**
 * A restricted Billing Portal Configuration — payment method / invoices /
 * cancellation only, "update subscription" explicitly left out so Stripe
 * can never present plan choices outside the GymsEra catalog. Created once
 * and cached by ID in-process; idempotent to call repeatedly (Stripe has no
 * "get or create" for configurations, so we search for an existing one by
 * name first).
 */
let _cachedPortalConfigId = null;
const _restrictedPortalConfigId = async () => {
  if (_cachedPortalConfigId) return _cachedPortalConfigId;
  const stripe = _client();
  const existing = await stripe.billingPortal.configurations.list({ limit: 100 });
  const found = existing.data.find((c) => c.business_profile?.headline === 'GymsEra Billing (restricted)');
  if (found) {
    _cachedPortalConfigId = found.id;
    return found.id;
  }
  const created = await stripe.billingPortal.configurations.create({
    business_profile: { headline: 'GymsEra Billing (restricted)' },
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: { enabled: false },
      subscription_pause: { enabled: false },
    },
  });
  _cachedPortalConfigId = created.id;
  return created.id;
};

/** Finds or creates the Stripe Customer for a tenant, keyed by tenantId in metadata. */
const _resolveCustomerId = async (tenantId, tenant) => {
  const stripe = _client();
  // externalTransactionId on a Stripe TenantSubscription row is the
  // subscription id, not the customer id, so a past row doesn't shortcut
  // this — the customer is always looked up by metadata instead, the one
  // place it's findable regardless of subscription history.
  const found = await stripe.customers.search({ query: `metadata['tenantId']:'${tenantId}'` });
  if (found.data.length > 0) return found.data[0].id;

  const created = await stripe.customers.create({
    email: tenant?.email || undefined,
    name: tenant?.businessName || undefined,
    metadata: { tenantId },
  });
  return created.id;
};

/**
 * Creates a subscription-mode Checkout Session against the GymsEra-selected
 * plan's current Stripe Price — the plan always comes from our own catalog
 * (BillingPlan), never anything Stripe's own Portal would offer.
 *
 * Refuses outright if the tenant already has an ACTIVE Stripe subscription
 * — that's the wrong path for an existing Stripe subscriber wanting a
 * different tier (use changeSubscriptionPlan below instead, which updates
 * the existing subscription's price in place). Checkout always creates a
 * brand-new Stripe subscription object; running it a second time while one
 * is already active would leave two Stripe subscriptions both billing the
 * same customer instead of replacing one with the other.
 */
const createCheckoutSession = async (tenantId, billingPlanId, billingCycle, { successUrl, cancelUrl }) => {
  const { TenantSubscription: TS } = require('../models/platform');
  const currentActive = await TS.findOne({ where: { tenantId, status: 'ACTIVE' } });
  if (currentActive?.platform === 'STRIPE') {
    throw createError('This account already has an active Stripe subscription — change its plan instead of starting a new checkout.', 409);
  }

  const plan = await BillingPlan.findByPk(billingPlanId);
  if (!plan) throw createError('Billing plan not found', 404);
  const priceId = billingCycle === 'YEARLY' ? plan.stripeAnnualPriceId : plan.stripeMonthlyPriceId;
  if (!priceId) throw createError(`This plan is not yet configured for Stripe (${billingCycle})`, 400);

  const tenant = await Tenant.findByPk(tenantId);
  const customerId = await _resolveCustomerId(tenantId, tenant);
  const stripe = _client();

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { tenantId, billingPlanId: plan.id },
    subscription_data: { metadata: { tenantId, billingPlanId: plan.id } },
  });
  return { url: session.url, sessionId: session.id };
};

/**
 * Same-provider (Stripe → Stripe) upgrade/downgrade — the plan is always
 * resolved from the central GymsEra catalog, exactly like a fresh checkout,
 * but performed by updating the EXISTING Stripe subscription's price in
 * place (same subscription id) rather than creating a new one. This is what
 * makes a Stripe subscriber's plan change land back on the `existing`
 * (direct-update) path in syncSubscriptionFromStripeObject when the
 * resulting `customer.subscription.updated` webhook fires, instead of ever
 * reaching subscription-migration.service.js's "supersede the old row"
 * logic — there's no old row to supersede, it's the same row, same
 * subscription, just a different price on it.
 *
 * Returns immediately after telling Stripe to make the change; it does NOT
 * write to TenantSubscription itself — same "frontend/caller never grants,
 * only the webhook does" rule as everywhere else in this file.
 */
const changeSubscriptionPlan = async (tenantId, billingPlanId, billingCycle) => {
  const { TenantSubscription: TS } = require('../models/platform');
  const currentActive = await TS.findOne({ where: { tenantId, status: 'ACTIVE' } });
  if (!currentActive || currentActive.platform !== 'STRIPE') {
    throw createError('This account does not have an active Stripe subscription to change.', 409);
  }

  const plan = await BillingPlan.findByPk(billingPlanId);
  if (!plan) throw createError('Billing plan not found', 404);
  const newPriceId = billingCycle === 'YEARLY' ? plan.stripeAnnualPriceId : plan.stripeMonthlyPriceId;
  if (!newPriceId) throw createError(`This plan is not yet configured for Stripe (${billingCycle})`, 400);

  const stripe = _client();
  const stripeSubscription = await stripe.subscriptions.retrieve(currentActive.externalOriginalTransactionId);
  const existingItemId = stripeSubscription.items?.data?.[0]?.id;
  if (!existingItemId) throw createError('Could not resolve the existing Stripe subscription item to update.', 500);

  const updated = await stripe.subscriptions.update(currentActive.externalOriginalTransactionId, {
    items: [{ id: existingItemId, price: newPriceId }],
    proration_behavior: 'create_prorations',
    metadata: { tenantId, billingPlanId: plan.id },
  });

  return { subscriptionId: updated.id, status: updated.status };
};

/** Payment method / invoices / cancellation only — see the restricted Portal Configuration above. */
const createBillingPortalSession = async (tenantId, returnUrl) => {
  const tenant = await Tenant.findByPk(tenantId);
  const customerId = await _resolveCustomerId(tenantId, tenant);
  const stripe = _client();
  const configuration = await _restrictedPortalConfigId();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
    configuration,
  });
  return { url: session.url };
};

/**
 * A verified purchase's Stripe Price ID back to the BillingPlan row it
 * belongs to — mirrors the other two providers' findPlanForProductId.
 */
const findPlanForPriceId = async (priceId) => {
  const { Op } = require('sequelize');
  const plan = await BillingPlan.findOne({
    where: { [Op.or]: [{ stripeMonthlyPriceId: priceId }, { stripeAnnualPriceId: priceId }] },
  });
  if (!plan) throw createError(`No BillingPlan is configured for Stripe price "${priceId}"`, 404);
  return plan;
};

const _statusFromStripeStatus = (stripeStatus) => {
  if (['active', 'trialing'].includes(stripeStatus)) return 'ACTIVE';
  if (stripeStatus === 'canceled') return 'CANCELLED';
  if (['incomplete_expired', 'unpaid'].includes(stripeStatus)) return 'EXPIRED';
  return 'ACTIVE';
};

/**
 * Upserts the tenant's TenantSubscription row from a verified Stripe
 * subscription object (always via handleWebhook — the frontend redirect
 * alone never reaches this). Keyed on externalOriginalTransactionId (=
 * Stripe subscription id, stable for its lifetime including plan changes)
 * — safe to call repeatedly. Mirrors the other two providers' sync function
 * function-for-function, including the cross-provider migration hook.
 *
 * `stripeEventId` (the webhook Event's own id, e.g. "evt_...") is used as
 * the capacity-reconciliation idempotency key instead of
 * stripeSubscription.id — unlike Apple's per-transaction id or Google's
 * per-order id, a Stripe *subscription* id stays the same across its whole
 * lifetime including real price/plan changes, so using it here would make
 * a genuine second upgrade on the same subscription collide with the first
 * one's already-recorded CapacityEvent and get silently dropped. The event
 * id changes for every distinct event but stays identical across Stripe's
 * own retries of the same delivery, which is exactly the idempotency
 * behavior every other caller of reconcileCapacity relies on.
 */
const syncSubscriptionFromStripeObject = async (tenantId, stripeSubscription, { originListingId = null, stripeEventId = null } = {}) => {
  const idempotencyPrefix = stripeEventId || stripeSubscription.id;
  const item = stripeSubscription.items?.data?.[0];
  const priceId = item?.price?.id;
  if (!priceId) throw createError('Stripe subscription has no price item', 400);
  const plan = await findPlanForPriceId(priceId);
  const isAnnual = priceId === plan.stripeAnnualPriceId;

  const status = _statusFromStripeStatus(stripeSubscription.status);
  const periodEnd = item.current_period_end ? new Date(item.current_period_end * 1000) : null;
  const periodStart = item.current_period_start ? new Date(item.current_period_start * 1000) : new Date();

  const platformTx = await sequelize.transaction();
  try {
    const existing = await TenantSubscription.findOne({
      where: { externalOriginalTransactionId: stripeSubscription.id },
      transaction: platformTx,
      lock: true,
    });
    const previousMaxBranches = existing ? existing.branchCount : null;
    const planChanged = !existing || existing.billingPlanId !== plan.id;

    const values = {
      tenantId,
      platform: 'STRIPE',
      billingPlanId: plan.id,
      branchCount: plan.branchCount,
      productId: priceId,
      externalOriginalTransactionId: stripeSubscription.id,
      externalTransactionId: stripeSubscription.id,
      // Stripe has no per-object sandbox flag — test vs. live is entirely a
      // function of which API key made the call, tracked at the account
      // level, not on the subscription itself. Always PRODUCTION here; the
      // real environment distinction is which STRIPE_SECRET_KEY is loaded.
      environment: 'PRODUCTION',
      startDate: periodStart.toISOString().split('T')[0],
      endDate: periodEnd ? periodEnd.toISOString().split('T')[0] : null,
      // See apple-billing.service.js's identical comment — never recomputed
      // on a plain renewal, only on a new row or a real plan change.
      ...(planChanged
        ? { amount: isAnnual ? plan.annualPrice : plan.monthlyPrice, billingCycle: isAnnual ? 'YEARLY' : 'MONTHLY' }
        : {}),
      status,
      autoRenew: !stripeSubscription.cancel_at_period_end,
      paymentStatus: 'PAID',
      lastVerifiedAt: new Date(),
    };

    let subscription;
    // See apple-billing.service.js's identical comment — true whenever
    // requestProviderChange already handled reconciliation itself.
    let reconciledByActivation = false;
    let migratedFrom = null;
    if (existing) {
      // A renewal/resync for a Stripe subscription id already on file —
      // never a migration decision. But Stripe's own object could still say
      // ACTIVE even after a prior purchase superseded this row locally —
      // see subscription-migration.service.js#reconcileRenewalStatus for
      // why blindly trusting that would resurrect a second ACTIVE row.
      // Mirrors the identical guard in apple-billing.service.js and
      // google-play-billing.service.js.
      const reconciledValues = await subscriptionMigrationService.reconcileRenewalStatus(
        tenantId,
        existing,
        values,
        { transaction: platformTx }
      );
      await existing.update(reconciledValues, { transaction: platformTx });
      subscription = existing;
    } else {
      let tenantDb = null;
      const tenant = await Tenant.findByPk(tenantId, { transaction: platformTx });
      if (tenant?.connectionStringEncrypted) {
        tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
      }
      const activation = await subscriptionMigrationService.requestProviderChange(
        tenantId,
        { newPlatform: 'STRIPE', newSubscriptionValues: values },
        {
          transaction: platformTx,
          tenantDb,
          originListingId,
          idempotencyPrefix,
          actorType: 'SYSTEM',
        }
      );
      subscription = activation.subscription;
      reconciledByActivation = true;
      migratedFrom = activation.migratedFrom;
    }

    // subscription.status, not values.status — see the identical comment in
    // apple-billing.service.js / google-play-billing.service.js.
    if (!reconciledByActivation && subscription.status === 'ACTIVE' && values.branchCount != null) {
      const tenant = await Tenant.findByPk(tenantId, { transaction: platformTx });
      if (tenant?.connectionStringEncrypted) {
        const tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
        await subscriptionQuotaService.reconcileCapacity(tenantId, tenantDb, values.branchCount, {
          transaction: platformTx,
          previousMaxBranches,
          originListingId,
          idempotencyPrefix,
          actorType: 'SYSTEM',
        });
      }
    }

    await platformTx.commit();

    if (migratedFrom?.platform === 'STRIPE' && migratedFrom.externalOriginalTransactionId) {
      // A Stripe -> Stripe migration never happens (same-platform changes
      // never go through requestProviderChange), but guard identically to
      // the other two providers for symmetry/safety.
      try {
        await cancelAtPeriodEnd(migratedFrom.externalOriginalTransactionId);
      } catch (err) {
        console.warn('[Stripe Billing] Failed to schedule Stripe cancellation after migration:', err.message);
      }
    }

    return subscription;
  } catch (err) {
    await platformTx.rollback();
    throw err;
  }
};

/**
 * Called by the other two providers' services (never by this file's own
 * migration path — same-provider changes don't migrate) once a migration
 * transaction has committed, to actually schedule the old Stripe
 * subscription's cancellation. Must run outside any DB transaction — a
 * Stripe API call must never be left pending inside one that might roll
 * back.
 */
const cancelAtPeriodEnd = async (stripeSubscriptionId) => {
  const stripe = _client();
  await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });
};

/**
 * Stripe webhook receiver. Verified via Stripe's own signature scheme
 * (stripe.webhooks.constructEvent) against the RAW request body — app.js
 * captures that onto req.rawBody via express.json()'s verify hook, since
 * the JSON-parsed req.body would no longer match the exact bytes Stripe
 * signed. The frontend's post-Checkout redirect never grants anything by
 * itself; this is the only authoritative trigger for syncing a purchase.
 */
const handleWebhook = async (rawBody, signature) => {
  const stripe = _client();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw createError('Stripe webhook secret is not configured on the server', 500);

  const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription' || !session.subscription) break;
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const tenantId = session.metadata?.tenantId || subscription.metadata?.tenantId;
      if (tenantId) await syncSubscriptionFromStripeObject(tenantId, subscription, { stripeEventId: event.id });
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const tenantId = subscription.metadata?.tenantId;
      if (tenantId) await syncSubscriptionFromStripeObject(tenantId, subscription, { stripeEventId: event.id });
      break;
    }
    case 'customer.subscription.deleted': {
      // Routed through the same single choke point as every other event —
      // never a second, parallel write path to TenantSubscription. Stripe's
      // own `status` on a deleted subscription object is already 'canceled',
      // which _statusFromStripeStatus maps to CANCELLED; no capacity
      // reconciliation happens for a cancellation here, matching the exact
      // same "the expiry cron is the safety net" rule already established
      // for Apple/Google cancellations (see this function's own status
      // check further down in syncSubscriptionFromStripeObject).
      const subscription = event.data.object;
      const tenantId = subscription.metadata?.tenantId;
      if (tenantId) {
        await syncSubscriptionFromStripeObject(tenantId, subscription, { stripeEventId: event.id });
      } else {
        // No metadata to resolve a tenant from (e.g. a subscription created
        // outside our own Checkout flow) — fall back to a direct update by
        // external id so the row doesn't drift, same tolerant-fallback
        // philosophy as the rest of this codebase's idempotent paths.
        await TenantSubscription.update(
          { status: 'CANCELLED' },
          { where: { externalOriginalTransactionId: subscription.id, status: { [require('sequelize').Op.in]: ['ACTIVE', 'SCHEDULED'] } } }
        );
      }
      break;
    }
    case 'invoice.payment_failed': {
      // Left as-is deliberately — Stripe's own dunning/retry emails handle
      // this, and the subscription-expiry cron (unchanged, shared with
      // every other provider) is the safety net that expires anything that
      // never recovers by its endDate.
      break;
    }
    default:
      break;
  }

  return { received: true, type: event.type };
};

module.exports = {
  createCheckoutSession,
  changeSubscriptionPlan,
  createBillingPortalSession,
  findPlanForPriceId,
  syncSubscriptionFromStripeObject,
  cancelAtPeriodEnd,
  handleWebhook,
};
