/**
 * R-119 D5 / D10 / D11: business-level KYC on gym_listings (platform migration p033).
 *
 *  - Documents of one business: BUSINESS_REGISTRATION (optional; drives the verified badge) and
 *    PROOF_OF_PREMISES (required for approval). Same storage and descriptor shape as the tenant documents
 *    of R-85 / SEC-10 (kyc-storage.service.js); only the record they are listed on differs.
 *  - Approval needs: proof of premises and 3 or more photos (cover, gallery, or the held first branch's).
 *  - Verified badge: an admin who approved the registration document sets verified_at / verified_by;
 *    revoke clears both. Never affects approval or traveller visibility.
 */
const { GymListing, Tenant, PlatformAuditLog } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const { KycDocumentType } = require('../constants/subscription-status');
const { UserRole } = require('../constants/roles');
const kycStorageService = require('./kyc-storage.service');

const BUSINESS_DOCUMENT_TYPES = Object.freeze([KycDocumentType.BUSINESS_REGISTRATION, KycDocumentType.PROOF_OF_PREMISES]);
const MIN_PHOTOS = 3;

const coded = (message, status, code, extra = {}) => {
  const err = createError(message, status);
  err.code = code;
  Object.assign(err, extra);
  return err;
};

const docsOf = (listing) => kycStorageService.normalizeKycDocuments(listing.kycDocumentsJson);

/** The listing, when the caller is its tenant's owner or a platform admin; 404 otherwise (no existence leak). */
const _listingFor = async (listingId, userId, userRole) => {
  const listing = await GymListing.findByPk(listingId);
  if (!listing) throw createError('Business not found', 404);
  if (userRole === UserRole.PLATFORM_ADMIN) return listing;
  const tenant = await Tenant.findByPk(listing.tenantId, { attributes: ['id', 'ownerUserId'] });
  if (!tenant || tenant.ownerUserId !== userId) throw createError('Business not found', 404);
  return listing;
};

const _audit = (actorUserId, action, listing, details = {}) =>
  PlatformAuditLog.create({ actorUserId, action, targetType: 'GymListing', targetId: listing.id, details, createdAt: new Date() });

/** Every distinct photo of the business: cover, gallery, and the held first branch's images. */
const photosOf = (listing) => {
  const held = listing.firstBranchDataJson && Array.isArray(listing.firstBranchDataJson.images) ? listing.firstBranchDataJson.images : [];
  const gallery = Array.isArray(listing.imagesJson) ? listing.imagesJson : [];
  return [...new Set([listing.coverImageUrl, ...gallery, ...held].filter((u) => typeof u === 'string' && u.trim()))];
};

/** D10: what this business still needs before an admin may approve it. [] = ready. */
const missingForApproval = (listing) => {
  const missing = [];
  if (!docsOf(listing).some((d) => d.documentType === KycDocumentType.PROOF_OF_PREMISES)) missing.push('PROOF_OF_PREMISES');
  if (photosOf(listing).length < MIN_PHOTOS) missing.push('PHOTOS_MIN_3');
  return missing;
};

const assertReadyForApproval = (listing) => {
  const missing = missingForApproval(listing);
  if (missing.length > 0) {
    throw coded('This business is missing what approval needs: proof of premises and at least 3 photos.', 422, 'business_requirements_missing', { details: { missing } });
  }
};

const uploadDocuments = async ({ listingId, userId, userRole, files, documentType }) => {
  if (!BUSINESS_DOCUMENT_TYPES.includes(documentType)) {
    throw coded('documentType must be BUSINESS_REGISTRATION or PROOF_OF_PREMISES', 422, 'invalid_document_type');
  }
  if (!files || files.length === 0) throw createError('At least one document file is required', 422);
  const listing = await _listingFor(listingId, userId, userRole);
  const added = [];
  for (const file of files) {
    added.push(await kycStorageService.uploadKycDocument({
      buffer: file.buffer, mimetype: file.mimetype, tenantId: listing.tenantId, originalName: file.originalname, documentType,
    }));
  }
  const update = { kycDocumentsJson: [...docsOf(listing), ...added], kycSubmittedAt: new Date() };
  if (['NOT_SUBMITTED', 'REJECTED'].includes(listing.kycStatus)) update.kycStatus = 'PENDING';
  await listing.update(update);
  await _audit(userId, 'BUSINESS_KYC_DOCUMENT_UPLOADED', listing, { documentType, documentIds: added.map((d) => d.documentId) });
  return added.map((d) => serializeDocument(listing, d));
};

