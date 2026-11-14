/**
 * NEW-253 (R-103): refunds on subscription cancellation.
 *
 *  - Policy per gym (`gyms.refunds_allowed`, `gyms.refund_window_days`, tenant migration 028). Off by default.
 *  - What can be refunded: the subscription's latest COMPLETED membership payment, up to its remaining
 *    refundable balance (PAY-07). Suggested amount: prorated by the unused days of the current period.
 *  - Staff cancel with refund: cancel + refund in one transaction when the caller refunds directly
 *    (`payments.refund` DIRECT); a Manager (REQUEST) cancels now and the refund goes to approval.
 *  - Member: cancels first, then asks (`refund_requests`, one per subscription); a DIRECT `payments.refund`
 *    holder approves (the refund, in one transaction with the decision) or rejects.
 *
 * The money itself is PAY-07: `refundPaymentInTransaction` (payment row lock, remaining balance in minor
 * units, REVERSAL ledger adjustment). Nothing here calls a payment gateway (R-103 item 3).
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { createError } = require('../utils/response.utils');
const { PaymentStatus } = require('../constants/payment-status');
const { SubscriptionStatus } = require('../constants/subscription-status');
const { toMinorUnits, fromMinorUnits } = require('../utils/money.utils');
const { computeBusinessDate } = require('./ledger.service');
const { refundPaymentInTransaction, remainingRefundableMinorOf } = require('./commands/payment.commands');
const auditService = require('./audit.service');

const DAY_MS = 86400000;

const coded = (message, status, code) => {
  const err = createError(message, status);
  err.code = code;
  return err;
};

const REASONS = {
  refunds_disabled: 'This gym does not give refunds',
  no_refundable_payment: 'There is no completed payment on this subscription to refund',
  already_refunded: 'The payment on this subscription has already been refunded',
  refund_window_closed: 'The refund period for this payment has ended',
  not_cancelled: 'Cancel the subscription first, then ask for a refund',
};

/** The refund policy of the gym the branch belongs to (the tenant's first gym when the branch has none). */
const policyFor = async (tenantDb, branchId) => {
  const { Gym, Branch } = tenantDb.models;
  const branch = branchId ? await Branch.findByPk(branchId, { attributes: ['id', 'gymId', 'timezone'] }) : null;
  let gym = branch && branch.gymId ? await Gym.findByPk(branch.gymId) : null;
  if (!gym) gym = await Gym.findOne({ order: [['createdAt', 'ASC']] });
  return {
    gymId: gym ? gym.id : null,
    refundsAllowed: Boolean(gym && gym.refundsAllowed),
    refundWindowDays: gym && gym.refundWindowDays != null ? Number(gym.refundWindowDays) : null,
    timezone: (branch && branch.timezone) || 'Asia/Karachi',
  };
};

/** Change the policy of the branch's gym. Audited (before / after). */
const updatePolicy = async (ctx, branchId, { refundsAllowed, refundWindowDays }) => {
  const { Gym } = ctx.tenantDb.models;
  const current = await policyFor(ctx.tenantDb, branchId);
  if (!current.gymId) throw createError('Gym not found', 404);
  const changes = {};
  if (refundsAllowed !== undefined) {
    if (typeof refundsAllowed !== 'boolean') throw coded('refundsAllowed must be true or false', 422, 'invalid_refund_policy');
    changes.refundsAllowed = refundsAllowed;
  }
  if (refundWindowDays !== undefined) {
    const ok = refundWindowDays === null || (Number.isInteger(refundWindowDays) && refundWindowDays >= 1 && refundWindowDays <= 3650);
    if (!ok) throw coded('refundWindowDays must be empty (no limit) or a whole number of days from 1 to 3650', 422, 'invalid_refund_policy');
    changes.refundWindowDays = refundWindowDays;
  }
  await Gym.update(changes, { where: { id: current.gymId } });
  const next = await policyFor(ctx.tenantDb, branchId);
  await auditService.record(ctx, {
    action: 'refunds.policy.update',
    targetType: 'gym',
    targetId: current.gymId,
    before: { refundsAllowed: current.refundsAllowed, refundWindowDays: current.refundWindowDays },
    after: { refundsAllowed: next.refundsAllowed, refundWindowDays: next.refundWindowDays },
  });
  return { gymId: next.gymId, refundsAllowed: next.refundsAllowed, refundWindowDays: next.refundWindowDays };
};

