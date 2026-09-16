const tenantService = require('../services/tenant.service');
const storageService = require('../services/storage.service');
const { sendSuccess, createError } = require('../utils/response.utils');

// ── POST /tenants/register ────────────────────────────────────────────────────
const register = async (req, res, next) => {
  try {
    const { businessName, email, phone, cityId, areaId } = req.body;
    const result = await tenantService.registerTenant({
      userId: req.user.sub,
      businessName,
      email,
      phone,
      cityId,
      areaId,
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

// ── POST /tenants/:id/onboarding-images ───────────────────────────────────────
// Step 4 photos, before the tenant has a real database — see
// tenant.service.js#addOnboardingImages for why this writes to
// mainBranchDataJson instead of a Branch row.
const uploadOnboardingImages = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) throw createError('At least one image is required', 422);
    const urls = await storageService.uploadImages(req.files, `tenants/${req.params.id}/onboarding-images`);
    const result = await tenantService.addOnboardingImages(req.params.id, req.user.sub, urls);
    return sendSuccess(res, result, 'Images uploaded');
  } catch (err) {
    next(err);
  }
};

// ── PUT /tenants/:id/onboarding-images ────────────────────────────────────────
// Full-array replace — how a removal round-trips (the client computes the
// list minus the one photo and sends the whole thing back), same shape as
// the post-onboarding edit-photos screen's updateBranchListingContent.
const replaceOnboardingImages = async (req, res, next) => {
  try {
    const imagesJson = Array.isArray(req.body.imagesJson) ? req.body.imagesJson : [];
    const result = await tenantService.updateOnboardingImages(req.params.id, req.user.sub, imagesJson);
    return sendSuccess(res, result, 'Images updated');
  } catch (err) {
    next(err);
  }
};

// ── POST /tenants/:id/finalize ────────────────────────────────────────────────
const finalizeApplication = async (req, res, next) => {
  try {
    const { paymentMethod, bankTransferRef } = req.body;
    const result = await tenantService.finalizeApplication(req.params.id, req.user.sub, { paymentMethod, bankTransferRef });
    return sendSuccess(res, result, 'Application finalized successfully');
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

// ── PATCH /tenants/me ────────────────────────────────────────────────────────
const updateMyTenant = async (req, res, next) => {
  try {
    const result = await tenantService.updateMyTenant(req.user.sub, req.body);
    return sendSuccess(res, result, 'Business profile updated successfully');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  register,
  submitGymProfile,
  selectPackage,
  uploadOnboardingImages,
  replaceOnboardingImages,
  finalizeApplication,
  getMyTenant,
  updateMyTenant,
};
