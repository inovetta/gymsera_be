/**
 * Approval service — the generalized request/decide engine.
 *
 * Your payment flow (staff collects cash → host verifies → package activates) is
 * one instance of a shape that recurs across member creation, expenses, refunds,
 * discounts and invoice voids. This builds it once.
 *
 * The entry point is `perform()`. A controller calls it instead of writing the row
 * itself, and the engine decides — from the caller's grants alone — whether to
 * execute now or queue a request. The controller contains no approval logic.
 *
 *   const result = await approvalService.perform(ctx, 'members.create', payload);
 *   if (result.status === 'PENDING') …  // tell the user it's awaiting approval
 */
const { Op } = require('sequelize');
const commands = require('./commands');
const auditService = require('./audit.service');
const accessService = require('./access.service');
const { createError } = require('../utils/response.utils');
const { getPermission, directKeyFor } = require('../constants/permissions');

/** Fallback policy when a tenant has configured none for an action. */
const DEFAULT_POLICY = {
  approverPermission: 'approvals.decide',
  minApproverLevel: 60,
  quorum: 1,
  slaHours: 24,
  escalateToLevel: 80,
  autoExpireHours: null,
};

/**
 * Who may decide this action, and how fast.
 *
 * Branch-specific policy wins over the org-wide default, which wins over the
 * built-in fallback.
 */
const policyFor = async (tenantDb, branchId, actionKey) => {
  const { ApprovalPolicy } = tenantDb.models;

  const rows = await ApprovalPolicy.findAll({
    where: {
      actionKey,
      [Op.or]: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])],
    },
  });

  const branchPolicy = rows.find((r) => r.branchId === branchId);
  const orgPolicy = rows.find((r) => r.branchId === null);
  const chosen = branchPolicy || orgPolicy;

  return chosen
    ? {
        approverPermission: chosen.approverPermission,
        minApproverLevel: chosen.minApproverLevel,
        quorum: chosen.quorum,
        slaHours: chosen.slaHours,
        escalateToLevel: chosen.escalateToLevel,
        autoExpireHours: chosen.autoExpireHours,
      }
    : { ...DEFAULT_POLICY };
};

/**
 * Perform an approvable action.
 *
 * @param {object} ctx
 * @param {object} ctx.tenantDb
 * @param {string} ctx.tenantId
 * @param {string} ctx.userId       the actor
 * @param {string} [ctx.branchId]
 * @param {import('./access.service').Grants} ctx.grants
 * @param {object} [ctx.req]        for audit IP / user agent
 * @param {string} actionKey        a permission key, e.g. 'members.create'
 * @param {object} payload          serializable command arguments
 * @param {object} [opts]
 * @param {string} [opts.idempotencyKey]
 * @returns {Promise<{status: 'EXECUTED'|'PENDING', result?: any, request?: object}>}
 */
const perform = async (ctx, actionKey, payload, opts = {}) => {
  const command = commands.getOrThrow(actionKey);
  const tier = ctx.grants.tierFor(actionKey);

  if (tier === 'OFF') {
    const perm = getPermission(actionKey);
    throw createError(
      `You do not have permission to ${perm ? perm.label.toLowerCase() : actionKey} here`,
      403
    );
  }

  // Validate before either path. A request that could never succeed should fail
  // at the desk, not sit in an approver's inbox for a day first.
  await command.validate(ctx, payload);

  // ── Direct path ───────────────────────────────────────────────────────────
  if (tier === 'DIRECT') {
    const result = await command.execute({ ...ctx, requestedBy: ctx.userId }, payload);
    await auditService.record(ctx, {
      action: actionKey,
      targetType: 'command',
      targetId: result && result.id ? result.id : null,
      after: { payload, via: 'DIRECT' },
    });
    return { status: 'EXECUTED', result };
  }

  // ── Request path ──────────────────────────────────────────────────────────
  const { ApprovalRequest } = ctx.tenantDb.models;

  // An idempotency key makes a retried submission safe — which an offline-capable
  // front desk replaying a queue depends on.
  if (opts.idempotencyKey) {
    const existing = await ApprovalRequest.findOne({ where: { idempotencyKey: opts.idempotencyKey } });
    if (existing) return { status: 'PENDING', request: existing, duplicate: true };
  }

  const policy = await policyFor(ctx.tenantDb, ctx.branchId, actionKey);
  const expiresAt = policy.autoExpireHours
    ? new Date(Date.now() + policy.autoExpireHours * 3600 * 1000)
    : null;

  const request = await ApprovalRequest.create({
    branchId: ctx.branchId || null,
    actionKey,
    payload,
    summary: command.summarize(payload) || null,
    requestedBy: ctx.userId,
    requestedByAssignmentId: (ctx.grants.assignmentIds || [])[0] || null,
    status: 'PENDING',
    idempotencyKey: opts.idempotencyKey || null,
    expiresAt,
  });

  await auditService.record(ctx, {
    action: `${actionKey}.requested`,
    targetType: 'approval_request',
    targetId: request.id,
    after: { payload, policy },
  });

  await notifyApprovers(ctx, request, policy).catch((err) =>
    console.warn('[Approvals] approver notification failed:', err.message)
  );

  return { status: 'PENDING', request };
};

