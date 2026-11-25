'use strict';

/**
 * NEW-303 M2: business KYC documents, approval requirements and the verified badge
 * (enterprise D10 / D11, API contract A1 G4, A2 H3, J11).
 *
 * Documents live in `business_listings.kyc_documents_json`, files in the one private store
 * (`kyc-storage.service.js`, R-27). Clients only ever see `{ id, type, status, uploadedAt, reviewedAt,
 * rejectionReason }`: never the storage key, file name or a URL.
 */

const { PlatformAuditLog } = require('../models/platform');
const kycStorage = require('./kyc-storage.service');
const { createError } = require('../utils/response.utils');
const { KycDocumentType } = require('../constants/subscription-status');

const BUSINESS_DOCUMENT_TYPES = [KycDocumentType.BUSINESS_REGISTRATION, KycDocumentType.PROOF_OF_PREMISES];
const MIN_PHOTOS = 3;

const parseJson = (v) => {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return v;
};

const documentsOf = (listing) => {
  const docs = parseJson(listing.kycDocumentsJson);
  return Array.isArray(docs) ? docs : [];
};

/** The one public document shape (H3). */
const publicDocument = (d) => ({
  id: d.documentId,
  type: d.documentType,
  status: d.status || 'PENDING',
  uploadedAt: d.uploadedAt || null,
  reviewedAt: d.reviewedAt || null,
  rejectionReason: d.rejectionReason || null,
});

const publicDocuments = (listing) => documentsOf(listing).map(publicDocument);

/** Approved = admin approved AND live. The one rule behind the 409 and traveller visibility (enterprise §1.4). */
const isApproved = (listing) => !!listing && listing.status === 'ACTIVE' && listing.kycStatus === 'APPROVED';

const photoUrls = (listing) => {
  const draft = parseJson(listing.firstBranchDraft) || {};
  const urls = [listing.coverImageUrl, ...(parseJson(listing.imagesJson) || []), ...(draft.imagesJson || [])];
  return [...new Set(urls.filter((u) => typeof u === 'string' && u.trim()))];
};

/** What an approval still lacks (D10): the list sent as `missing` in 422 `business_requirements_missing`. */
const missingForApproval = (listing) => {
  const missing = [];
  const proof = documentsOf(listing).some((d) => d.documentType === KycDocumentType.PROOF_OF_PREMISES && d.status !== 'REJECTED');
  if (!proof) missing.push('PROOF_OF_PREMISES');
  if (photoUrls(listing).length < MIN_PHOTOS) missing.push('PHOTOS_MIN_3');
  return missing;
};

const hasRegistration = (listing) => documentsOf(listing).some((d) => d.documentType === KycDocumentType.BUSINESS_REGISTRATION);

const audit = (actorUserId, action, listing, details = {}) =>
  PlatformAuditLog.create({
    actorUserId,
    action,
    targetType: 'GymListing',
    targetId: listing.id,
    details,
    createdAt: new Date(),
  });

const uploadDocuments = async ({ listing, files, type, userId }) => {
  if (!BUSINESS_DOCUMENT_TYPES.includes(type)) {
    throw createError('Choose which document this is: business registration or proof of premises.', 422, 'invalid_document_type');
  }
  if (!files || files.length === 0) throw createError('At least one document file is required', 422);
  const added = [];
  for (const file of files) {
    const d = await kycStorage.uploadKycDocument({
      buffer: file.buffer,
      mimetype: file.mimetype,
      organizationId: listing.organizationId,
      originalName: file.originalname,
      documentType: type,
    });
    added.push({ ...d, status: 'PENDING', reviewedAt: null, reviewedBy: null, rejectionReason: null });
  }
  const now = new Date();
  const fields = { kycDocumentsJson: [...documentsOf(listing), ...added] };
  if (listing.kycStatus === 'NOT_SUBMITTED' || listing.kycStatus === 'REJECTED') {
    fields.kycStatus = 'PENDING';
    fields.kycSubmittedAt = now;
  }
  await listing.update(fields);
  await audit(userId, 'BUSINESS_KYC_DOCUMENT_UPLOADED', listing, { type, documentIds: added.map((d) => d.documentId) });
  return added.map(publicDocument);
};

