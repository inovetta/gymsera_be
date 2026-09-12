/**
 * Approvable actions — one endpoint for every gated action.
 *
 * The client posts an action key and a payload; the engine decides from the
 * caller's grants alone whether to execute now or queue an approval request. The
 * controller contains no approval logic, and adding a new approvable action means
 * registering a command — no new endpoint, no new route, no client release.
 *
 * This is the generic path. A module with its own richer endpoint calls
 * approvalService.perform() directly from its own controller instead; both reach
 * the same command.
 */
const approvalService = require('../services/approval.service');
const commands = require('../services/commands');
const { sendSuccess, createError } = require('../utils/response.utils');
const { getPermission } = require('../constants/permissions');

/**
 * POST /actions/:actionKey
 *
 * Body: { branchId, payload, idempotencyKey? }
 *
 * 200 + { status: 'EXECUTED' } when the caller holds `<actionKey>.direct`
 * 202 + { status: 'PENDING'  } when it needs approval
 * 403                          when they hold neither
 */
const perform = async (req, res, next) => {
  try {
    const { actionKey } = req.params;

    if (!getPermission(actionKey)) {
      throw createError(`Unknown action: ${actionKey}`, 400);
    }
    if (!commands.has(actionKey)) {
      throw createError(`"${actionKey}" is not an approvable action`, 400);
    }

    const ctx = {
      tenantDb: req.tenantDb,
      tenantId: req.tenantId,
      userId: req.user.id || req.user.sub,
      branchId: req.branchId,
      grants: req.grants,
      roleKey: (req.grants.roleKeys || [])[0] || null,
      req,
    };

    const outcome = await approvalService.perform(
      ctx,
      actionKey,
      req.body.payload || req.body,
      { idempotencyKey: req.body.idempotencyKey || req.headers['idempotency-key'] }
    );

    if (outcome.status === 'EXECUTED') {
      return sendSuccess(res, { status: 'EXECUTED', result: outcome.result }, 'Done', 200);
    }

    return sendSuccess(
      res,
      {
        status: 'PENDING',
        requestId: outcome.request.id,
        summary: outcome.request.summary,
        duplicate: outcome.duplicate || false,
      },
      'Sent for approval. You will be notified once it is decided.',
      202
    );
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /actions/available
 *
 * Which gated actions the caller can take in this branch, and at which tier.
 * Lets the client render Off / Needs approval / Direct affordances without
 * hardcoding any knowledge of the catalogue.
 */
const available = async (req, res, next) => {
  try {
    const actions = commands.registeredKeys().map((key) => {
      const perm = getPermission(key);
      return {
        actionKey: key,
        label: perm ? perm.label : key,
        module: perm ? perm.module : null,
        dangerous: perm ? perm.dangerous : false,
        tier: req.grants.tierFor(key), // 'DIRECT' | 'REQUEST' | 'OFF'
      };
    });

    return sendSuccess(res, { branchId: req.branchId, actions }, 'Available actions retrieved');
  } catch (err) {
    return next(err);
  }
};

module.exports = { perform, available };
