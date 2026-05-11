const tenantService = require('../services/tenant.service');
const { sendSuccess } = require('../utils/response.utils');

// ── POST /tenants/register ────────────────────────────────────────────────────
const register = async (req, res, next) => {
  try {
    const { businessName, email, phone, cityId } = req.body;
    const result = await tenantService.registerTenant({
      userId: req.user.sub,
      businessName,
      email,
      phone,
      cityId,
    });
    return sendSuccess(res, result, 'Gym business registered successfully. Your application is under review.', 201);
  } catch (err) {
    next(err);
  }
};

// ── POST /tenants/:id/gym-profile ─────────────────────────────────────────────
const submitGymProfile = async (req, res, next) => {
  try {
    const result = await tenantService.submitGymProfile(req.params.id, req.user.sub, req.body);
    return sendSuccess(res, result, 'Gym profile submitted successfully');
  } catch (err) {
    next(err);
  }
};

// ── POST /tenants/:id/select-package ──────────────────────────────────────────
const selectPackage = async (req, res, next) => {
  try {
    const result = await tenantService.selectPackage(req.params.id, req.user.sub, req.body.packageId);
    return sendSuccess(res, result, 'Package selected successfully');
  } catch (err) {
    next(err);
  }
};

// ── GET /tenants/me ───────────────────────────────────────────────────────────
const getMyTenant = async (req, res, next) => {
  try {
    const result = await tenantService.getMyTenant(req.user.sub);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

module.exports = { register, submitGymProfile, selectPackage, getMyTenant };
