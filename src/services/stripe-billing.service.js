/**
 * Stripe — website card-payment billing.
 *
 * Sibling to apple-billing.service.js / google-play-billing.service.js, same
 * shape, same rules. What's different is Stripe's own model:
 *
 *   - The frontend redirect after Checkout NEVER grants anything by itself
 *     — only a signature-verified webhook (verifyWebhookEvent), re-fetched and
 *     applied through syncFromStripe, is
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
const { createError } = require('../utils/response.utils');
const subscriptionMigrationService = require('./subscription-migration.service');

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
 * Maps a Stripe subscription object (always re-fetched via syncFromStripe —
 * the frontend redirect never reaches this) to TenantSubscription values and
 * applies them through subscription-migration.service.js#applyVerifiedSubscription,
 * the one write path shared by every provider. Keyed on
 * externalOriginalTransactionId (= Stripe subscription id, stable for its
 * lifetime including plan changes) — safe to call repeatedly.
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
const syncSubscriptionFromStripeObject = async (tenantId, stripeSubscription, { originListingId = null, stripeEventId = null, revoked = false } = {}) => {
  const idempotencyPrefix = stripeEventId || stripeSubscription.id;
  const item = stripeSubscription.items?.data?.[0];
  const priceId = item?.price?.id;
  if (!priceId) throw createError('Stripe subscription has no price item', 400);
  const plan = await findPlanForPriceId(priceId);
  const isAnnual = priceId === plan.stripeAnnualPriceId;

  // `revoked`: the latest payment was fully refunded or disputed — Stripe
  // keeps the subscription itself "active", so the caller says so (BILL-02).
  const status = revoked ? 'REVOKED' : _statusFromStripeStatus(stripeSubscription.status);
  const periodEnd = item.current_period_end ? new Date(item.current_period_end * 1000) : null;
  const periodStart = item.current_period_start ? new Date(item.current_period_start * 1000) : new Date();

  const values = {
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
    // Written only on a new row or a real plan change — see
    // subscription-migration.service.js#applyVerifiedSubscription.
    amount: isAnnual ? plan.annualPrice : plan.monthlyPrice,
    billingCycle: isAnnual ? 'YEARLY' : 'MONTHLY',
    status,
    autoRenew: !stripeSubscription.cancel_at_period_end,
    paymentStatus: 'PAID',
    lastVerifiedAt: new Date(),
  };

  return subscriptionMigrationService.applyVerifiedSubscription(tenantId, values, {
    originListingId,
    idempotencyPrefix,
    logLabel: 'Stripe Billing',
  });
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
 * Verifies a Stripe webhook's signature against the RAW request body (app.js
 * captures it onto req.rawBody — the JSON-parsed body no longer matches the
 * bytes Stripe signed) and returns the event. Only a verified event ever
 * reaches the billing_events inbox.
 */
const verifyWebhookEvent = (rawBody, signature) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw createError('Stripe webhook secret is not configured on the server', 500);
  return _client().webhooks.constructEvent(rawBody, signature, webhookSecret);
};

/**
 * Provider API calls, grouped so a test can substitute them — nothing else in
 * this file's sync/webhook path talks to Stripe directly.
 */
const stripeApi = {
  verifyWebhookEvent,
  retrieveSubscription: (id) => _client().subscriptions.retrieve(id),
  retrieveCharge: (id) => _client().charges.retrieve(id),
  /**
   * The subscription a charge paid for. Older API versions put the invoice on
   * the charge; newer ones link charge → payment intent → invoice payment →
   * invoice, and the invoice names its subscription under
   * parent.subscription_details. Tries both.
   */
  subscriptionIdForCharge: async (charge) => {
    const stripe = _client();
    let invoiceId = typeof charge.invoice === 'string' ? charge.invoice : charge.invoice?.id;
    if (!invoiceId && charge.payment_intent) {
      const paymentIntent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent.id;
      const payments = await stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntent }, limit: 1 });
      const inv = payments.data?.[0]?.invoice;
      invoiceId = typeof inv === 'string' ? inv : inv?.id;
    }
    if (!invoiceId) return null;
    const invoice = await stripe.invoices.retrieve(invoiceId);
    const sub = invoice.subscription || invoice.parent?.subscription_details?.subscription;
    return typeof sub === 'string' ? sub : sub?.id || null;
  },
};

/**
 * The one entry point for applying a Stripe subscription: re-fetch it from
 * Stripe's API (never the webhook payload's copy, which can arrive out of
 * order), resolve its owner, then apply it through
 * syncSubscriptionFromStripeObject. The owner is the tenant already holding
 * this subscription id, else the tenantId our own Checkout Session wrote into
 * the subscription's metadata server-side.
 *
 * @returns {Promise<object|null>} null when no tenant can be resolved.
 */
const syncFromStripe = async ({ subscriptionId, eventId = null, revoked = false }) => {
  const subscription = await stripeApi.retrieveSubscription(subscriptionId);
  const existing = await TenantSubscription.findOne({
    where: { platform: 'STRIPE', externalOriginalTransactionId: subscription.id },
  });
  const tenantId = existing?.tenantId || subscription.metadata?.tenantId || null;
  if (!tenantId) return null;
  return syncSubscriptionFromStripeObject(tenantId, subscription, { stripeEventId: eventId, revoked });
};

/**
 * Processes one verified Stripe event from the billing_events inbox. Every
 * subscription-affecting event resolves to a subscription id and goes through
 * syncFromStripe — the event's own copy of the object is never trusted for
 * state. Returns what happened, for the inbox row.
 */
const processWebhookEvent = async (event) => {
  const object = event.data?.object || {};
  let subscriptionId = null;
  let revoked = false;
  switch (event.type) {
    case 'charge.refunded':
    case 'charge.dispute.created': {
      // Refund / chargeback (BILL-02, spec §7.5.7). The charge is re-fetched:
      // only a FULL refund or an open dispute revokes; a partial refund is a
      // goodwill credit and leaves the plan in place.
      const chargeId = event.type === 'charge.refunded' ? object.id : object.charge;
      const charge = await stripeApi.retrieveCharge(typeof chargeId === 'string' ? chargeId : chargeId?.id);
      if (!(charge.refunded === true || charge.disputed === true)) {
        return { outcome: 'IGNORED', note: 'Partial refund — entitlement unchanged' };
      }
      subscriptionId = await stripeApi.subscriptionIdForCharge(charge);
      revoked = true;
      break;
    }
    case 'checkout.session.completed':
      if (object.mode === 'subscription') subscriptionId = object.subscription;
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      subscriptionId = object.id;
      break;
    default:
      // invoice.payment_failed and anything else: Stripe's own dunning
      // handles the retry, and the next customer.subscription.updated (or
      // the daily reconciliation sweep) carries the resulting state.
      return { outcome: 'IGNORED', note: `Event type ${event.type} does not change entitlement` };
  }
  if (!subscriptionId) return { outcome: 'IGNORED', note: 'No subscription on this event' };
  const synced = await syncFromStripe({ subscriptionId, eventId: event.id, revoked });
  if (!synced) return { outcome: 'IGNORED', note: 'Subscription has no GymsEra tenant' };
  return { outcome: 'PROCESSED' };
};

module.exports = {
  createCheckoutSession,
  changeSubscriptionPlan,
  createBillingPortalSession,
  findPlanForPriceId,
  syncSubscriptionFromStripeObject,
  cancelAtPeriodEnd,
  stripeApi,
  verifyWebhookEvent,
  syncFromStripe,
  processWebhookEvent,
};
