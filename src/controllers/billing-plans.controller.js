const catalogService = require('../services/billing-plan-catalog.service');
const priceVerification = require('../services/price-verification.service');
const { sendSuccess } = require('../utils/response.utils');

// ── GET /admin/billing-plans — list every tier, all provider IDs + sync statuses ──
const listPlans = async (req, res, next) => {
  try {
    const plans = await catalogService.listPlans();
    return sendSuccess(res, await priceVerification.listPlansWithVerification(plans));
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/billing-plans/:id ──────────────────────────────────────────────
const getPlan = async (req, res, next) => {
  try {
    const plan = await catalogService.getPlan(req.params.id);
    const [withVerification] = await priceVerification.listPlansWithVerification([plan]);
    return sendSuccess(res, withVerification);
  } catch (err) {
    next(err);
  }
};

// ── POST /admin/billing-plans — create a tier ─────────────────────────────────
const createPlan = async (req, res, next) => {
  try {
    const plan = await catalogService.createPlan(req.body);
    return sendSuccess(res, plan, 'Billing plan created', 201);
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /admin/billing-plans/:id
 *
 * Editing monthlyPrice/annualPrice changes only this catalog's own price —
 * never a provider's live configuration, never an existing subscriber's
 * locked-in price — and flags every provider PENDING so it's visible they
 * may now be stale. See billing-plan-catalog.service.js.
 */
const updatePlan = async (req, res, next) => {
  try {
    const plan = await catalogService.updatePlan(req.params.id, req.body);
    return sendSuccess(res, plan, 'Billing plan updated');
  } catch (err) {
    next(err);
  }
};

// ── PUT /admin/billing-plans/:id/prices/:currency — set one extra currency (BILL-11) ──
const upsertPrice = async (req, res, next) => {
  try {
    const price = await catalogService.upsertPrice(req.params.id, { ...req.body, currency: req.params.currency });
    return sendSuccess(res, price, 'Billing plan price saved');
  } catch (err) {
    next(err);
  }
};

// ── DELETE /admin/billing-plans/:id/prices/:currency ──────────────────────────
const deletePrice = async (req, res, next) => {
  try {
    await catalogService.deletePrice(req.params.id, req.params.currency);
    return sendSuccess(res, null, 'Billing plan price removed');
  } catch (err) {
    next(err);
  }
};

// ── POST /admin/billing-plans/:id/prices/:currency/sync-stripe ────────────────
const syncStripeCurrencyPrice = async (req, res, next) => {
  try {
    const price = await catalogService.syncStripePriceForCurrency(req.params.id, req.params.currency);
    return sendSuccess(res, price, 'Stripe prices synced');
  } catch (err) {
    next(err);
  }
};

// ── POST /admin/billing-plans/:id/sync-stripe — real API push to Stripe ──────
const syncStripe = async (req, res, next) => {
  try {
    const plan = await catalogService.syncStripePrice(req.params.id);
    return sendSuccess(res, plan, 'Stripe price synced');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /admin/billing-plans/:id/mark-synced
 * body: { provider: 'ios' | 'android' }
 *
 * Admin-attested only — neither App Store Connect nor Play Console exposes
 * a safe price-write API, so the admin updates the price there by hand and
 * flips this afterward.
 */
const markSynced = async (req, res, next) => {
  try {
    const plan = await catalogService.markProviderSynced(req.params.id, req.body.provider);
    return sendSuccess(res, plan, 'Marked as synced');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listPlans, getPlan, createPlan, updatePlan, syncStripe, markSynced,
  upsertPrice, deletePrice, syncStripeCurrencyPrice,
};
