const { Op } = require('sequelize');
const paymentService = require('../services/payment.service');
const accessService = require('../services/access.service');
const { sendSuccess, parsePagination, createError } = require('../utils/response.utils');

/**
 * Whether the caller holds `permissionKey` on `branchId`.
 *
 * The routes this guards used to sit behind a router-level
 * `authorize('GYM_HOST', 'BRANCH_MANAGER')` — literally the platform role
 * string, which is never true for a team member no matter what the permission
 * catalogue grants them, and which rejected the request before any of this
 * ever ran. A Branch Admin holding `payments.verify` could not verify a single
 * payment. Same shape as `hasExpenseAccess` in expenses.controller.js: owner
 * fast path, then the real resolved grant for the branch in question — never
 * a client-supplied one where the caller could claim a branch they don't work
 * at — then the legacy `GymStaff` admin-designation fallback for a tenant that
 * hasn't run the RBAC backfill yet.
 */
const hasBranchAccess = async (req, branchId, permissionKey) => {
  if (req.user.role === 'GYM_HOST' || req.user.isHost === true) return true;
  if (!branchId) return false;

  const userId = req.user.id || req.user.sub;
  const tenantId = req.user.tenantId || req.tenantDb?.tenantId;
  if (userId && tenantId && req.tenantDb) {
    try {
      const grants = await accessService.resolve(req.tenantDb, tenantId, userId, branchId);
      if (grants.has(permissionKey)) return true;
    } catch (err) {
      console.warn('[payments] permission resolution failed, falling back to legacy check:', err.message);
    }
  }

  if (req.user.role === 'BRANCH_MANAGER') {
    const staff = await req.tenantDb.models.GymStaff.findOne({
      where: {
        branchId,
        userId,
        [Op.or]: [{ status: 'active' }, { employmentStatus: 'ACTIVE' }],
      },
    });
    if (staff && (staff.designation || '').trim().toLowerCase() === 'admin') {
      return true;
    }
  }
  return false;
};

/** Whether the caller holds the DIRECT-tier twin of `permissionKey` on `branchId`. */
const hasDirectBranchAccess = async (req, branchId, permissionKey) => {
  if (req.user.role === 'GYM_HOST' || req.user.isHost === true) return true;
  if (!branchId) return false;

  const userId = req.user.id || req.user.sub;
  const tenantId = req.user.tenantId || req.tenantDb?.tenantId;
  if (!userId || !tenantId || !req.tenantDb) return false;

  try {
    const grants = await accessService.resolve(req.tenantDb, tenantId, userId, branchId);
    return grants.has(`${permissionKey}.direct`);
  } catch (err) {
    console.warn('[payments] permission resolution failed:', err.message);
    return false;
  }
};

