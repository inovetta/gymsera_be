/**
 * Approvals controller — the inbox.
 *
 * The half of the loop most teams forget. Without it the REQUEST tier is a black
 * hole: staff submit, nothing visibly happens, and within a week everyone asks to
 * be made an admin instead.
 */
const { Op } = require('sequelize');
const approvalService = require('../services/approval.service');
const { sendSuccess, createError, parsePagination } = require('../utils/response.utils');
const { getPermission } = require('../constants/permissions');
const { buildCtx } = require('./team.controller');

/**
 * Branches this caller can decide for.
 *
 * Null means "every branch" — an owner or an ORG-scoped approver. A branch-scoped
 * approver sees only their own branches, so one gym's manager never sees another's
 * cash requests.
 */
const decidableBranchIds = async (req) => {
  if (req.grants.isOwner) return null;

  const { RoleAssignment, RoleAssignmentBranch } = req.tenantDb.models;
  const userId = req.user.id || req.user.sub;

  const assignments = await RoleAssignment.findAll({
    where: { userId, status: 'ACTIVE' },
    include: [{ model: RoleAssignmentBranch, as: 'branchLinks', required: false }],
  });

  if (assignments.some((a) => a.scopeType === 'ORG')) return null;
  return [...new Set(assignments.flatMap((a) => (a.branchLinks || []).map((l) => l.branchId)))];
};

/** Shape a request for the inbox card. */
const serialize = (r) => {
  const perm = getPermission(r.actionKey);
  return {
    id: r.id,
    actionKey: r.actionKey,
    actionLabel: perm ? perm.label : r.actionKey,
    module: perm ? perm.module : null,
    dangerous: perm ? perm.dangerous : false,
    summary: r.summary,
    payload: r.payload,
    status: r.status,
    branch: r.branch ? { id: r.branch.id, name: r.branch.branchName } : null,
    requestedBy: r.requestedBy,
    requestedByName: r.requesterName || null,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt,
    decisionReason: r.decisionReason,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
};

/** Attach requester names in one batched query rather than N. */
const withRequesterNames = async (rows) => {
  const { User } = require('../models/platform');
  const ids = [...new Set(rows.map((r) => r.requestedBy).filter(Boolean))];
  if (ids.length === 0) return rows.map(serialize);

  const users = await User.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: ['id', 'fullName', 'email'],
  });
  const byId = Object.fromEntries(users.map((u) => [u.id, u.fullName || u.email]));

  return rows.map((r) => ({ ...serialize(r), requestedByName: byId[r.requestedBy] || null }));
};

/**
 * GET /approvals
 */
const list = async (req, res, next) => {
  try {
    const ctx = buildCtx(req);
    const { limit, offset, page } = parsePagination(req.query, 50, 200);
    const branchIds = await decidableBranchIds(req);

    const { rows, count } = await approvalService.listForApprover(ctx, {
      status: (req.query.status || 'PENDING').toUpperCase(),
      branchIds,
      limit,
      offset,
    });

    const items = await withRequesterNames(rows);
    return sendSuccess(res, items, 'Approvals retrieved', 200, {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit),
    });
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /approvals/mine — what the caller has submitted and is waiting on.
 */
const listMine = async (req, res, next) => {
  try {
    const ctx = buildCtx(req);
    const { limit, offset, page } = parsePagination(req.query, 50, 200);
    const { rows, count } = await approvalService.listMine(ctx, {
      status: req.query.status ? req.query.status.toUpperCase() : null,
      limit,
      offset,
    });
    return sendSuccess(res, rows.map(serialize), 'Your requests retrieved', 200, {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit),
    });
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /approvals/:id/approve
 */
const approve = async (req, res, next) => {
  try {
    const ctx = buildCtx(req);
    const { request, result } = await approvalService.decide(
      ctx,
      req.params.id,
      'APPROVE',
      req.body.reason || null
    );
    return sendSuccess(
      res,
      { request: serialize(request), result },
      'Request approved'
    );
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /approvals/:id/reject
 */
const reject = async (req, res, next) => {
  try {
    if (!req.body.reason) {
      throw createError('A reason is required when rejecting a request', 400);
    }
    const ctx = buildCtx(req);
    const { request } = await approvalService.decide(ctx, req.params.id, 'REJECT', req.body.reason);
    return sendSuccess(res, { request: serialize(request) }, 'Request rejected');
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /approvals/:id/cancel — the requester withdrawing their own request.
 */
const cancel = async (req, res, next) => {
  try {
    const ctx = buildCtx(req);
    const request = await approvalService.cancel(ctx, req.params.id);
    return sendSuccess(res, { request: serialize(request) }, 'Request cancelled');
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /approvals/policies — who decides what, and how fast.
 */
const listPolicies = async (req, res, next) => {
  try {
    const { ApprovalPolicy } = req.tenantDb.models;
    const policies = await ApprovalPolicy.findAll({ order: [['actionKey', 'ASC']] });
    return sendSuccess(
      res,
      { policies, defaults: approvalService.DEFAULT_POLICY },
      'Approval policies retrieved'
    );
  } catch (err) {
    return next(err);
  }
};

/**
 * PUT /approvals/policies/:actionKey
 */
const upsertPolicy = async (req, res, next) => {
  try {
    const { ApprovalPolicy } = req.tenantDb.models;
    const { actionKey } = req.params;
    if (!getPermission(actionKey)) {
      throw createError(`Unknown action: ${actionKey}`, 400);
    }

    const branchId = req.body.branchId || null;
    const values = {
      branchId,
      actionKey,
      approverPermission: req.body.approverPermission || 'approvals.decide',
      minApproverLevel: req.body.minApproverLevel ?? 40,
      quorum: 1, // v1 — the column exists, the feature does not
      slaHours: req.body.slaHours ?? null,
      escalateToLevel: req.body.escalateToLevel ?? null,
      autoExpireHours: req.body.autoExpireHours ?? null,
    };

    const existing = await ApprovalPolicy.findOne({ where: { actionKey, branchId } });
    const policy = existing ? await existing.update(values) : await ApprovalPolicy.create(values);

    return sendSuccess(res, policy, 'Approval policy saved');
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  list,
  listMine,
  approve,
  reject,
  cancel,
  listPolicies,
  upsertPolicy,
  decidableBranchIds,
};
