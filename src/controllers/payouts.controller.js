/**
 * Payouts Controller (PAY-10, SEC-13, spec §6.3, §12)
 */
const payoutService = require('../services/payout.service');
const approvalService = require('../services/approval.service');
const accessService = require('../services/access.service');
const payoutAccountService = require('../services/payout-account.service');
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

// ── Payout account (P7b, R-94, NEW-217) ──────────────────────────────────────
// The tenant's default payout account. Owner only (payouts.bank.manage, on the route). Organization
// overrides exist in the store and the resolver but are not exposed at launch.

const MAX_DETAIL_LENGTH = 200;

/** `details` must be an object of known bank / wallet fields with text values; returns them trimmed. */
const _readDetails = (details) => {
  const invalid = (message) => {
    const err = createError(message, 400);
    err.code = 'invalid_payout_details';
    return err;
  };
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw invalid('Send the bank or wallet details as an object.');
  }
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (!payoutAccountService.BANK_DETAIL_FIELDS.includes(key)) throw invalid(`Unknown payout detail: ${key}.`);
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number') throw invalid(`${key} must be text.`);
    const text = String(value).trim();
    if (text.length > MAX_DETAIL_LENGTH) throw invalid(`${key} is too long.`);
    if (text) out[key] = text;
  }
  if (Object.keys(out).length === 0) throw invalid('Add at least one bank or wallet detail.');
  return out;
};

/**
 * GET /host/payout-account
 */
const getPayoutAccount = async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const account = await payoutAccountService.getTenantDefault(tenantId);
    return sendSuccess(res, { account });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /host/payout-account  { details, password | provider + idToken }
 * SEC-13: re-authentication, owner alert, and a 24-hour pause on payout requests.
 */
const savePayoutAccount = async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const userId = req.user.id || req.user.sub;
    const details = _readDetails(req.body?.details);
    const { password, provider, reauthProvider, idToken, reauthIdToken } = req.body || {};
    await require('../services/auth.service').assertReauth(userId, {
      password,
      provider: provider || reauthProvider,
      idToken: idToken || reauthIdToken,
    });
    const account = await payoutAccountService.saveTenantDefault(tenantId, details);
    return sendSuccess(res, { account }, 'Payout account saved');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getPayoutAccount,
  savePayoutAccount,
  getBalance,
  listPayouts,
  requestPayout,
};
