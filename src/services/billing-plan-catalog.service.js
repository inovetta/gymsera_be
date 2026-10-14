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
const { BillingPlan, BillingPlanPrice } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const { toMinorUnits } = require('../utils/money.utils');
const { normalizeCurrency, isSupportedCurrency, minorDigits } = require('../utils/currency.utils');

/**
 * The price of `plan` in `currency` (BILL-11): a BillingPlanPrice row when one exists, otherwise the plan's own
 * default price when that is the requested currency, otherwise null. `prices` is the plan's loaded `prices`.
 * Returned in major units (what clients display), with the Stripe Price IDs for that currency.
 */
const priceForCurrency = (plan, currency) => {
  const code = normalizeCurrency(currency);
  if (!code || code === normalizeCurrency(plan.currency)) {
    return {
      currency: normalizeCurrency(plan.currency),
      monthlyPrice: parseFloat(plan.monthlyPrice),
      annualPrice: parseFloat(plan.annualPrice),
      stripeMonthlyPriceId: plan.stripeMonthlyPriceId,
      stripeAnnualPriceId: plan.stripeAnnualPriceId,
    };
  }
  const row = (plan.prices || []).find((p) => normalizeCurrency(p.currency) === code);
  if (!row) return null;
  const div = 10 ** minorDigits(code);
  return {
    currency: code,
    monthlyPrice: Number(row.monthlyMinor) / div,
    annualPrice: Number(row.annualMinor) / div,
    stripeMonthlyPriceId: row.stripeMonthlyPriceId,
    stripeAnnualPriceId: row.stripeAnnualPriceId,
  };
};

/** Add or replace the `currency` price of a tier. Amounts are major units ("9.99"); stored as integer minor units. */
const upsertPrice = async (planId, fields) => {
  const plan = await getPlan(planId);
  const currency = normalizeCurrency(fields.currency);
  if (!isSupportedCurrency(currency)) throw createError(`Currency "${fields.currency}" is not supported.`, 400);
  if (currency === normalizeCurrency(plan.currency)) {
    throw createError(`${currency} is this plan's default currency; edit monthlyPrice / annualPrice instead.`, 409);
  }
  const digits = minorDigits(currency);
  const monthlyMinor = toMinorUnits(fields.monthlyPrice, digits);
  const annualMinor = toMinorUnits(fields.annualPrice, digits);
  if (!(monthlyMinor > 0) || !(annualMinor > 0)) throw createError('Prices must be greater than zero.', 400);

  const existing = await BillingPlanPrice.findOne({ where: { billingPlanId: plan.id, currency } });
  const values = { monthlyMinor, annualMinor };
  if (fields.stripeMonthlyPriceId !== undefined) values.stripeMonthlyPriceId = fields.stripeMonthlyPriceId || null;
  if (fields.stripeAnnualPriceId !== undefined) values.stripeAnnualPriceId = fields.stripeAnnualPriceId || null;
  if (existing) {
    // A changed amount invalidates the Stripe Price IDs that were created for the old amount: Stripe Prices are
    // immutable, so a stale ID would keep charging the old number. Clear them unless the caller sent new ones.
    const changed = Number(existing.monthlyMinor) !== monthlyMinor || Number(existing.annualMinor) !== annualMinor;
    if (changed && fields.stripeMonthlyPriceId === undefined) values.stripeMonthlyPriceId = null;
    if (changed && fields.stripeAnnualPriceId === undefined) values.stripeAnnualPriceId = null;
    await existing.update(values);
    return existing;
  }
  return BillingPlanPrice.create({ billingPlanId: plan.id, currency, ...values });
};

const deletePrice = async (planId, currency) => {
  const deleted = await BillingPlanPrice.destroy({ where: { billingPlanId: planId, currency: normalizeCurrency(currency) } });
  if (!deleted) throw createError('Price not found', 404);
};

const listPlans = async () => {
  return BillingPlan.findAll({ include: [{ model: BillingPlanPrice, as: 'prices' }], order: [['sortOrder', 'ASC']] });
};

const getPlan = async (id) => {
  const plan = await BillingPlan.findByPk(id, { include: [{ model: BillingPlanPrice, as: 'prices' }] });
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
 * subscriber's TenantSubscription.amount (that mirrors what the provider
 * actually charges, written only by the verified provider sync — BILL-05,
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

/**
 * Stripe sync for one extra currency of a tier (BILL-11): creates new Prices at the row's minor amounts under the
 * tier's Stripe Product and stores their IDs on the price row. Same rule as syncStripePrice: Prices are immutable.
 */
const syncStripePriceForCurrency = async (planId, currency) => {
  const plan = await getPlan(planId);
  const code = normalizeCurrency(currency);
  const row = (plan.prices || []).find((p) => normalizeCurrency(p.currency) === code);
  if (!row) throw createError('Price not found', 404);
  if (!process.env.STRIPE_SECRET_KEY) throw createError('Stripe is not configured on the server', 500);
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let stripeProductId = plan.stripeProductId;
  if (!stripeProductId) {
    const product = await stripe.products.create({
      name: `GymsEra — ${plan.branchCount} branch${plan.branchCount > 1 ? 'es' : ''}`,
      metadata: { billingPlanId: plan.id, branchCount: String(plan.branchCount) },
    });
    stripeProductId = product.id;
    plan.stripeProductId = stripeProductId;
    await plan.save();
  }

  const make = (minor, interval) => stripe.prices.create({
    product: stripeProductId,
    currency: code.toLowerCase(),
    unit_amount: Number(minor),
    recurring: { interval },
    metadata: { billingPlanId: plan.id, currency: code },
  });
  const [monthly, annual] = await Promise.all([make(row.monthlyMinor, 'month'), make(row.annualMinor, 'year')]);
  await row.update({ stripeMonthlyPriceId: monthly.id, stripeAnnualPriceId: annual.id });
  return row;
};

module.exports = {
  listPlans, getPlan, createPlan, updatePlan, syncStripePrice, markProviderSynced,
  priceForCurrency, upsertPrice, deletePrice, syncStripePriceForCurrency,
};
