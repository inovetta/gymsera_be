const membershipPlanService = require('../services/membership-plan.service');
const { sendSuccess } = require('../utils/response.utils');

// ── GET /membership-plans?gymListingId=<uuid>&branchId=<uuid> (public) ────────
const listPublic = async (req, res, next) => {
  try {
    const { gymListingId, branchId } = req.query;
    const plans = await membershipPlanService.listPublic(gymListingId, branchId);
    return sendSuccess(res, { plans });
  } catch (err) {
    next(err);
  }
};

// ── GET /membership-plans/:id?gymListingId=<uuid> (public) ───────────────────
const getPublic = async (req, res, next) => {
  try {
    const plan = await membershipPlanService.getPublic(req.params.id, req.query.gymListingId);
    return sendSuccess(res, { plan });
  } catch (err) {
    next(err);
  }
};

// ── GET /membership-plans/host (auth + tenantContext) ─────────────────────────
const listForHost = async (req, res, next) => {
  try {
    const plans = await membershipPlanService.listForHost(req.tenantDb, req.query.branchId);
    return sendSuccess(res, { plans });
  } catch (err) {
    next(err);
  }
};

// ── POST /membership-plans (auth + GYM_HOST|BRANCH_MANAGER + tenantContext) ──
const createPlan = async (req, res, next) => {
  try {
    const plan = await membershipPlanService.createPlan(req.tenantDb, req.body);
    return sendSuccess(res, { plan }, 'Plan created successfully', 201);
  } catch (err) {
    next(err);
  }
};

// ── PATCH /membership-plans/:id ───────────────────────────────────────────────
const updatePlan = async (req, res, next) => {
  try {
    const plan = await membershipPlanService.updatePlan(req.tenantDb, req.params.id, req.body);
    return sendSuccess(res, { plan }, 'Plan updated successfully');
  } catch (err) {
    next(err);
  }
};

// ── DELETE /membership-plans/:id (GYM_HOST only) ─────────────────────────────
const deletePlan = async (req, res, next) => {
  try {
    const result = await membershipPlanService.deletePlan(req.tenantDb, req.params.id);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── POST /membership-plans/:id/status — toggle ACTIVE / INACTIVE ──────────────
const toggleStatus = async (req, res, next) => {
  try {
    const result = await membershipPlanService.toggleStatus(req.tenantDb, req.params.id);
    return sendSuccess(res, result, `Plan is now ${result.status}`);
  } catch (err) {
    next(err);
  }
};

// ── POST /membership-plans/:id/public — toggle traveller visibility ────────────
const togglePublic = async (req, res, next) => {
  try {
    const result = await membershipPlanService.togglePublic(req.tenantDb, req.params.id);
    const msg = result.isPublic ? 'Plan is now visible to travellers' : 'Plan is now hidden from travellers';
    return sendSuccess(res, result, msg);
  } catch (err) {
    next(err);
  }
};

// ── POST /membership-plans/:id/featured — set as "Starting from" price plan ───
const setFeatured = async (req, res, next) => {
  try {
    const result = await membershipPlanService.setFeatured(req.tenantDb, req.params.id);
    const msg = result.isFeatured
      ? 'Plan set as the featured "Starting from" price'
      : 'Plan unfeatured — starting price reverts to cheapest public plan';
    return sendSuccess(res, result, msg);
  } catch (err) {
    next(err);
  }
};

// ── POST /membership-plans/:id/poster — upload plan poster ───────────────────
const uploadPoster = async (req, res, next) => {
  try {
    if (!req.file) {
      const err = new Error('Image file is required');
      err.statusCode = 422;
      return next(err);
    }

    const posterUrl = `${process.env.STORAGE_BASE_URL || '/uploads'}/plans/${req.params.id}-${Date.now()}.jpg`;
    const result = await membershipPlanService.updatePoster(req.tenantDb, req.params.id, posterUrl);
    return sendSuccess(res, result, 'Poster updated');
  } catch (err) {
    next(err);
  }
};

module.exports = { listPublic, getPublic, listForHost, createPlan, updatePlan, deletePlan, toggleStatus, togglePublic, setFeatured, uploadPoster };
