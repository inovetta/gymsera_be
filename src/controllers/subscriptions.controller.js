const subscriptionService = require('../services/subscription.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');

// ── POST /subscriptions ───────────────────────────────────────────────────────
const subscribe = async (req, res, next) => {
  try {
    const result = await subscriptionService.subscribe(req.user.id, req.body);
    return sendSuccess(res, result, 'Subscription created successfully', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /me/subscriptions ─────────────────────────────────────────────────────
const listMySubscriptions = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 10, 50);
    const { status } = req.query;

    const result = await subscriptionService.listMySubscriptions(req.user.id, {
      status: status || null,
      page,
      limit,
      offset,
    });

    return sendSuccess(
      res,
      { memberships: result.memberships },
      'OK',
      200,
      result.pagination
    );
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/:id/freeze ────────────────────────────────────────────
const freeze = async (req, res, next) => {
  try {
    const subscription = await subscriptionService.freeze(
      req.user.id,
      req.params.id,
      req.body
    );
    return sendSuccess(res, { subscription }, 'Subscription frozen');
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/:id/cancel ────────────────────────────────────────────
const cancel = async (req, res, next) => {
  try {
    const subscription = await subscriptionService.cancel(req.user.id, req.params.id);
    return sendSuccess(res, { subscription }, 'Subscription cancelled');
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/:id/renew ─────────────────────────────────────────────
const renew = async (req, res, next) => {
  try {
    const result = await subscriptionService.renew(req.user.id, req.params.id);
    return sendSuccess(res, result, 'Subscription renewed');
  } catch (err) {
    next(err);
  }
};

// ── GET /subscriptions — staff list all ───────────────────────────────────────
const listForStaff = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { status, branchId, userId } = req.query;

    const result = await subscriptionService.listForStaff(req.tenantDb, {
      status: status || null,
      branchId: branchId || null,
      userId: userId || null,
      page,
      limit,
      offset,
    });

    return sendSuccess(
      res,
      { subscriptions: result.subscriptions },
      'OK',
      200,
      result.pagination
    );
  } catch (err) {
    next(err);
  }
};

// ── GET /subscriptions/:id — staff detail ─────────────────────────────────────
const getForStaff = async (req, res, next) => {
  try {
    const result = await subscriptionService.getForStaff(req.tenantDb, req.params.id);
    return sendSuccess(res, result, 'Subscription retrieved');
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/preview — dry-run calculation ─────────────────────────
const preview = async (req, res, next) => {
  try {
    const result = await subscriptionService.previewSubscription(req.tenantDb, req.body);
    return sendSuccess(res, result, 'Preview calculated');
  } catch (err) {
    next(err);
  }
};

module.exports = { subscribe, listMySubscriptions, freeze, cancel, renew, listForStaff, getForStaff, preview };
