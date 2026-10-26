/**
 * Where a host stands: one answer for every client (Phase 7 P2, BUG-11/12/13/18/24).
 *
 * Before this, each host tab guessed from a different source — /host/today-summary's
 * A/B/C state (read from the JWT's tenantId), the listings' statuses, constants on
 * Host Profile — so one host saw "under review" on one tab and "Verified, Growth Plan"
 * on another while their payment was still due. The status here is derived only from
 * stored facts: the tenant the caller OWNS (never a selector the client sends), its
 * entitling subscription row and the review fields.
 *
 *   NONE              the caller owns no gym                      → BECOME_HOST
 *   DRAFT             not submitted, listing not finished         → COMPLETE_LISTING
 *   AWAITING_PAYMENT  listing finished, hosting plan not paid     → CHOOSE_PLAN
 *   DRAFT             paid in the store, not submitted yet        → SUBMIT_APPLICATION
 *   PENDING_REVIEW    submitted (or approved, still provisioning) → WAIT_FOR_REVIEW
 *   REJECTED          with the admin's reason                     → FIX_AND_RESUBMIT
 *   APPROVED          tenant ACTIVE                               → NONE | PAY_SUBSCRIPTION | CHOOSE_PLAN
 *   SUSPENDED                                                     → CONTACT_SUPPORT
 *   CLOSED            account deletion pending or done            → NONE
 *
 * "Paid" means an entitling row (ACTIVE/GRACE) whose paymentStatus is PAID: a store or
 * Stripe purchase, or a bank transfer the admin verified (NEW-20). A pay-later GRACE
 * plan is entitled but not paid. `plan` (the tier label) is only sent once paid, so no
 * screen can show a plan name the host has not bought (BUG-13, BUG-24).
 */
const { Tenant } = require('../models/platform');
const { TenantStatus, KycStatus } = require('../constants/subscription-status');
const { tierForBranchCount } = require('../constants/plan-tiers');
const subscriptionQuotaService = require('./subscription-quota.service');
const { mainBranchPlans } = require('./tenant.service');

const HostStatus = {
  NONE: 'NONE',
  DRAFT: 'DRAFT',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
};

const NextAction = {
  BECOME_HOST: 'BECOME_HOST',
  COMPLETE_LISTING: 'COMPLETE_LISTING',
  CHOOSE_PLAN: 'CHOOSE_PLAN',
  SUBMIT_APPLICATION: 'SUBMIT_APPLICATION',
  WAIT_FOR_REVIEW: 'WAIT_FOR_REVIEW',
  FIX_AND_RESUBMIT: 'FIX_AND_RESUBMIT',
  PAY_SUBSCRIPTION: 'PAY_SUBSCRIPTION',
  CONTACT_SUPPORT: 'CONTACT_SUPPORT',
  NONE: 'NONE',
};

const IN_REVIEW = [TenantStatus.PENDING_REVIEW, TenantStatus.UNDER_REVIEW, TenantStatus.APPROVED];
const CLOSED = [TenantStatus.PENDING_DELETION, TenantStatus.DELETED];

const planOf = (sub) => {
  const branchCount = sub.branchCount != null ? sub.branchCount : sub.package?.maxBranches ?? null;
  const tier = tierForBranchCount(branchCount);
  if (!tier) return null;
  return {
    tierKey: tier.key,
    tierName: tier.name,
    branchCount: Number(branchCount),
    billingCycle: sub.billingCycle || null,
    platform: sub.platform || null,
  };
};

/**
 * Pure: the status for one tenant and its entitling subscription (or none).
 * `entitledSub` is subscription-quota.service#getActiveSubscription's row.
 */
const deriveHostStatus = ({ tenant, entitledSub = null }) => {
  if (!tenant) {
    return {
      status: HostStatus.NONE,
      nextAction: NextAction.BECOME_HOST,
      tenantId: null,
      gymName: null,
      applicationSubmitted: false,
      listingComplete: false,
      payment: { done: false, entitled: false, method: null },
      plan: null,
      verification: { status: KycStatus.NOT_SUBMITTED, verified: false },
      rejectionReason: null,
    };
  }

  const plans = mainBranchPlans(tenant);
  const listingComplete = Array.isArray(plans) && plans.length > 0;
  const entitled = !!entitledSub;
  const paid = entitled && entitledSub.paymentStatus === 'PAID';
  const submitted = tenant.status !== TenantStatus.DRAFT;

  let status;
  let nextAction;
  if (CLOSED.includes(tenant.status)) {
    status = HostStatus.CLOSED;
    nextAction = NextAction.NONE;
  } else if (tenant.status === TenantStatus.SUSPENDED) {
    status = HostStatus.SUSPENDED;
    nextAction = NextAction.CONTACT_SUPPORT;
  } else if (tenant.status === TenantStatus.REJECTED) {
    status = HostStatus.REJECTED;
    nextAction = NextAction.FIX_AND_RESUBMIT;
  } else if (IN_REVIEW.includes(tenant.status)) {
    // APPROVED is the short window between the admin's approval and the end of
    // provisioning (or a provisioning that must be resumed): not live yet.
    status = HostStatus.PENDING_REVIEW;
    nextAction = NextAction.WAIT_FOR_REVIEW;
  } else if (tenant.status === TenantStatus.ACTIVE) {
    status = HostStatus.APPROVED;
    nextAction = paid ? NextAction.NONE : entitled ? NextAction.PAY_SUBSCRIPTION : NextAction.CHOOSE_PLAN;
  } else if (!listingComplete) {
    status = HostStatus.DRAFT;
    nextAction = NextAction.COMPLETE_LISTING;
  } else if (!paid) {
    status = HostStatus.AWAITING_PAYMENT;
    nextAction = NextAction.CHOOSE_PLAN;
  } else {
    // Paid in the store, but /tenants/:id/finalize did not go through.
    status = HostStatus.DRAFT;
    nextAction = NextAction.SUBMIT_APPLICATION;
  }

  return {
    status,
    nextAction,
    tenantId: tenant.id,
    gymName: tenant.gymName || tenant.businessName || null,
    applicationSubmitted: submitted && status !== HostStatus.REJECTED,
    listingComplete,
    payment: { done: paid, entitled, method: tenant.paymentMethod || null },
    plan: paid ? planOf(entitledSub) : null,
    verification: {
      status: tenant.kycStatus || KycStatus.NOT_SUBMITTED,
      verified: tenant.kycStatus === KycStatus.APPROVED,
    },
    rejectionReason: status === HostStatus.REJECTED ? tenant.rejectionReason || null : null,
  };
};

const TENANT_ATTRIBUTES = [
  'id', 'gymName', 'businessName', 'status', 'kycStatus', 'mainBranchDataJson', 'paymentMethod', 'rejectionReason',
];

/** The tenant the user owns (one per owner, registerTenant), or null. */
const findOwnedTenant = (userId) =>
  Tenant.findOne({ where: { ownerUserId: userId }, attributes: TENANT_ATTRIBUTES, order: [['createdAt', 'DESC']] });

/** The caller's host status. Two indexed reads; no tenant database is opened. */
const getHostStatus = async (userId) => {
  const tenant = userId ? await findOwnedTenant(userId) : null;
  const entitledSub = tenant ? await subscriptionQuotaService.getActiveSubscription(tenant.id) : null;
  return deriveHostStatus({ tenant, entitledSub });
};

module.exports = { HostStatus, NextAction, deriveHostStatus, getHostStatus };