const findDocument = (listing, documentId) => {
  const doc = documentsOf(listing).find((d) => d.documentId === documentId);
  if (!doc) throw createError('KYC document not found', 404);
  return doc;
};

const streamDocument = async ({ listing, documentId, userId, isPlatformAdmin, reqInfo }) => {
  const doc = findDocument(listing, documentId);
  await audit(userId, 'BUSINESS_KYC_DOCUMENT_ACCESSED', listing, {
    documentId, type: doc.documentType, ip: reqInfo?.ip, userAgent: reqInfo?.userAgent, isPlatformAdmin: !!isPlatformAdmin,
  });
  const { stream, contentType, contentLength } = await kycStorage.getKycStream(doc.key);
  return { stream, doc, contentType: doc.mimetype || contentType || 'application/octet-stream', contentLength };
};

/** Admin approves or rejects one document. Approving a registration sets the badge (D11). */
const reviewDocument = async ({ listing, documentId, decision, reason, adminUserId }) => {
  const docs = documentsOf(listing);
  const doc = docs.find((d) => d.documentId === documentId);
  if (!doc) throw createError('KYC document not found', 404);
  if (decision === 'REJECTED' && !(reason && String(reason).trim())) {
    throw createError('A reason is required to reject a document', 422, 'reason_required');
  }
  const now = new Date();
  const updated = docs.map((d) => (d.documentId === documentId
    ? { ...d, status: decision, reviewedAt: now.toISOString(), reviewedBy: adminUserId, rejectionReason: decision === 'REJECTED' ? String(reason).trim() : null }
    : d));
  const fields = { kycDocumentsJson: updated };
  if (doc.documentType === KycDocumentType.BUSINESS_REGISTRATION) {
    if (decision === 'APPROVED') {
      fields.verifiedAt = now;
      fields.verifiedBy = adminUserId;
    } else if (listing.verifiedAt && !updated.some((d) => d.documentType === KycDocumentType.BUSINESS_REGISTRATION && d.status === 'APPROVED')) {
      fields.verifiedAt = null;
      fields.verifiedBy = null;
    }
  }
  await listing.update(fields);
  await audit(adminUserId, decision === 'APPROVED' ? 'BUSINESS_KYC_DOCUMENT_APPROVED' : 'BUSINESS_KYC_DOCUMENT_REJECTED', listing, { documentId, type: doc.documentType });
  if (fields.verifiedAt) await audit(adminUserId, 'business.verify', listing, { documentId });
  return publicDocument(updated.find((d) => d.documentId === documentId));
};

/** POST /admin/businesses/:id/verify: needs an uploaded registration (422 registration_missing). */
const verify = async ({ listing, adminUserId }) => {
  if (!hasRegistration(listing)) throw createError('Upload a business registration document first', 422, 'registration_missing');
  const docs = documentsOf(listing).map((d) => (d.documentType === KycDocumentType.BUSINESS_REGISTRATION && d.status !== 'APPROVED'
    ? { ...d, status: 'APPROVED', reviewedAt: new Date().toISOString(), reviewedBy: adminUserId, rejectionReason: null }
    : d));
  await listing.update({ verifiedAt: new Date(), verifiedBy: adminUserId, kycDocumentsJson: docs });
  await audit(adminUserId, 'business.verify', listing);
  return listing;
};

/** DELETE /admin/businesses/:id/verify: revocable (D11). */
const unverify = async ({ listing, adminUserId }) => {
  await listing.update({ verifiedAt: null, verifiedBy: null });
  await audit(adminUserId, 'business.unverify', listing);
  return listing;
};

module.exports = {
  BUSINESS_DOCUMENT_TYPES,
  MIN_PHOTOS,
  documentsOf,
  publicDocument,
  publicDocuments,
  isApproved,
  missingForApproval,
  hasRegistration,
  uploadDocuments,
  streamDocument,
  reviewDocument,
  verify,
  unverify,
  audit,
};
