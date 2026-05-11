const paymentService = require('../services/payment.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');

const HOST_ROLES = ['GYM_HOST', 'BRANCH_MANAGER'];

// ── POST /payments ─────────────────────────────────────────────────────────────
const recordPayment = async (req, res, next) => {
  try {
    const result = await paymentService.recordPayment(req.tenantDb, req.user.id, req.body);
    return sendSuccess(res, result, 'Payment recorded', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /payments ──────────────────────────────────────────────────────────────
const listPayments = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { userId, status, method, from, to } = req.query;

    const result = await paymentService.listPayments(req.tenantDb, {
      userId: userId || null,
      status: status || null,
      method: method || null,
      from:   from   || null,
      to:     to     || null,
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

// ── POST /payments/:id/verify — verify OR reject ──────────────────────────────
const verifyOrReject = async (req, res, next) => {
  try {
    const payment = await paymentService.verifyOrRejectPayment(
      req.tenantDb,
      req.params.id,
      req.user.id,
      req.body
    );
    const msg = req.body.action === 'verify' ? 'Payment verified' : 'Payment rejected';
    return sendSuccess(res, { payment }, msg);
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
    const { userId, status, from, to } = req.query;
    const isHost = HOST_ROLES.includes(req.user.role);

    const result = await paymentService.listInvoices(req.tenantDb, req.user.id, isHost, {
      userId: userId || null,
      status: status || null,
      from:   from   || null,
      to:     to     || null,
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
  recordPayment, listPayments, verifyPayment, verifyOrReject,
  uploadProof, collectionAction, listInvoices, getInvoice,
};