const _days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * What a refund of this subscription would be. Read-only; `eligible` false comes with `reasonCode`.
 * `now` is injectable for tests.
 */
const quote = async (tenantDb, sub, { now = new Date(), transaction = null } = {}) => {
  const { Payment, LedgerAdjustment } = tenantDb.models;
  const policy = await policyFor(tenantDb, sub.branchId);
  const base = {
    subscriptionId: sub.id,
    refundsAllowed: policy.refundsAllowed,
    refundWindowDays: policy.refundWindowDays,
    eligible: false,
    reasonCode: null,
    reason: null,
  };
  const refuse = (code, extra = {}) => ({ ...base, ...extra, reasonCode: code, reason: REASONS[code] });

  if (!policy.refundsAllowed) return refuse('refunds_disabled');

  const payment = await Payment.findOne({
    where: { referenceEntityId: sub.id, paymentFor: 'MEMBERSHIP', status: { [Op.in]: [PaymentStatus.COMPLETED, PaymentStatus.REFUNDED] } },
    order: [['paidAt', 'DESC'], ['createdAt', 'DESC']],
    transaction,
  });
  if (!payment) return refuse('no_refundable_payment');

  const amountMinor = toMinorUnits(payment.amount);
  const remainingMinor = payment.status === PaymentStatus.REFUNDED ? 0 : await remainingRefundableMinorOf(LedgerAdjustment, payment, transaction);
  const paymentInfo = {
    paymentId: payment.id,
    method: payment.method,
    currency: payment.currency,
    paidAt: payment.paidAt,
    paymentAmount: fromMinorUnits(amountMinor),
    remainingRefundable: fromMinorUnits(remainingMinor),
  };
  if (remainingMinor <= 0) return refuse('already_refunded', paymentInfo);

  const paidAt = payment.paidAt || payment.createdAt;
  const windowEndsAt = policy.refundWindowDays != null ? new Date(new Date(paidAt).getTime() + policy.refundWindowDays * DAY_MS) : null;
  if (windowEndsAt && now > windowEndsAt) return refuse('refund_window_closed', { ...paymentInfo, windowEndsAt });

  // Prorated: the unused days of the current period [startDate, endDate) from the cancel day (today when
  // not cancelled yet), in the branch's own calendar.
  const cancelDay = computeBusinessDate(sub.cancelledAt || now, policy.timezone);
  const periodDays = Math.max(1, _days(sub.startDate, sub.endDate));
  const fromDay = cancelDay > sub.startDate ? cancelDay : sub.startDate;
  const unusedDays = Math.min(periodDays, Math.max(0, _days(fromDay, sub.endDate)));
  const suggestedMinor = Math.min(remainingMinor, Math.floor((amountMinor * unusedDays) / periodDays));

  return {
    ...base,
    ...paymentInfo,
    eligible: true,
    windowEndsAt,
    periodDays,
    unusedDays,
    suggestedAmount: fromMinorUnits(suggestedMinor),
  };
};

const assertEligible = (q) => {
  if (!q.eligible) throw coded(q.reason, 422, q.reasonCode);
};

/** The amount to refund: the given one (validated in minor units) or the suggestion. */
const pickAmount = (q, amount) => {
  if (amount === undefined || amount === null || amount === '') return q.suggestedAmount;
  const minor = toMinorUnits(amount);
  if (!Number.isFinite(minor) || minor <= 0) throw coded('Refund amount must be greater than zero', 422, 'invalid_refund_amount');
  if (minor > toMinorUnits(q.remainingRefundable)) {
    throw coded(`Refund amount exceeds the refundable balance of ${q.remainingRefundable}`, 422, 'refund_exceeds_refundable');
  }
  return fromMinorUnits(minor);
};

// ── Member request ────────────────────────────────────────────────────────────

