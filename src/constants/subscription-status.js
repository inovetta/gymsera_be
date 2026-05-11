const SubscriptionStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  FROZEN: 'FROZEN',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
};

const TenantStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
  ACTIVE: 'ACTIVE',
};

const KycStatus = {
  NOT_SUBMITTED: 'NOT_SUBMITTED',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
};

module.exports = { SubscriptionStatus, TenantStatus, KycStatus };
