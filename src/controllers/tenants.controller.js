const tenantService = require('../services/tenant.service');
const storageService = require('../services/storage.service');
const { sendSuccess, createError } = require('../utils/response.utils');
const { KycDocumentType } = require('../constants/subscription-status');
const { normalizeKycDocuments } = require('../services/kyc-storage.service');

/**
 * P9b item 0 (old app builds) and NEW-190: a host's tenant answer lists its verification documents
 * by file name only. Released app builds read `kycDocumentsJson` as a list of strings
 * (tenant_model.g.dart `e as String`) and failed to parse /tenants/me for every host who had sent a
 * document; the P9 app reads names from either shape. The stored objects keep the private storage
 * `key`, which the owner never needs (GET /tenants/:id/kyc-documents is the list with types).
 */
const hostTenantView = (result) => {
  if (!result || !result.tenant) return result;
  const tenant = typeof result.tenant.toJSON === 'function' ? result.tenant.toJSON() : { ...result.tenant };
  // NEW-195: the tenant database's encrypted connection string and name are never the owner's to read.
  delete tenant.connectionStringEncrypted;
  delete tenant.dbName;
  if (tenant.kycDocumentsJson != null) {
    tenant.kycDocumentsJson = normalizeKycDocuments(tenant.kycDocumentsJson).map((d) => d.originalName || 'document');
  }
  return { ...result, tenant };
};

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
    return sendSuccess(res, hostTenantView(result), 'Gym business registered successfully. Your application is under review.', 201);
  } catch (err) {
    next(err);
  }
};

// ── POST /tenants/:id/gym-profile ─────────────────────────────────────────────
const submitGymProfile = async (req, res, next) => {
  try {
    const result = await tenantService.submitGymProfile(req.params.id, req.user.sub, req.body);
    return sendSuccess(res, hostTenantView(result), 'Gym profile submitted successfully');
  } catch (err) {
    next(err);
  }
};

// ── POST /tenants/:id/select-package ──────────────────────────────────────────
const selectPackage = async (req, res, next) => {
  try {
    const result = await tenantService.selectPackage(req.params.id, req.user.sub, req.body.packageId);
    return sendSuccess(res, hostTenantView(result), 'Package selected successfully');
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

// ── POST /tenants/:id/reapply (FLOW-04) ──────────────────────────────────────
const reapplyTenant = async (req, res, next) => {
  try {
    const result = await tenantService.reapplyTenant(req.params.id, req.user.sub);
    return sendSuccess(res, hostTenantView(result), 'Application reopened. Update it and submit again.');
  } catch (err) {
    next(err);
  }
};

// ── POST /tenants/:id/finalize ────────────────────────────────────────────────
const finalizeApplication = async (req, res, next) => {
  try {
    const { paymentMethod, bankTransferRef } = req.body;
    const result = await tenantService.finalizeApplication(req.params.id, req.user.sub, { paymentMethod, bankTransferRef });
    return sendSuccess(res, hostTenantView(result), 'Application finalized successfully');
  } catch (err) {
    next(err);
  }
};

// ── GET /tenants/me ───────────────────────────────────────────────────────────
const getMyTenant = async (req, res, next) => {
  try {
    const result = await tenantService.getMyTenant(req.user.sub);
    return sendSuccess(res, hostTenantView(result));
  } catch (err) {
    next(err);
  }
};

// ── PATCH /tenants/me ────────────────────────────────────────────────────────
const updateMyTenant = async (req, res, next) => {
  try {
    const result = await tenantService.updateMyTenant(req.user.sub, req.body);
    return sendSuccess(res, hostTenantView(result), 'Business profile updated successfully');
  } catch (err) {
    next(err);
  }
};

// ── POST /tenants/:id/kyc-documents ───────────────────────────────────────────
const uploadKycDocuments = async (req, res, next) => {
  try {
    let files = [];
    if (req.files && Array.isArray(req.files)) {
      files = req.files;
    } else if (req.file) {
      files = [req.file];
    }

    const { documentType } = req.body;
    if (documentType !== undefined && !Object.values(KycDocumentType).includes(documentType)) {
      throw createError('Choose which document this is: ID, business registration or proof of premises.', 422, 'invalid_document_type');
    }
    const result = await tenantService.uploadKycDocuments({
      tenantId: req.params.id,
      userId: req.user.sub,
      userRole: req.user.role,
      files,
      documentType,
    });
    return sendSuccess(res, result, 'KYC document(s) uploaded successfully', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /tenants/:id/kyc-documents ────────────────────────────────────────────
const getKycDocuments = async (req, res, next) => {
  try {
    const result = await tenantService.getKycDocuments({
      tenantId: req.params.id,
      userId: req.user.sub,
      userRole: req.user.role,
    });
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── GET /tenants/:id/kyc-documents/:documentId/stream ─────────────────────────
const streamKycDocument = async (req, res, next) => {
  try {
    const reqInfo = {
      ip: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('user-agent'),
    };
    const { stream, doc, contentType, contentLength } = await tenantService.getKycDocumentStream({
      tenantId: req.params.id,
      documentId: req.params.documentId,
      userId: req.user.sub,
      userRole: req.user.role,
      reqInfo,
    });

    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.originalName || 'document')}"`);
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    if (stream.pipe) {
      stream.pipe(res);
    } else {
      res.send(stream);
    }
  } catch (err) {
    next(err);
  }
};

// ── DELETE /tenants/:id/kyc-documents/:documentId ─────────────────────────────
const deleteKycDocument = async (req, res, next) => {
  try {
    const result = await tenantService.deleteKycDocument({
      tenantId: req.params.id,
      documentId: req.params.documentId,
      userId: req.user.sub,
      userRole: req.user.role,
    });
    return sendSuccess(res, result, 'KYC document deleted successfully');
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
  reapplyTenant,
  getMyTenant,
  updateMyTenant,
  uploadKycDocuments,
  getKycDocuments,
  streamKycDocument,
  deleteKycDocument,
};

