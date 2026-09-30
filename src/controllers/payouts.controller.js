/**
 * Payouts Controller (PAY-10, SEC-13, spec §6.3, §12)
 */
const payoutService = require('../services/payout.service');
const approvalService = require('../services/approval.service');
const accessService = require('../services/access.service');
const { sendSuccess, createError, parsePagination } = require('../utils/response.utils');

/**
 * GET /host/payouts/balance
 */
const getBalance = async (req, res, next) => {
  try {
    const { branchId } = req.query;
    const balance = await payoutService.getPayoutBalance(req.tenantDb, branchId || null);
    return sendSuccess(res, balance);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /host/payouts
 */
const listPayouts = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { branchId } = req.query;
    const result = await payoutService.listPayouts(req.tenantDb, { branchId, limit, offset });
    return sendSuccess(res, { payouts: result.payouts }, 'OK', 200, {
      page,
      limit,
      total: result.total,
      pages: Math.ceil(result.total / limit),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /host/payouts
 */
const requestPayout = async (req, res, next) => {
  try {
    const { branchId, amount, notes, destinationJson } = req.body || {};
    const tenantId = req.tenantId || req.user?.tenantId || req.tenant?.id;
    const userId = req.user.id || req.user.sub;

    const idempotencyKey =
      req.idempotencyKey ||
      req.headers['idempotency-key'] ||
      req.headers['x-idempotency-key'] ||
      req.body?.idempotencyKey ||
      null;

    const grants =
      req.grants || (await accessService.resolve(req.tenantDb, tenantId, userId, branchId || null));

    const ctx = {
      tenantDb: req.tenantDb,
      tenantId,
      userId,
      branchId: branchId || null,
      grants,
      roleKey: (grants.roleKeys || [])[0] || null,
      req,
    };

    const outcome = await approvalService.perform(
      ctx,
      'payouts.request',
      { branchId, amount, notes, destinationJson, idempotencyKey },
      { idempotencyKey }
    );

    if (outcome.status === 'EXECUTED') {
      return sendSuccess(res, outcome.result, 'Payout request created', 201);
    }

    return sendSuccess(
      res,
      {
        approvalRequestId: outcome.request.id,
        status: 'PENDING',
        summary: outcome.request.summary,
      },
      'Payout request submitted for approval',
      202
    );
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getBalance,
  listPayouts,
  requestPayout,
};