const serializeRequest = (r) => (r ? {
  id: r.id,
  subscriptionId: r.subscriptionId,
  paymentId: r.paymentId,
  userId: r.userId,
  branchId: r.branchId,
  status: r.status,
  currency: r.currency,
  suggestedAmount: r.suggestedAmount,
  approvedAmount: r.approvedAmount,
  reason: r.reason,
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt,
  decisionReason: r.decisionReason,
  ledgerAdjustmentId: r.ledgerAdjustmentId,
  createdAt: r.createdAt,
} : null);

/** What the member's screen shows: may they ask, and the request if there is one. */
const memberStatus = async (tenantDb, sub) => {
  const { RefundRequest } = tenantDb.models;
  const request = await RefundRequest.findOne({ where: { subscriptionId: sub.id } });
  const q = await quote(tenantDb, sub);
  let canRequest = q.eligible && !request && sub.status === SubscriptionStatus.CANCELLED;
  let reasonCode = q.reasonCode;
  if (q.eligible && sub.status !== SubscriptionStatus.CANCELLED) { canRequest = false; reasonCode = 'not_cancelled'; }
  if (request) reasonCode = 'already_requested';
  return {
    refundsAllowed: q.refundsAllowed,
    canRequest,
    reasonCode: canRequest ? null : reasonCode,
    suggestedAmount: q.eligible ? q.suggestedAmount : null,
    currency: q.currency || null,
    windowEndsAt: q.windowEndsAt || null,
    request: serializeRequest(request),
  };
};

const notifyDeciders = async (ctx, request, summary) => {
  const approvalService = require('./approval.service');
  const policy = await approvalService.policyFor(ctx.tenantDb, request.branchId, 'payments.refund');
  await approvalService.notifyApprovers(ctx, {
    id: request.id, branchId: request.branchId, actionKey: 'payments.refund', summary, requestedBy: request.userId,
  }, policy).catch(() => {});
};

/**
 * The member asks for a refund of their cancelled subscription. One request per subscription: a repeat
 * by the same member while it is pending answers the same request (`duplicate: true`).
 */
const requestRefund = async (ctx, sub, { reason = null } = {}) => {
  const { RefundRequest } = ctx.tenantDb.models;
  const existing = await RefundRequest.findOne({ where: { subscriptionId: sub.id } });
  if (existing) {
    if (existing.status === 'PENDING') return { request: existing, duplicate: true };
    throw coded('A refund was already asked for on this subscription', 409, 'refund_already_requested');
  }
  if (sub.status !== SubscriptionStatus.CANCELLED) throw coded(REASONS.not_cancelled, 409, 'not_cancelled');
  const q = await quote(ctx.tenantDb, sub);
  assertEligible(q);

  let request;
  try {
    request = await RefundRequest.create({
      subscriptionId: sub.id,
      paymentId: q.paymentId,
      userId: sub.userId,
      branchId: sub.branchId,
      status: 'PENDING',
      currency: q.currency,
      suggestedAmount: q.suggestedAmount,
      reason: reason ? String(reason).slice(0, 500) : null,
    });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    // Two taps at once: the unique subscription_id kept one row; answer it.
    const winner = await RefundRequest.findOne({ where: { subscriptionId: sub.id } });
    return { request: winner, duplicate: true };
  }

  await auditService.record({ ...ctx, branchId: sub.branchId }, {
    action: 'refunds.request.create',
    targetType: 'refund_request',
    targetId: request.id,
    after: { subscriptionId: sub.id, paymentId: q.paymentId, suggestedAmount: q.suggestedAmount, currency: q.currency, reason: request.reason },
  });
  await notifyDeciders(ctx, request, `Member refund request: ${q.currency} ${q.suggestedAmount}`);
  return { request, duplicate: false };
};

// ── Staff: decide a member request ─────────────────────────────────────────────

