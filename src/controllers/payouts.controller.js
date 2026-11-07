/**
 * Payouts Controller (PAY-10, SEC-13, spec §6.3, §12)
 */
const payoutService = require('../services/payout.service');
const approvalService = require('../services/approval.service');
const accessService = require('../services/access.service');
const payoutAccountService = require('../services/payout-account.service');
const { sendSuccess, createError, parsePagination } = require('../utils/response.utils');

const isPlatformAdmin = (req) => req.user?.role === 'PLATFORM_ADMIN';

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
    // NEW-228 (R-97): a platform admin sees each payout's destination masked, never the full number.
    const payouts = isPlatformAdmin(req)
      ? result.payouts.map((p) => {
        const row = typeof p.toJSON === 'function' ? p.toJSON() : { ...p };
        return { ...row, destinationJson: payoutAccountService.maskDetailsForAdmin(row.destinationJson) };
      })
      : result.payouts;
    return sendSuccess(res, { payouts }, 'OK', 200, {
      page,
      limit,
      total: result.total,
      pages: Math.ceil(result.total / limit),
    });
  } catch (err) {
    next(err);
  }
};

// NEW-232 (R-98): body fields that once named, or could be read as, a payout destination. They are
// dropped before validation: the payout always goes to the saved payout account. Older clients that
// still send one keep working; each drop is logged (field names only, never the values).
const IGNORED_DESTINATION_FIELDS = Object.freeze([
  'destinationJson', 'destination', 'payoutAccount', 'bankDetails', 'paymentDetailsJson',
  ...payoutAccountService.BANK_DETAIL_FIELDS,
]);

/** POST /host/payouts middleware: drop destination / bank fields from the body, with one log line. */
const ignoreBodyDestination = (req, _res, next) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return next();
  const dropped = IGNORED_DESTINATION_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(body, k));
  if (dropped.length) {
    for (const k of dropped) delete body[k];
    console.warn(
      `[Payouts] NEW-232: ignored ${dropped.join(', ')} in the POST /host/payouts body; ` +
        `the payout goes to the saved payout account (tenant ${req.tenantId || '-'}, user ${req.user?.id || req.user?.sub || '-'})`
    );
  }
  return next();
};

/**
 * POST /host/payouts
 */
const requestPayout = async (req, res, next) => {
  try {
    const { branchId, amount, notes } = req.body || {};
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
      { branchId, amount, notes, idempotencyKey },
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
 * NEW-228 (R-97): every platform-admin read of a payout account is recorded with the admin's id
 * and the gym. No entry, no answer (as admin.member_contact_revealed): a failure refuses the read.
 */
const _auditAdminRead = async (req, tenantId, account) => {
  const { PlatformAuditLog, Tenant } = require('../models/platform');
  try {
    const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'gymName'] });
    await PlatformAuditLog.create({
      actorUserId: req.user.id || req.user.sub,
      action: 'admin.payout_account_viewed',
      targetType: 'tenant',
      targetId: tenantId,
      details: {
        tenantId,
        gymName: tenant ? tenant.gymName : null,
        payoutAccountId: account ? account.id : null,
        route: `${req.method} ${req.baseUrl}${req.path}`,
      },
      createdAt: new Date(),
    });
  } catch (err) {
    console.error('[Payouts:Audit] Could not record an admin payout-account read:', err.message);
    throw createError('Could not record the audit entry, so the payout account was not shown', 500);
  }
};

/**
 * GET /host/payout-account
 */
const getPayoutAccount = async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const account = await payoutAccountService.getTenantDefault(tenantId);
    if (isPlatformAdmin(req)) {
      // NEW-228 (R-97): masked, and only after the read is on the platform audit trail.
      await _auditAdminRead(req, tenantId, account);
      return sendSuccess(res, { account: payoutAccountService.maskViewForAdmin(account) });
    }
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
  ignoreBodyDestination,
  getPayoutAccount,
  savePayoutAccount,
  getBalance,
  listPayouts,
  requestPayout,
};
