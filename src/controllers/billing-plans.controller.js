const catalogService = require('../services/billing-plan-catalog.service');
const { sendSuccess } = require('../utils/response.utils');

// ── GET /admin/billing-plans — list every tier, all provider IDs + sync statuses ──
const listPlans = async (req, res, next) => {
  try {
    const plans = await catalogService.listPlans();
    return sendSuccess(res, plans);
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/billing-plans/:id ──────────────────────────────────────────────
const getPlan = async (req, res, next) => {
  try {
    const plan = await catalogService.getPlan(req.params.id);
    return sendSuccess(res, plan);
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

module.exports = { listPlans, getPlan, createPlan, updatePlan, syncStripe, markSynced };
