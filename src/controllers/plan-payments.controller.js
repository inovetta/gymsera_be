'use strict';

const planPaymentService = require('../services/plan-payment.service');
const { sendSuccess } = require('../utils/response.utils');

const userId = (req) => req.user?.id || req.user?.sub;

// ── Host (owner): GET /host/plan-payments ──────────────────────────────────────
const getOverview = async (req, res, next) => {
  try {
    return sendSuccess(res, await planPaymentService.getOverview(req.user.tenantId));
  } catch (err) {
    next(err);
  }
};

// ── Host (owner): POST /host/plan-payments (multipart: proof + fields) ──────────
const submit = async (req, res, next) => {
  try {
    const request = await planPaymentService.submit({
      tenantId: req.user.tenantId,
      userId: userId(req),
      billingPlanId: req.body.billingPlanId,
      billingCycle: req.body.billingCycle,
      method: req.body.method || 'BANK_TRANSFER',
      payerReference: req.body.payerReference || null,
      file: req.file || null,
    });
    return sendSuccess(res, { request }, 'Payment sent for review', 201);
  } catch (err) {
    next(err);
  }
};

// ── Admin: GET /admin/plan-payments?status=&tenantId= ───────────────────────────
const adminList = async (req, res, next) => {
  try {
    const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(req.query.status) ? req.query.status : null;
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : null;
    return sendSuccess(res, { requests: await planPaymentService.listForAdmin({ status, tenantId }) });
  } catch (err) {
    next(err);
  }
};

const adminApprove = async (req, res, next) => {
  try {
    const { request, subscription } = await planPaymentService.approve({ requestId: req.params.id, adminUserId: userId(req) });
    return sendSuccess(res, { request, subscription }, 'Payment approved; the plan is active');
  } catch (err) {
    next(err);
  }
};

const adminReject = async (req, res, next) => {
  try {
    const request = await planPaymentService.reject({ requestId: req.params.id, adminUserId: userId(req), reason: req.body.reason });
    return sendSuccess(res, { request }, 'Payment rejected');
  } catch (err) {
    next(err);
  }
};

const adminProof = async (req, res, next) => {
  try {
    const { stream, contentType } = await planPaymentService.openProof({ requestId: req.params.id, adminUserId: userId(req) });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline; filename="plan-payment-receipt"');
    stream.on('error', next);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
};

module.exports = { getOverview, submit, adminList, adminApprove, adminReject, adminProof };
