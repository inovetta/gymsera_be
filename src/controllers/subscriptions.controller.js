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
    const result = await subscriptionService.renew(req.user.id, req.params.id, req.body.planId);
    return sendSuccess(res, result, 'Subscription renewed');
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/:id/change-plan ───────────────────────────────────────
const changePlan = async (req, res, next) => {
  try {
    const result = await subscriptionService.changePlan(req.user.id, req.params.id, req.body.planId);
    return sendSuccess(res, result, 'Plan change registered');
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

// ── GET /subscriptions/:id/detail — member gets full detail (invoice + payment) ─
const getMySubscriptionDetail = async (req, res, next) => {
  try {
    const result = await subscriptionService.getMySubscriptionDetail(req.user.id, req.params.id);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/:id/proof — member uploads payment proof ───────────────
const uploadSubscriptionProof = async (req, res, next) => {
  try {
    if (!req.file) {
      const err = new Error('Proof image file is required');
      err.statusCode = 422;
      return next(err);
    }
    const proofUrl = `${process.env.STORAGE_BASE_URL || '/uploads'}/payment-proofs/sub-${req.params.id}-${Date.now()}.jpg`;
    const payment = await subscriptionService.uploadSubscriptionProof(req.user.id, req.params.id, proofUrl);
    return sendSuccess(res, { payment }, 'Proof uploaded successfully');
  } catch (err) {
    next(err);
  }
};

// ── POST /subscriptions/staff/:id/activate — staff activates without payment ───
const activateSubscription = async (req, res, next) => {
  try {
    const subscription = await subscriptionService.activateSubscription(req.tenantDb, req.params.id);
    return sendSuccess(res, { subscription }, 'Subscription activated');
  } catch (err) {
    next(err);
  }
};

// ── GET /member/branches/:branchId/subscription-status ────────────────────────
const getMemberBranchSubscriptionStatus = async (req, res, next) => {
  try {
    const userId = req.query.userId || req.user.id;
    const result = await subscriptionService.getMemberBranchSubscriptionStatus(
      req.tenantDb,
      userId,
      req.params.branchId
    );
    return sendSuccess(res, result, 'Subscription status retrieved');
  } catch (err) {
    next(err);
  }
};

// ── GET /member/subscriptions/:id/upgrade-options ────────────────────────────
const getUpgradeOptions = async (req, res, next) => {
  try {
    const userId = req.query.userId || req.user.id;
    const result = await subscriptionService.getUpgradeOptions(userId, req.params.id);
    return sendSuccess(res, result, 'Upgrade options retrieved');
  } catch (err) {
    next(err);
  }
};

// ── POST /member/subscriptions/:id/upgrade ───────────────────────────────────
const upgradeSubscription = async (req, res, next) => {
  try {
    const userId = req.query.userId || req.user.id;
    const result = await subscriptionService.upgradeSubscription(userId, req.params.id, req.body.newPlanId);
    return sendSuccess(res, result, 'Subscription upgraded');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  subscribe, listMySubscriptions, freeze, cancel, renew, changePlan,
  listForStaff, getForStaff, preview,
  getMySubscriptionDetail, uploadSubscriptionProof, activateSubscription,
  getMemberBranchSubscriptionStatus, getUpgradeOptions, upgradeSubscription,
};