// ── POST /payments ─────────────────────────────────────────────────────────────
const recordPayment = async (req, res, next) => {
  try {
    // The host's own cash-payment screens never send branchId on this call — it's
    // derived from the subscription being paid for, same fallback
    // paymentService.recordPayment already uses when it creates the invoice.
    let branchId = req.body.branchId || null;
    if (!branchId && req.body.paymentFor === 'MEMBERSHIP' && req.body.referenceEntityId) {
      const { MemberSubscription } = req.tenantDb.models;
      const subscription = await MemberSubscription.findByPk(req.body.referenceEntityId, {
        attributes: ['id', 'branchId'],
      });
      branchId = subscription?.branchId || null;
    }

    if (!(await hasBranchAccess(req, branchId, 'payments.record'))) {
      throw createError(
        branchId
          ? 'You do not have permission to record payments at this branch'
          : 'A branch is required to record this payment',
        branchId ? 403 : 400
      );
    }
    const isDirect = await hasDirectBranchAccess(req, branchId, 'payments.record');

    // The resolved branchId (subscription fallback included) must actually reach
    // the service — req.body.branchId alone is what was missing before, which
    // meant a payment recorded via the subscription fallback silently got no
    // branch at all, and with it no ledger business date.
    const result = await paymentService.recordPayment(
      req.tenantDb,
      req.user.id,
      req.user.role,
      { ...req.body, branchId },
      isDirect
    );
    return sendSuccess(res, result, 'Payment recorded', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /payments/:id ─────────────────────────────────────────────────────────
const getPaymentById = async (req, res, next) => {
  try {
    const payment = await paymentService.getPayment(req.tenantDb, req.params.id);
    if (!(await hasBranchAccess(req, payment.branchId, 'payments.view'))) {
      throw createError('You do not have permission to view payments at this branch', 403);
    }
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
    const branchId = req.query.branchId || null;

    if (branchId) {
      if (!(await hasBranchAccess(req, branchId, 'payments.view'))) {
        throw createError('You do not have permission to view payments at this branch', 403);
      }
    } else if (!(req.user.role === 'GYM_HOST' || req.user.isHost === true)) {
      throw createError('A branch is required to list payments', 400);
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

    if (!(await hasBranchAccess(req, existing.branchId, 'payments.verify'))) {
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

// action → the permission it needs, resolved on the payment's own branch.
const ACTION_PERMISSION = { collect: 'payments.record', verify: 'payments.verify', reject: 'payments.record' };

// ── POST /payments/:id/action — collect / verify / reject ─────────────────────
const verifyOrReject = async (req, res, next) => {
  try {
    const { Payment } = req.tenantDb.models;
    const existing = await Payment.findByPk(req.params.id, { attributes: ['id', 'branchId'] });
    if (!existing) throw createError('Payment not found', 404);

    const permissionKey = ACTION_PERMISSION[req.body.action];
    if (!permissionKey) throw createError('Unknown action', 400);

    // 'reject' is allowed by whoever could have recorded OR verified the payment.
    const allowed = req.body.action === 'reject'
      ? (await hasBranchAccess(req, existing.branchId, 'payments.record'))
        || (await hasBranchAccess(req, existing.branchId, 'payments.verify'))
      : await hasBranchAccess(req, existing.branchId, permissionKey);

    if (!allowed) {
      throw createError('You do not have permission to do that with payments at this branch', 403);
    }

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

    const { Payment } = req.tenantDb.models;
    const existing = await Payment.findByPk(req.params.id, { attributes: ['id', 'branchId'] });
    if (!existing) throw createError('Payment not found', 404);
    if (!(await hasBranchAccess(req, existing.branchId, 'payments.record'))) {
      throw createError('You do not have permission to record payments at this branch', 403);
    }

    const proofUrl = `${process.env.STORAGE_BASE_URL || '/uploads'}/payment-proofs/${req.params.id}-${Date.now()}.jpg`;
    const payment = await paymentService.uploadPaymentProof(req.tenantDb, req.params.id, proofUrl);
    return sendSuccess(res, { payment }, 'Proof uploaded');
  } catch (err) {
    next(err);
  }
};

// ── POST /payments/:id/printed — audit-only receipt-printed ping ──────────────
const markPrinted = async (req, res, next) => {
  try {
    const existing = await Payment.findByPk(req.params.id);
    if (!existing) throw createError('Payment not found', 404);
    if (!(await hasBranchAccess(req, existing.branchId, 'payments.view'))) {
      throw createError('You do not have permission to view payments at this branch', 403);
    }

    await existing.update({
      printedAt: new Date(),
      printedBy: req.user.id || req.user.sub,
    });
    return sendSuccess(res, {}, 'Recorded');
  } catch (err) {
    next(err);
  }
};

// ── POST /payments/collection-action ──────────────────────────────────────────
const collectionAction = async (req, res, next) => {
  try {
    const paymentIds = req.body.paymentIds || [];
    const { Payment } = req.tenantDb.models;
    const targets = await Payment.findAll({ where: { id: paymentIds }, attributes: ['id', 'branchId'] });
    const branchIds = [...new Set(targets.map((p) => p.branchId).filter(Boolean))];

    for (const branchId of branchIds) {
      if (!(await hasBranchAccess(req, branchId, 'payments.record'))) {
        throw createError('You do not have permission to collect payments at one or more of these branches', 403);
      }
    }

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

    // `isHost` here really means "viewing as staff, not as the traveler these
    // invoices belong to" — resolved from invoices.view on the branch in
    // question rather than the legacy GYM_HOST/BRANCH_MANAGER role string, so
    // a role_assignments-based team member sees the branch's invoices instead
    // of being quietly treated as a traveler and shown only their own.
    const isHost = branchId
      ? await hasBranchAccess(req, branchId, 'invoices.view')
      : (req.user.role === 'GYM_HOST' || req.user.isHost === true);

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
    const { Invoice } = req.tenantDb.models;
    const existing = await Invoice.findByPk(req.params.id, { attributes: ['id', 'branchId'] });
    const isHost = existing
      ? await hasBranchAccess(req, existing.branchId, 'invoices.view')
      : (req.user.role === 'GYM_HOST' || req.user.isHost === true);

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
  uploadProof, markPrinted, collectionAction, listInvoices, getInvoice,
};
