/**
 * Super Admin's BillingPlan catalog CRUD — the single source of truth for
 * every branch-count tier's price and per-provider identifiers, consumed
 * unchanged by iOS, Android, the website, and the in-app Host Area alike via
 * GET /billing/plans (billing.controller.js#getPlans already exists and is
 * untouched by this file).
 *
 * The one rule this file exists to enforce: editing a catalog price here
 * NEVER touches a provider's own live price configuration or an existing
 * subscriber's already-locked-in price (TenantSubscription.amount) — see
 * BillingPlan.model.js's three-price-separation note. It only ever updates
 * this table's own monthlyPrice/annualPrice, and flags the providers as
 * PENDING so Super Admin can see they've fallen behind the catalog.
 */
const { BillingPlan } = require('../models/platform');
const { createError } = require('../utils/response.utils');

const listPlans = async () => {
  return BillingPlan.findAll({ order: [['sortOrder', 'ASC']] });
};

const getPlan = async (id) => {
  const plan = await BillingPlan.findByPk(id);
  if (!plan) throw createError('Billing plan not found', 404);
  return plan;
};

const createPlan = async (fields) => {
  return BillingPlan.create({
    branchCount: fields.branchCount,
    monthlyPrice: fields.monthlyPrice,
    annualPrice: fields.annualPrice,
    currency: fields.currency || 'PKR',
    isActive: fields.isActive !== undefined ? fields.isActive : true,
    sortOrder: fields.sortOrder != null ? fields.sortOrder : fields.branchCount,
    iosMonthlyProductId: fields.iosMonthlyProductId || null,
    iosAnnualProductId: fields.iosAnnualProductId || null,
    androidProductId: fields.androidProductId || null,
    androidMonthlyBasePlanId: fields.androidMonthlyBasePlanId || null,
    androidAnnualBasePlanId: fields.androidAnnualBasePlanId || null,
    stripeMonthlyPriceId: fields.stripeMonthlyPriceId || null,
    stripeAnnualPriceId: fields.stripeAnnualPriceId || null,
  });
};

/**
 * Editing monthlyPrice/annualPrice touches only this row's own catalog
 * price — never a provider's live price object, never an existing
 * subscriber's TenantSubscription.amount (that's captured once at their own
 * purchase/upgrade time and left alone by every provider's sync function,
 * per the three-price-separation rule). A price edit flips every provider's
 * sync status to PENDING so it's visible that App Store Connect / Play
 * Console / Stripe's own configuration may now be stale; editing a
 * provider-ID field directly (e.g. correcting a typo'd product id) does not
 * by itself imply a price mismatch, so it's left alone here.
 */
const updatePlan = async (id, fields) => {
  const plan = await getPlan(id);
  const priceChanged =
    (fields.monthlyPrice !== undefined && parseFloat(fields.monthlyPrice) !== parseFloat(plan.monthlyPrice)) ||
    (fields.annualPrice !== undefined && parseFloat(fields.annualPrice) !== parseFloat(plan.annualPrice));

  const editable = [
    'branchCount', 'monthlyPrice', 'annualPrice', 'currency', 'isActive', 'sortOrder',
    'iosMonthlyProductId', 'iosAnnualProductId',
    'androidProductId', 'androidMonthlyBasePlanId', 'androidAnnualBasePlanId',
    'stripeMonthlyPriceId', 'stripeAnnualPriceId',
  ];
  editable.forEach((f) => {
    if (fields[f] !== undefined) plan[f] = fields[f];
  });

  if (priceChanged) {
    plan.iosSyncStatus = 'PENDING';
    plan.androidSyncStatus = 'PENDING';
    plan.stripeSyncStatus = 'PENDING';
  }

  await plan.save();
  return plan;
};

/**
 * The one automated provider-sync action — Stripe Prices are immutable by
 * design, so "syncing" means creating a NEW Price at the catalog's current
 * amount and repointing this row at it. Every existing Stripe Subscription
 * keeps referencing its original Price object automatically; only future
 * checkouts pick up the new one. iOS/Android have no equivalent safe
 * price-write API — those stay admin-attested via markProviderSynced below.
 */
const syncStripePrice = async (id) => {
  const plan = await getPlan(id);
  const stripeBilling = require('./stripe-billing.service');
  const Stripe = require('stripe');
  if (!process.env.STRIPE_SECRET_KEY) throw createError('Stripe is not configured on the server', 500);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let stripeProductId = plan.stripeProductId;
  if (!stripeProductId) {
    const product = await stripe.products.create({
      name: `GymsEra — ${plan.branchCount} branch${plan.branchCount > 1 ? 'es' : ''}`,
      metadata: { billingPlanId: plan.id, branchCount: String(plan.branchCount) },
    });
    stripeProductId = product.id;
  }

  const [monthlyPrice, annualPrice] = await Promise.all([
    stripe.prices.create({
      product: stripeProductId,
      currency: (plan.currency || 'PKR').toLowerCase(),
      unit_amount: Math.round(parseFloat(plan.monthlyPrice) * 100),
      recurring: { interval: 'month' },
      metadata: { billingPlanId: plan.id },
    }),
    stripe.prices.create({
      product: stripeProductId,
      currency: (plan.currency || 'PKR').toLowerCase(),
      unit_amount: Math.round(parseFloat(plan.annualPrice) * 100),
      recurring: { interval: 'year' },
      metadata: { billingPlanId: plan.id },
    }),
  ]);

  plan.stripeMonthlyPriceId = monthlyPrice.id;
  plan.stripeAnnualPriceId = annualPrice.id;
  plan.stripeSyncStatus = 'SYNCED';
  plan.stripeLastSyncedAt = new Date();
  await plan.save();
  return plan;
};

/**
 * iOS/Android sync is admin-attested — neither App Store Connect nor Play
 * Console exposes a safe API to set a subscription's price, so the admin
 * updates it there by hand and flips this afterward. A stated, deliberate
 * scope boundary, not automation pretending to exist.
 */
const markProviderSynced = async (id, provider) => {
  const plan = await getPlan(id);
  if (provider === 'ios') {
    plan.iosSyncStatus = 'SYNCED';
    plan.iosLastSyncedAt = new Date();
  } else if (provider === 'android') {
    plan.androidSyncStatus = 'SYNCED';
    plan.androidLastSyncedAt = new Date();
  } else {
    throw createError('provider must be "ios" or "android" — Stripe uses sync-stripe instead', 400);
  }
  await plan.save();
  return plan;
};

module.exports = { listPlans, getPlan, createPlan, updatePlan, syncStripePrice, markProviderSynced };