const notifyMember = async (request, outcome, reason) => {
  const notificationsService = require('./notifications.service');
  await notificationsService.createNotification({
    userId: request.userId,
    role: 'traveler',
    type: `refund_${outcome}`,
    title: outcome === 'approved' ? 'Refund approved' : 'Refund declined',
    message: outcome === 'approved'
      ? `Your refund of ${request.currency} ${request.approvedAmount} was approved. The gym will return the money to you.`
      : `Your refund request was declined.${reason ? ` Reason: ${reason}` : ''}`,
    data: { refundRequestId: request.id, subscriptionId: request.subscriptionId },
  }).catch(() => {});
};

/**
 * Approve (the refund, in the same transaction as the decision, under a lock on the request row) or
 * reject. The caller must refund directly (`payments.refund` DIRECT, R-103 item 4); checked by the caller.
 */
const decide = async (ctx, requestId, { decision, amount = null, reason = null }) => {
  const { RefundRequest, MemberSubscription } = ctx.tenantDb.models;
  if (!['APPROVE', 'REJECT'].includes(decision)) throw coded('decision must be APPROVE or REJECT', 422, 'invalid_decision');

  let refund = null;
  const request = await ctx.tenantDb.sequelize.transaction(async (tx) => {
    const row = await RefundRequest.findByPk(requestId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!row) throw createError('Refund request not found', 404);
    if (row.status !== 'PENDING') throw coded(`This refund request was already ${row.status.toLowerCase()}`, 409, 'refund_request_decided');

    const decided = { decidedBy: ctx.userId, decidedAt: new Date(), decisionReason: reason ? String(reason).slice(0, 500) : null };
    if (decision === 'REJECT') {
      await row.update({ status: 'REJECTED', ...decided }, { transaction: tx });
      return row;
    }

    // The window was met when the member asked; the policy must still be on (the owner may close refunds).
    const policy = await policyFor(ctx.tenantDb, row.branchId);
    if (!policy.refundsAllowed) throw coded(REASONS.refunds_disabled, 422, 'refunds_disabled');
    const sub = await MemberSubscription.findByPk(row.subscriptionId, { transaction: tx });
    if (!sub) throw createError('Subscription not found', 404);

    const refundAmount = amount === null || amount === undefined || amount === '' ? row.suggestedAmount : amount;
    if (toMinorUnits(refundAmount) <= 0) throw coded('Refund amount must be greater than zero', 422, 'invalid_refund_amount');
    refund = await refundPaymentInTransaction(ctx, {
      paymentId: row.paymentId,
      amount: refundAmount,
      reason: `Member refund request${row.reason ? `: ${row.reason}` : ''}`,
    }, tx);
    await row.update({
      status: 'APPROVED', approvedAmount: refund.refundedAmount, ledgerAdjustmentId: refund.adjustmentId, ...decided,
    }, { transaction: tx });
    return row;
  });

  await auditService.record({ ...ctx, branchId: request.branchId }, {
    action: decision === 'APPROVE' ? 'refunds.request.approve' : 'refunds.request.reject',
    targetType: 'refund_request',
    targetId: request.id,
    after: { status: request.status, paymentId: request.paymentId, amount: request.approvedAmount, reason: request.decisionReason },
  });
  if (refund) {
    await auditService.record({ ...ctx, branchId: request.branchId }, {
      action: 'payments.refund',
      targetType: 'payment',
      targetId: request.paymentId,
      after: { payload: { paymentId: request.paymentId, amount: refund.refundedAmount, refundRequestId: request.id }, via: 'REFUND_REQUEST' },
    });
  }
  await notifyMember(request, decision === 'APPROVE' ? 'approved' : 'rejected', request.decisionReason);
  return { request, refund };
};

const listRequests = async (tenantDb, { branchIds = null, status = null } = {}) => {
  const { RefundRequest } = tenantDb.models;
  const where = {};
  if (Array.isArray(branchIds)) where.branchId = { [Op.in]: branchIds };
  if (status) where.status = status;
  const rows = await RefundRequest.findAll({ where, order: [['createdAt', 'DESC']], limit: 200 });
  return rows.map(serializeRequest);
};

module.exports = {
  REASONS, policyFor, updatePolicy, quote, assertEligible, pickAmount, memberStatus, requestRefund, decide, listRequests, serializeRequest,
};