const serializeDocument = (listing, doc) => ({
  documentId: doc.documentId,
  originalName: doc.originalName,
  mimetype: doc.mimetype,
  size: doc.size,
  documentType: doc.documentType,
  uploadedAt: doc.uploadedAt,
  streamUrl: `/api/v1/host/listings/${listing.id}/kyc-documents/${doc.documentId}/stream`,
});

const listDocuments = async ({ listingId, userId, userRole }) => {
  const listing = await _listingFor(listingId, userId, userRole);
  return docsOf(listing).map((d) => serializeDocument(listing, d));
};

const streamDocument = async ({ listingId, documentId, userId, userRole, reqInfo }) => {
  const listing = await _listingFor(listingId, userId, userRole);
  const doc = docsOf(listing).find((d) => d.documentId === documentId);
  if (!doc) throw createError('Document not found', 404);
  await _audit(userId, 'BUSINESS_KYC_DOCUMENT_ACCESSED', listing, {
    documentId, ip: reqInfo?.ip, userAgent: reqInfo?.userAgent, isPlatformAdmin: userRole === UserRole.PLATFORM_ADMIN,
  });
  const { stream, contentType, contentLength } = await kycStorageService.getKycStream(doc.key);
  return { stream, doc, contentType: doc.mimetype || contentType || 'application/octet-stream', contentLength };
};

/** D11: an admin approved the registration document → the badge. Needs an uploaded registration. */
const verify = async (listingId, adminUserId) => {
  const listing = await GymListing.findByPk(listingId);
  if (!listing) throw createError('Business not found', 404);
  if (!docsOf(listing).some((d) => d.documentType === KycDocumentType.BUSINESS_REGISTRATION)) {
    throw coded('Upload the business registration document before it can be verified.', 422, 'registration_missing');
  }
  await listing.update({ verifiedAt: new Date(), verifiedBy: adminUserId });
  await _audit(adminUserId, 'BUSINESS_VERIFIED', listing);
  return { listingId: listing.id, businessVerified: true, verifiedAt: listing.verifiedAt };
};

const unverify = async (listingId, adminUserId) => {
  const listing = await GymListing.findByPk(listingId);
  if (!listing) throw createError('Business not found', 404);
  await listing.update({ verifiedAt: null, verifiedBy: null });
  await _audit(adminUserId, 'BUSINESS_UNVERIFIED', listing);
  return { listingId: listing.id, businessVerified: false, verifiedAt: null };
};

/** The additive host / admin fields of one business (spec §2.1). */
const businessFields = (listing) => ({
  kycStatus: listing.kycStatus,
  approvedAt: listing.approvedAt || null,
  businessVerified: Boolean(listing.verifiedAt),
  verifiedAt: listing.verifiedAt || null,
  canReceiveBranches: listing.status === 'ACTIVE',
  heldFirstBranch: Boolean(listing.firstBranchDataJson),
  missingForApproval: listing.status === 'ACTIVE' ? [] : missingForApproval(listing),
});

/**
 * A listing row for the host / admin API: the §2.1 fields added, and the raw document descriptors (which
 * carry private storage keys) replaced by `kycDocuments` (no keys, stream URLs).
 */
const withBusinessFields = (plain, listing) => {
  const { kycDocumentsJson, ...rest } = plain;
  return { ...rest, ...businessFields(listing), kycDocuments: docsOf(listing).map((d) => serializeDocument(listing, d)) };
};

module.exports = {
  withBusinessFields,
  BUSINESS_DOCUMENT_TYPES,
  MIN_PHOTOS,
  photosOf,
  missingForApproval,
  assertReadyForApproval,
  uploadDocuments,
  listDocuments,
  streamDocument,
  verify,
  unverify,
  businessFields,
};
