const subscriptionService = require('../services/subscription.service');
const { sendSuccess, parsePagination, createError } = require('../utils/response.utils');
const { hasBranchAccess, resolveBranchScope } = require('../utils/branchAccess.utils');
const refundService = require('../services/subscription-refund.service');
const { refundPaymentInTransaction } = require('../services/commands/payment.commands');

// ── POST /subscriptions ───────────────────────────────────────────────────────
const subscribe = async (req, res, next) => {
  try {
    const result = await subscriptionService.subscribe(req.user.id, req.body);
    return sendSuccess(res, result, 'Subscription created successfully', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /subscriptions/quote ──────────────────────────────────────────────────
const quote = async (req, res, next) => {
  try {
    const { planId, gymListingId, branchId } = req.query;
    const result = await subscriptionService.quoteFirstPayment(req.user.id, { planId, gymListingId, branchId });
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── GET /me/subscriptions ─────────────────────────────────────────────────────
const listMySubscriptions = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 10, 50);
    const { status } = req.query;

    const result = await subscriptionService.listMySubscriptions(req.user.id, {
      status: status || null,
      page,
      limit,
      offset,
    });

    return sendSuccess(
      res,
      { memberships: result.memberships },
      'OK',
      200,
      result.pagination
    );
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/:id/freeze ────────────────────────────────────────────
const freeze = async (req, res, next) => {
  try {
    const subscription = await subscriptionService.freeze(
      req.user.id,
      req.params.id,
      req.body
    );
    return sendSuccess(res, { subscription }, 'Subscription frozen');
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/:id/cancel ────────────────────────────────────────────
const cancel = async (req, res, next) => {
  try {
    const subscription = await subscriptionService.cancel(req.user.id, req.params.id);
    return sendSuccess(res, { subscription }, 'Subscription cancelled');
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/:id/renew ─────────────────────────────────────────────
const renew = async (req, res, next) => {
  try {
    const result = await subscriptionService.renew(
      req.user.id,
      req.params.id,
      req.body.planId,
      req.body.startDate
    );
    return sendSuccess(res, result, 'Renewal requested — it starts once the payment is verified');
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/:id/change-plan ───────────────────────────────────────
const changePlan = async (req, res, next) => {
  try {
    const result = await subscriptionService.changePlan(req.user.id, req.params.id, req.body.planId);
    return sendSuccess(res, result, 'Plan change registered');
  } catch (err) {
    next(err);
  }
};

// ── GET /subscriptions — staff list all ───────────────────────────────────────
const listForStaff = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { status, branchId, userId } = req.query;
    const scope = await resolveBranchScope(req, branchId, 'subscriptions.view', 'subscriptions');

    const result = await subscriptionService.listForStaff(req.tenantDb, {
      status: status || null,
      branchId: scope.branchId,
      branchIds: scope.branchIds,
      userId: userId || null,
      page,
      limit,
      offset,
    });

    return sendSuccess(
      res,
      { subscriptions: result.subscriptions },
      'OK',
      200,
      result.pagination
    );
  } catch (err) {
    next(err);
  }
};

// ── GET /subscriptions/:id — staff detail ─────────────────────────────────────
const getForStaff = async (req, res, next) => {
  try {
    const result = await subscriptionService.getForStaff(req.tenantDb, req.params.id);
    if (result.subscription?.branchId && !(await hasBranchAccess(req, result.subscription.branchId, 'subscriptions.view'))) {
      throw createError('Subscription not found', 404);
    }
    return sendSuccess(res, result, 'Subscription retrieved');
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/preview — dry-run calculation ─────────────────────────
const preview = async (req, res, next) => {
  try {
    const result = await subscriptionService.previewSubscription(req.tenantDb, { branchId: req.branchId, ...req.body });
    return sendSuccess(res, result, 'Preview calculated');
  } catch (err) {
    next(err);
  }
};

// ── GET /subscriptions/:id/detail — member gets full detail (invoice + payment) ─
const getMySubscriptionDetail = async (req, res, next) => {
  try {
    const result = await subscriptionService.getMySubscriptionDetail(req.user.id, req.params.id);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── GET /subscriptions/:id/qr-token ───────────────────────────────────────────
const getSubscriptionQrToken = async (req, res, next) => {
  try {
    const result = await subscriptionService.getSubscriptionQrToken(req.user.id, req.params.id);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/:id/proof — member uploads payment proof ───────────────
const uploadSubscriptionProof = async (req, res, next) => {
  try {
    if (!req.file) {
      const err = new Error('Proof image file is required');
      err.statusCode = 422;
      return next(err);
    }
    const payment = await subscriptionService.uploadSubscriptionProof(req.user.id, req.params.id, req.file);
    return sendSuccess(res, { payment }, 'Proof uploaded successfully');
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/staff/:id/activate — staff activates without payment ───
const activateSubscription = async (req, res, next) => {
  try {
    const { MemberSubscription } = req.tenantDb.models;
    const existing = await MemberSubscription.findByPk(req.params.id, { attributes: ['id', 'branchId'] });
    if (!existing) throw createError('Subscription not found', 404);
    if (existing.branchId && !(await hasBranchAccess(req, existing.branchId, 'subscriptions.activate') || await hasBranchAccess(req, existing.branchId, 'subscriptions.view'))) {
      throw createError('Subscription not found', 404);
    }
    const subscription = await subscriptionService.activateSubscription(req.tenantDb, req.params.id);
    return sendSuccess(res, { subscription }, 'Subscription activated');
  } catch (err) {
    next(err);
  }
};

// ── GET /member/branches/:branchId/subscription-status ────────────────────────
const getMemberBranchSubscriptionStatus = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const result = await subscriptionService.getMemberBranchSubscriptionStatus(
      req.tenantDb,
      userId,
      req.params.branchId
    );
    return sendSuccess(res, result, 'Subscription status retrieved');
  } catch (err) {
    next(err);
  }
};

// ── GET /member/subscriptions/:id/upgrade-options ────────────────────────────
const getUpgradeOptions = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const result = await subscriptionService.getUpgradeOptions(userId, req.params.id);
    return sendSuccess(res, result, 'Upgrade options retrieved');
  } catch (err) {
    next(err);
  }
};

// ── POST /member/subscriptions/:id/upgrade ───────────────────────────────────
const upgradeSubscription = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const result = await subscriptionService.upgradeSubscription(userId, req.params.id, req.body.newPlanId);
    return sendSuccess(res, result, 'Upgrade requested — the new plan starts once the payment is verified');
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/staff ─────────────────────────────────────────────────
const createStaffSubscription = async (req, res, next) => {
  try {
    const { userId, planId, branchId, startDate, notes, paymentMethod } = req.body;
    const { User } = require('../models/platform');
    const gymService = require('../services/gym.service');
    const { createError } = require('../utils/response.utils');

    const user = await User.findByPk(userId);
    if (!user) return next(createError('User not found', 404));

    const result = await gymService.enrollMember(
      req.tenantDb,
      req.tenantId || req.user.tenantId,
      {
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        planId,
        branchId,
        startDate,
        notes,
        paymentMethod,
      },
      req.user
    );
    return sendSuccess(res, result, 'Subscription created for member', 201);
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/staff/:id/freeze | /cancel (NEW-250) ─────────────────
// The subscription is read from the caller's own tenant (tenantContext), the grants are resolved at
// its branch, and the approval engine runs it now (DIRECT) or queues a request (REQUEST, 202).
const staffSubscriptionAction = (actionKey, doneMessage, bodyFields = []) => async (req, res, next) => {
  try {
    const { MemberSubscription } = req.tenantDb.models;
    const sub = await MemberSubscription.findByPk(req.params.id, { attributes: ['id', 'branchId', 'userId'] });
    if (!sub) throw createError('Subscription not found', 404);
    // A branch the caller cannot see answers like a wrong id.
    if (!(await hasBranchAccess(req, sub.branchId, 'subscriptions.view'))) {
      throw createError('Subscription not found', 404);
    }

    const accessService = require('../services/access.service');
    const approvalService = require('../services/approval.service');
    const { User } = require('../models/platform');
    const tenantId = req.tenantId || req.user?.tenantId;
    const userId = req.user.id || req.user.sub;
    const grants = await accessService.resolve(req.tenantDb, tenantId, userId, sub.branchId);
    const member = await User.findByPk(sub.userId, { attributes: ['fullName'] });

    const payload = { subscriptionId: sub.id, memberName: member?.fullName || null };
    for (const field of bodyFields) payload[field] = req.body[field];

    const outcome = await approvalService.perform(
      { tenantDb: req.tenantDb, tenantId, userId, branchId: sub.branchId, grants, roleKey: (grants.roleKeys || [])[0] || null, req },
      actionKey,
      payload,
      { idempotencyKey: req.headers['idempotency-key'] || null }
    );

    if (outcome.status === 'EXECUTED') {
      return sendSuccess(res, { status: 'EXECUTED', subscription: outcome.result }, doneMessage, 200);
    }
    return sendSuccess(
      res,
      { status: 'PENDING', requestId: outcome.request.id, summary: outcome.request.summary, duplicate: outcome.duplicate || false },
      'Sent for approval. You will be notified once it is decided.',
      202
    );
  } catch (err) {
    next(err);
  }
};

const staffFreeze = staffSubscriptionAction('subscriptions.pause', 'Subscription frozen', ['freezeFrom', 'freezeTo']);
const staffCancelPlain = staffSubscriptionAction('subscriptions.cancel', 'Subscription cancelled');

// ── NEW-253 (R-103): refunds on cancellation ──────────────────────────────────

/** Staff: the subscription row, its branch checked like the other staff routes, and grants there. */
const _staffSubscriptionContext = async (req) => {
  const { MemberSubscription } = req.tenantDb.models;
  const sub = await MemberSubscription.findByPk(req.params.id);
  if (!sub) throw createError('Subscription not found', 404);
  if (!(await hasBranchAccess(req, sub.branchId, 'subscriptions.view'))) throw createError('Subscription not found', 404);
  const accessService = require('../services/access.service');
  const tenantId = req.tenantId || req.user?.tenantId;
  const userId = req.user.id || req.user.sub;
  const grants = await accessService.resolve(req.tenantDb, tenantId, userId, sub.branchId);
  const ctx = { tenantDb: req.tenantDb, tenantId, userId, branchId: sub.branchId, grants, roleKey: (grants.roleKeys || [])[0] || null, req };
  return { sub, ctx, grants };
};

// ── GET /subscriptions/staff/:id/refund-quote ─────────────────────────────────
// What the cancel dialog may offer: the policy, the suggested (prorated) amount, the maximum, and
// whether this caller refunds directly, through approval, or not at all.
const staffRefundQuote = async (req, res, next) => {
  try {
    const { sub, grants } = await _staffSubscriptionContext(req);
    const q = await refundService.quote(req.tenantDb, sub);
    return sendSuccess(res, { ...q, refundTier: grants.tierFor('payments.refund') });
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/staff/:id/cancel with { refund: true } ───────────────
// Owner / Org admin (payments.refund DIRECT): cancel and refund in one transaction (sub row lock, then
// the payment row lock in the PAY-07 refund). Manager (REQUEST): cancel now, the refund is an approval
// request. Refund OFF, or a cancel that itself needs approval: 403, nothing changes.
const staffCancelWithRefund = async (req, res, next) => {
  try {
    const { sub, ctx, grants } = await _staffSubscriptionContext(req);
    const cancelTier = grants.tierFor('subscriptions.cancel');
    const refundTier = grants.tierFor('payments.refund');
    if (cancelTier === 'OFF') throw createError('You do not have permission to cancel a subscription here', 403);
    if (refundTier === 'OFF') {
      const err = createError('You do not have permission to issue a refund here', 403);
      err.code = 'refund_not_permitted';
      throw err;
    }
    if (cancelTier !== 'DIRECT') {
      const err = createError('This cancel needs approval, so it cannot carry a refund. Ask a manager.', 403);
      err.code = 'cancel_needs_approval';
      throw err;
    }
    subscriptionService.assertCancellable(sub);
    const q = await refundService.quote(req.tenantDb, sub);
    refundService.assertEligible(q);
    const amount = refundService.pickAmount(q, req.body.refundAmount);
    const reason = req.body.refundReason ? String(req.body.refundReason).slice(0, 500) : 'Refund on cancellation';
    const refundPayload = { paymentId: q.paymentId, amount, reason, subscriptionId: sub.id };
    const auditService = require('../services/audit.service');
    const approvalService = require('../services/approval.service');

    if (refundTier === 'DIRECT') {
      let refund = null;
      const subscription = await subscriptionService.staffCancel(req.tenantDb, sub.id, {
        withinTransaction: async (tx) => {
          refund = await refundPaymentInTransaction({ ...ctx, requestedBy: ctx.userId }, refundPayload, tx);
        },
      });
      await auditService.record(ctx, { action: 'subscriptions.cancel', targetType: 'command', targetId: sub.id, after: { payload: { subscriptionId: sub.id }, via: 'DIRECT' } });
      await auditService.record(ctx, { action: 'payments.refund', targetType: 'command', targetId: q.paymentId, after: { payload: refundPayload, via: 'DIRECT' } });
      return sendSuccess(res, { status: 'EXECUTED', subscription, refund: { ...refund, paymentStatus: refund.status, status: 'EXECUTED' } }, 'Subscription cancelled and payment refunded', 200);
    }

    // REQUEST: cancel now (DIRECT, checked above), refund to the approval inbox.
    const key = req.headers['idempotency-key'] || null;
    const cancelled = await approvalService.perform(ctx, 'subscriptions.cancel', { subscriptionId: sub.id, memberName: null }, { idempotencyKey: key });
    const pending = await approvalService.perform(ctx, 'payments.refund', refundPayload, { idempotencyKey: key ? `${key}:refund` : null });
    return sendSuccess(
      res,
      { status: 'EXECUTED', subscription: cancelled.result, refund: { status: 'PENDING', requestId: pending.request.id, summary: pending.request.summary } },
      'Subscription cancelled. The refund was sent for approval.',
      200
    );
  } catch (err) {
    next(err);
  }
};

// ── Member: GET / POST /subscriptions/:id/refund-request ──────────────────────
const _memberRefundContext = async (req) => {
  const { tenantDb, tenantId, resolvedSubscriptionId } = await subscriptionService.resolveOwnSubscription(req.params.id, req.user.id);
  const sub = await tenantDb.models.MemberSubscription.findByPk(resolvedSubscriptionId);
  if (!sub) throw createError('Subscription not found', 404);
  return { sub, ctx: { tenantDb, tenantId, userId: req.user.id, branchId: sub.branchId, roleKey: 'MEMBER', req } };
};

const myRefundStatus = async (req, res, next) => {
  try {
    const { sub, ctx } = await _memberRefundContext(req);
    return sendSuccess(res, await refundService.memberStatus(ctx.tenantDb, sub));
  } catch (err) {
    next(err);
  }
};

const requestMyRefund = async (req, res, next) => {
  try {
    const { sub, ctx } = await _memberRefundContext(req);
    const { request, duplicate } = await refundService.requestRefund(ctx, sub, { reason: req.body.reason });
    return sendSuccess(res, { request: refundService.serializeRequest(request), duplicate }, duplicate ? 'Refund already asked for' : 'Refund requested. The gym will review it.', duplicate ? 200 : 201);
  } catch (err) {
    next(err);
  }
};

// ── Staff: GET /subscriptions/staff/refund-requests, POST …/:requestId/decide ─
const listRefundRequests = async (req, res, next) => {
  try {
    const { branchId, branchIds } = await resolveBranchScope(req, req.query.branchId || null, 'subscriptions.view', 'refund requests');
    const rows = await refundService.listRequests(req.tenantDb, {
      branchIds: branchId ? [branchId] : branchIds,
      status: req.query.status || null,
    });
    return sendSuccess(res, { requests: rows });
  } catch (err) {
    next(err);
  }
};

const decideRefundRequest = async (req, res, next) => {
  try {
    const row = await req.tenantDb.models.RefundRequest.findByPk(req.params.requestId);
    if (!row || !(await hasBranchAccess(req, row.branchId, 'subscriptions.view'))) throw createError('Refund request not found', 404);
    const accessService = require('../services/access.service');
    const tenantId = req.tenantId || req.user?.tenantId;
    const userId = req.user.id || req.user.sub;
    const grants = await accessService.resolve(req.tenantDb, tenantId, userId, row.branchId);
    if (grants.tierFor('payments.refund') !== 'DIRECT') {
      const err = createError('Only someone who can issue refunds directly can decide a refund request', 403);
      err.code = 'refund_not_permitted';
      throw err;
    }
    const ctx = { tenantDb: req.tenantDb, tenantId, userId, branchId: row.branchId, grants, roleKey: (grants.roleKeys || [])[0] || null, req };
    const { request, refund } = await refundService.decide(ctx, row.id, {
      decision: req.body.decision, amount: req.body.amount, reason: req.body.reason,
    });
    return sendSuccess(res, { request: refundService.serializeRequest(request), refund }, request.status === 'APPROVED' ? 'Refund approved' : 'Refund request rejected');
  } catch (err) {
    next(err);
  }
};

// ── Host: GET / PUT /subscriptions/staff/refund-policy ────────────────────────
// Per gym (the branch's gym; ?branchId= picks it, else the tenant's first gym). Changing it needs a
// direct payments.refund at that branch (Owner / Org admin by default).
const getRefundPolicy = async (req, res, next) => {
  try {
    const p = await refundService.policyFor(req.tenantDb, req.query.branchId || null);
    return sendSuccess(res, { gymId: p.gymId, refundsAllowed: p.refundsAllowed, refundWindowDays: p.refundWindowDays });
  } catch (err) {
    next(err);
  }
};

const updateRefundPolicy = async (req, res, next) => {
  try {
    const branchId = req.body.branchId || null;
    if (branchId && !(await hasBranchAccess(req, branchId, 'subscriptions.view'))) throw createError('Branch not found', 404);
    const accessService = require('../services/access.service');
    const tenantId = req.tenantId || req.user?.tenantId;
    const userId = req.user.id || req.user.sub;
    const grants = await accessService.resolve(req.tenantDb, tenantId, userId, branchId);
    if (grants.tierFor('payments.refund') !== 'DIRECT') {
      const err = createError('Only someone who can issue refunds directly can change the refund policy', 403);
      err.code = 'refund_not_permitted';
      throw err;
    }
    const ctx = { tenantDb: req.tenantDb, tenantId, userId, branchId, grants, roleKey: (grants.roleKeys || [])[0] || null, req };
    const policy = await refundService.updatePolicy(ctx, branchId, {
      refundsAllowed: req.body.refundsAllowed,
      refundWindowDays: req.body.refundWindowDays,
    });
    return sendSuccess(res, policy, 'Refund policy saved');
  } catch (err) {
    next(err);
  }
};

/** POST /subscriptions/staff/:id/cancel: `refund: true` cancels with a refund (NEW-253); otherwise as before. */
const staffCancel = (req, res, next) =>
  (req.body && req.body.refund === true ? staffCancelWithRefund : staffCancelPlain)(req, res, next);

module.exports = {
  staffFreeze, staffCancel,
  staffRefundQuote, myRefundStatus, requestMyRefund, listRefundRequests, decideRefundRequest, getRefundPolicy, updateRefundPolicy,
  subscribe, quote, listMySubscriptions, freeze, cancel, renew, changePlan,
  listForStaff, getForStaff, preview, createStaffSubscription,
  getMySubscriptionDetail, uploadSubscriptionProof, activateSubscription,
  getMemberBranchSubscriptionStatus, getUpgradeOptions, upgradeSubscription,
  getSubscriptionQrToken,
};