/**
 * Decide a pending request.
 *
 * The status transition is a conditional UPDATE, not read-then-write. Two managers
 * tapping Approve at the same moment would otherwise both see PENDING and both
 * execute, activating the subscription twice.
 *
 * @param {object} ctx  as for perform(); ctx.userId is the approver
 * @param {string} requestId
 * @param {'APPROVE'|'REJECT'} decision
 * @param {string} [reason]
 */
const decide = async (ctx, requestId, decision, reason = null) => {
  const { ApprovalRequest } = ctx.tenantDb.models;

  const request = await ApprovalRequest.findByPk(requestId);
  if (!request) throw createError('Request not found', 404);
  if (request.status !== 'PENDING') {
    throw createError(`This request has already been ${request.status.toLowerCase()}`, 409);
  }

  // Re-resolve the approver's grants against the request's own branch. The
  // approver may hold different permissions there than in whatever branch context
  // the client happened to send.
  const approverGrants = await accessService.resolve(
    ctx.tenantDb,
    ctx.tenantId,
    ctx.userId,
    request.branchId
  );

  const policy = await policyFor(ctx.tenantDb, request.branchId, request.actionKey);

  if (!approverGrants.isOwner) {
    if (!approverGrants.has(policy.approverPermission)) {
      throw createError('You do not have permission to decide this request', 403);
    }
    if (approverGrants.level < policy.minApproverLevel) {
      throw createError('Your role is not senior enough to decide this request', 403);
    }
  }

  // Self-approval is a fraud path: request a Rs 50,000 expense, approve it
  // yourself. Owner may, and it is logged loudly.
  if (request.requestedBy === ctx.userId && !approverGrants.has('approvals.self_approve')) {
    throw createError('You cannot decide your own request', 403);
  }

  const decidedAt = new Date();
  const nextStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';

  // ── Race-safe claim ───────────────────────────────────────────────────────
  const [affected] = await ApprovalRequest.update(
    { status: nextStatus, decidedBy: ctx.userId, decidedAt, decisionReason: reason },
    { where: { id: requestId, status: 'PENDING' } }
  );
  if (affected === 0) {
    throw createError('This request was just decided by someone else', 409);
  }

  await request.reload();

  if (decision === 'REJECT') {
    await auditService.record(ctx, {
      action: 'approvals.reject',
      branchId: request.branchId,
      targetType: 'approval_request',
      targetId: request.id,
      // If cash was already physically collected before this got rejected,
      // that fact must survive in the audit trail — it never became a Payment
      // row (nothing was created for a rejected request), so this line is the
      // only record that the money needs to be returned to the customer.
      after: {
        actionKey: request.actionKey,
        reason,
        ...(request.collectedBy ? { hadPreCollection: true, collectedBy: request.collectedBy, collectedAt: request.collectedAt } : {}),
      },
    });
    await notifyRequester(ctx, request, 'rejected', reason).catch(() => {});
    return { request, result: null };
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  const command = commands.getOrThrow(request.actionKey);
  const execCtx = {
    ...ctx,
    branchId: request.branchId,
    grants: approverGrants,
    requestedBy: request.requestedBy,
    // Someone may have already marked this collected — see markCollected()
    // below. Commands that create a Payment (member.commands.js) read this to
    // attribute it to the real collector and start it at STAFF_COLLECTED
    // instead of fabricating a COMPLETED payment credited to the approver.
    collectedBy: request.collectedBy,
    collectedAt: request.collectedAt,
    collectionMethod: request.collectionMethod,
  };

  let result;
  try {
    // Re-validate. Between request and decision the member may already exist, the
    // plan may have been archived, the branch may have hit capacity.
    await command.validate(execCtx, request.payload);
    result = await command.execute(execCtx, request.payload);
  } catch (err) {
    // The command failed after we claimed the row. Return it to PENDING so the
    // approver can retry once the underlying problem is fixed, rather than
    // stranding it as APPROVED with nothing actually created.
    await ApprovalRequest.update(
      { status: 'PENDING', decidedBy: null, decidedAt: null, decisionReason: null },
      { where: { id: requestId } }
    );
    throw err;
  }

  await ApprovalRequest.update(
    { resultRef: result && result.id ? { id: result.id } : null },
    { where: { id: requestId } }
  );

  const selfApproved = request.requestedBy === ctx.userId;
  await auditService.record(ctx, {
    action: 'approvals.approve',
    branchId: request.branchId,
    targetType: 'approval_request',
    targetId: request.id,
    after: {
      actionKey: request.actionKey,
      resultId: result && result.id ? result.id : null,
      selfApproved: selfApproved || undefined,
    },
  });
  if (selfApproved) {
    console.warn(
      `[Approvals] SELF-APPROVAL by ${ctx.userId} on ${request.actionKey} (request ${request.id})`
    );
  }

  await notifyRequester(ctx, request, 'approved').catch(() => {});
  await request.reload();
  return { request, result };
};

/** Actions where "collect the cash before it's approved" is a meaningful step —
 * ones whose eventual execute() creates a Payment. Extend this list as new
 * money-creating commands are added; it's deliberately explicit rather than
 * inferred, so a future action doesn't silently become "collectible" by
 * accident. */
const COLLECTIBLE_ACTION_KEYS = new Set(['members.create']);

/**
 * Mark a still-PENDING request as collected — cash (or a transfer) is already
 * physically in hand, before anyone has approved the underlying member/
 * subscription. Race-safe and idempotent the same way close/decide are: the
 * conditional UPDATE only succeeds once, from `collected_at IS NULL`.
 *
 * This never creates a Payment row itself — there may be no User to attach one
 * to yet (a brand-new member doesn't exist until the request is approved).
 * It's read back by decide() → execute() so the eventual Payment is created
 * already attributed to whoever actually took the money.
 */
const markCollected = async (ctx, requestId, { method, notes } = {}) => {
  const { ApprovalRequest } = ctx.tenantDb.models;
  const request = await ApprovalRequest.findByPk(requestId);
  if (!request) throw createError('Request not found', 404);
  if (request.status !== 'PENDING') {
    throw createError(`This request has already been ${request.status.toLowerCase()}`, 409);
  }
  if (!COLLECTIBLE_ACTION_KEYS.has(request.actionKey)) {
    throw createError(`"${request.actionKey}" has no payment to collect`, 400);
  }

  // Whoever collects must actually hold payments.record at this branch — the
  // same gate the ordinary "Mark as collected" action uses on a real Payment
  // row. Being the original requester isn't required: any authorized
  // collector at the branch may be the one who ends up holding the cash.
  const grants = await accessService.resolve(ctx.tenantDb, ctx.tenantId, ctx.userId, request.branchId);
  if (!grants.isOwner && !grants.has('payments.record')) {
    throw createError('You do not have permission to collect payments at this branch', 403);
  }

  const collectedAt = new Date();
  const [affected] = await ApprovalRequest.update(
    {
      collectedBy: ctx.userId,
      collectedAt,
      collectionMethod: method || null,
      collectionNotes: notes || null,
    },
    { where: { id: requestId, status: 'PENDING', collectedAt: null } }
  );
  if (affected === 0) {
    throw createError('This request was already marked collected', 409);
  }

  await request.reload();

  await auditService.record(ctx, {
    action: 'approvals.collect',
    branchId: request.branchId,
    targetType: 'approval_request',
    targetId: request.id,
    after: { method: method || null, collectedAt },
  });

  return request;
};

/**
 * Cancel your own pending request.
 */
const cancel = async (ctx, requestId) => {
  const { ApprovalRequest } = ctx.tenantDb.models;
  const request = await ApprovalRequest.findByPk(requestId);
  if (!request) throw createError('Request not found', 404);
  if (request.requestedBy !== ctx.userId) {
    throw createError('You can only cancel your own requests', 403);
  }
  const [affected] = await ApprovalRequest.update(
    { status: 'CANCELLED', decidedAt: new Date() },
    { where: { id: requestId, status: 'PENDING' } }
  );
  if (affected === 0) throw createError('This request is no longer pending', 409);
  await request.reload();
  return request;
};

/**
 * The approval inbox.
 *
 * Scoped to branches the caller can actually decide for: an ORG-scoped approver
 * sees everything, a branch-scoped one sees only their branches.
 */
const listForApprover = async (ctx, { status = 'PENDING', branchIds = null, limit = 50, offset = 0 } = {}) => {
  const { ApprovalRequest, Branch } = ctx.tenantDb.models;

  const where = {};
  if (status && status !== 'ALL') where.status = status;
  if (branchIds) where.branchId = { [Op.in]: branchIds };

  return ApprovalRequest.findAndCountAll({
    where,
    include: [{ model: Branch, as: 'branch', attributes: ['id', 'branchName'], required: false }],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });
};

/** Requests the caller raised themselves. */
const listMine = async (ctx, { status = null, limit = 50, offset = 0 } = {}) => {
  const { ApprovalRequest, Branch } = ctx.tenantDb.models;
  const where = { requestedBy: ctx.userId };
  if (status && status !== 'ALL') where.status = status;

  return ApprovalRequest.findAndCountAll({
    where,
    include: [{ model: Branch, as: 'branch', attributes: ['id', 'branchName'], required: false }],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });
};

/** How many decisions are waiting on this user. Drives the drawer badge. */
const pendingCountFor = async (tenantDb, grants, branchIds = null) => {
  if (!grants.isOwner && !grants.has('approvals.view')) return 0;
  const { ApprovalRequest } = tenantDb.models;
  const where = { status: 'PENDING' };
  if (branchIds && !grants.isOwner) where.branchId = { [Op.in]: branchIds };
  return ApprovalRequest.count({ where });
};

// ── Notifications ────────────────────────────────────────────────────────────

/**
 * Tell everyone who can decide this that it is waiting.
 *
 * Without this the REQUEST tier is a black hole: staff submit, nothing visibly
 * happens, and within a week everyone asks to be made an admin instead.
 */
const notifyApprovers = async (ctx, request, policy) => {
  const notificationsService = require('./notifications.service');
  const { RoleAssignment, RoleAssignmentBranch, Branch } = ctx.tenantDb.models;
  const { Tenant } = require('../models/platform');

  const tenant = await Tenant.findByPk(ctx.tenantId, {
    attributes: ['id', 'ownerUserId', 'gymName'],
  });
  const branch = request.branchId ? await Branch.findByPk(request.branchId) : null;
  const branchName = branch ? branch.branchName : 'your gym';

  const candidates = await RoleAssignment.findAll({
    where: { status: 'ACTIVE', roleLevel: { [Op.gte]: policy.minApproverLevel } },
    include: [{ model: RoleAssignmentBranch, as: 'branchLinks', required: false }],
  });

  const recipients = new Set();
  if (tenant && tenant.ownerUserId) recipients.add(tenant.ownerUserId);

  for (const a of candidates) {
    if (!a.userId || a.userId === request.requestedBy) continue;
    const covers =
      a.scopeType === 'ORG' ||
      !request.branchId ||
      (a.branchLinks || []).some((l) => l.branchId === request.branchId);
    if (covers) recipients.add(a.userId);
  }

  const perm = getPermission(request.actionKey);
  const label = perm ? perm.label : request.actionKey;

  for (const userId of recipients) {
    await notificationsService
      .createNotification({
        userId,
        role: 'host',
        type: 'approval_request',
        title: 'Approval needed',
        message: `${label}${request.summary ? `: ${request.summary}` : ''} at ${branchName} is waiting for your approval.`,
        data: { requestId: request.id, actionKey: request.actionKey, branchId: request.branchId },
      })
      .catch(() => {});
  }
};

const notifyRequester = async (ctx, request, outcome, reason = null) => {
  const notificationsService = require('./notifications.service');
  const perm = getPermission(request.actionKey);
  const label = perm ? perm.label : request.actionKey;

  await notificationsService
    .createNotification({
      userId: request.requestedBy,
      role: 'traveler',
      type: `approval_${outcome}`,
      title: outcome === 'approved' ? 'Request approved' : 'Request rejected',
      message:
        outcome === 'approved'
          ? `Your request — ${label}${request.summary ? `: ${request.summary}` : ''} — was approved.`
          : `Your request — ${label}${request.summary ? `: ${request.summary}` : ''} — was rejected.${reason ? ` Reason: ${reason}` : ''}`,
      data: { requestId: request.id, actionKey: request.actionKey },
    })
    .catch(() => {});
};

module.exports = {
  perform,
  decide,
  cancel,
  markCollected,
  COLLECTIBLE_ACTION_KEYS,
  policyFor,
  listForApprover,
  listMine,
  pendingCountFor,
  directKeyFor,
  DEFAULT_POLICY,
};
