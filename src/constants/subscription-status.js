const SubscriptionStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  FROZEN: 'FROZEN',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
};

const TenantStatus = {
  DRAFT: 'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
  ACTIVE: 'ACTIVE',
  // Account deletion (AUTH-07, R-28, platform migration p015): inside the 30-day undo
  // window / finished (anonymized in place, database kept). Appended last on purpose —
  // the DB enum was widened by appending.
  PENDING_DELETION: 'PENDING_DELETION',
  DELETED: 'DELETED',
};

const KycStatus = {
  NOT_SUBMITTED: 'NOT_SUBMITTED',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
};

// Phase 7 P9, R-85 (NEW-185): the verification documents a host can send. An upload with no type
// (older app builds) keeps the storage default.
const KycDocumentType = {
  OWNER_ID: 'OWNER_ID',
  BUSINESS_REGISTRATION: 'BUSINESS_REGISTRATION',
  PROOF_OF_PREMISES: 'PROOF_OF_PREMISES',
};

module.exports = { SubscriptionStatus, TenantStatus, KycStatus, KycDocumentType };
