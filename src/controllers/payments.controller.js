const paymentService = require('../services/payment.service');
const accessService = require('../services/access.service');
const { sendSuccess, parsePagination, createError } = require('../utils/response.utils');

const HOST_ROLES = ['GYM_HOST', 'BRANCH_MANAGER'];

/**
 * Whether the caller holds `permissionKey` on the branch a payment belongs to.
 *
 * The route this guards used to be `authorize('GYM_HOST')` — literally the
 * platform role string, which is never true for a team member no matter what
 * the permission catalogue grants them. A Branch Manager holding
 * `payments.verify` could not verify a single payment. Same shape as
 * `hasExpenseAccess` in expenses.controller.js: owner fast path, then the real
 * resolved grant for the payment's own branch — never a client-supplied one,
 * so nobody can claim a branch they don't work at to pass this check.
 */
const hasPaymentAccess = async (req, payment, permissionKey) => {
  if (req.user.role === 'GYM_HOST' || req.user.isHost === true) return true;
  if (!payment.branchId) return false;

  const userId = req.user.id || req.user.sub;
  const tenantId = req.user.tenantId || req.tenantDb?.tenantId;
  if (!userId || !tenantId || !req.tenantDb) return false;

  try {
    const grants = await accessService.resolve(req.tenantDb, tenantId, userId, payment.branchId);
    return grants.has(permissionKey);
  } catch (err) {
    console.warn('[payments] permission resolution failed:', err.message);
    return false;
  }
};

// ── POST /payments ─────────────────────────────────────────────────────────────
const recordPayment = async (req, res, next) => {
  try {
    const result = await paymentService.recordPayment(req.tenantDb, req.user.id, req.user.role, req.body);
    return sendSuccess(res, result, 'Payment recorded', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /payments/:id ─────────────────────────────────────────────────────────
const getPaymentById = async (req, res, next) => {
  try {
    const payment = await paymentService.getPayment(req.tenantDb, req.params.id);
    return sendSuccess(res, { payment }, 'Payment retrieved');
  } catch (err) {
    next(err);
  }
};

// ── GET /payments ──────────────────────────────────────────────────────────────
const listPayments = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { userId, status, method, from, to } = req.query;
    let branchId = req.query.branchId;

    if (req.user.role === 'BRANCH_MANAGER') {
      branchId = req.user.branchId;
    }

    const result = await paymentService.listPayments(req.tenantDb, {
      userId: userId || null,
      branchId: branchId || null,
      status: status || null,
      method: method || null,
      from: from || null,
      to: to || null,
      page,
      limit,
      offset,
    });

    return sendSuccess(res, { payments: result.payments }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── POST /payments/:id/verify ──────────────────────────────────────────────────
const verifyPayment = async (req, res, next) => {
  try {
    const { Payment } = req.tenantDb.models;
    const existing = await Payment.findByPk(req.params.id, { attributes: ['id', 'branchId'] });
    if (!existing) throw createError('Payment not found', 404);

    if (!(await hasPaymentAccess(req, existing, 'payments.verify'))) {
      throw createError('You do not have permission to verify payments at this branch', 403);
    }

    const payment = await paymentService.verifyPayment(
      req.tenantDb,
      req.params.id,
      req.user.id,
      req.body.notes
    );
    return sendSuccess(res, { payment }, 'Payment verified');
  } catch (err) {
    next(err);
  }
};

// ── POST /payments/:id/action — collect / verify / reject ─────────────────────
const verifyOrReject = async (req, res, next) => {
  try {
    const payment = await paymentService.verifyOrRejectPayment(
      req.tenantDb,
      req.params.id,
      req.user.id,
      req.user.role,
      req.body
    );
    const msgs = { collect: 'Payment marked as collected', verify: 'Payment verified', reject: 'Payment rejected' };
    return sendSuccess(res, { payment }, msgs[req.body.action] || 'OK');
  } catch (err) {
    next(err);
  }
};

// ── POST /payments/:id/proof — upload proof image ─────────────────────────────
const uploadProof = async (req, res, next) => {
  try {
    if (!req.file) {
      const err = new Error('Proof image file is required');
      err.statusCode = 422;
      return next(err);
    }

    const proofUrl = `${process.env.STORAGE_BASE_URL || '/uploads'}/payment-proofs/${req.params.id}-${Date.now()}.jpg`;
    const payment = await paymentService.uploadPaymentProof(req.tenantDb, req.params.id, proofUrl);
    return sendSuccess(res, { payment }, 'Proof uploaded');
  } catch (err) {
    next(err);
  }
};

// ── POST /payments/collection-action ──────────────────────────────────────────
const collectionAction = async (req, res, next) => {
  try {
    const result = await paymentService.collectionAction(
      req.tenantDb,
      req.body.paymentIds,
      req.user.id
    );
    return sendSuccess(res, result, `${result.collected} payment(s) marked as collected`);
  } catch (err) {
    next(err);
  }
};

// ── GET /invoices — list invoices ──────────────────────────────────────────────
const listInvoices = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { userId, branchId, status, from, to } = req.query;
    const isHost = HOST_ROLES.includes(req.user.role);

    const result = await paymentService.listInvoices(req.tenantDb, req.user.id, isHost, {
      userId: userId || null,
      branchId: branchId || null,
      status: status || null,
      from: from || null,
      to: to || null,
      page,
      limit,
      offset,
    });

    return sendSuccess(res, { invoices: result.invoices }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── GET /invoices/:id ──────────────────────────────────────────────────────────
const getInvoice = async (req, res, next) => {
  try {
    const isHost = HOST_ROLES.includes(req.user.role);
    const invoice = await paymentService.getInvoice(
      req.tenantDb,
      req.params.id,
      req.user.id,
      isHost
    );
    return sendSuccess(res, { invoice });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  recordPayment, listPayments, getPaymentById, verifyPayment, verifyOrReject,
  uploadProof, collectionAction, listInvoices, getInvoice,
};
