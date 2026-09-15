const ledgerService = require('../services/ledger.service');
const { sendSuccess, createError } = require('../utils/response.utils');

// ── GET /ledger/today ────────────────────────────────────────────────────────
// Omitting branchId asks for the gym-wide view — every active branch, merged.
// The route's permission check already restricts that to the owner (see
// ledger.routes.js): a non-owner without a branchId resolves no grants at all.
const getToday = async (req, res, next) => {
  try {
    const data = req.branchId
      ? await ledgerService.getTodayLedger(req.tenantDb, req.branchId)
      : await ledgerService.getTodayLedgerAllBranches(req.tenantDb);
    return sendSuccess(res, data, "Today's ledger retrieved");
  } catch (err) {
    next(err);
  }
};

// ── GET /ledger/day/:businessDate ───────────────────────────────────────────
// Views any specific business date — how a missed/open day gets reconciled.
const getDay = async (req, res, next) => {
  try {
    const { businessDate } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      throw createError('businessDate must be YYYY-MM-DD', 400);
    }
    const data = req.branchId
      ? await ledgerService.getDayLedger(req.tenantDb, req.branchId, businessDate)
      : await ledgerService.getRangeLedgerAllBranches(req.tenantDb, businessDate, businessDate);
    return sendSuccess(res, data, 'Ledger day retrieved');
  } catch (err) {
    next(err);
  }
};

// ── GET /ledger/open-days ───────────────────────────────────────────────────
// Every OPEN day older than today — the reconciliation queue.
const getOpenDays = async (req, res, next) => {
  try {
    const days = req.branchId
      ? await ledgerService.listOpenDays(req.tenantDb, req.branchId)
      : await ledgerService.listOpenDaysAllBranches(req.tenantDb);
    return sendSuccess(res, { days }, 'Open ledger days retrieved');
  } catch (err) {
    next(err);
  }
};

// ── GET /ledger/weekly ───────────────────────────────────────────────────────
const getWeekly = async (req, res, next) => {
  try {
    const anchor = req.query.businessDate
      || (req.branchId ? await ledgerService.todayBusinessDate(req.tenantDb, req.branchId) : ledgerService.computeBusinessDate(new Date()));
    const [from, to] = ledgerService.weekRange(anchor);
    const data = req.branchId
      ? await ledgerService.getRangeLedger(req.tenantDb, req.branchId, from, to)
      : await ledgerService.getRangeLedgerAllBranches(req.tenantDb, from, to);
    return sendSuccess(res, data, 'Weekly ledger retrieved');
  } catch (err) {
    next(err);
  }
};

// ── GET /ledger/monthly ──────────────────────────────────────────────────────
const getMonthly = async (req, res, next) => {
  try {
    const anchor = req.query.businessDate
      || (req.branchId ? await ledgerService.todayBusinessDate(req.tenantDb, req.branchId) : ledgerService.computeBusinessDate(new Date()));
    const [from, to] = ledgerService.monthRange(anchor);
    const data = req.branchId
      ? await ledgerService.getRangeLedger(req.tenantDb, req.branchId, from, to)
      : await ledgerService.getRangeLedgerAllBranches(req.tenantDb, from, to);
    return sendSuccess(res, data, 'Monthly ledger retrieved');
  } catch (err) {
    next(err);
  }
};

// ── POST /ledger/:ledgerDayId/adjustments ───────────────────────────────────
const createAdjustment = async (req, res, next) => {
  try {
    const ctx = {
      tenantDb: req.tenantDb,
      tenantId: req.tenantId,
      userId: req.user.id || req.user.sub,
      branchId: req.branchId,
      roleKey: (req.grants.roleKeys || [])[0] || null,
      req,
    };
    const adjustment = await ledgerService.addAdjustment(ctx, {
      ledgerDayId: req.params.ledgerDayId,
      type: req.body.type,
      relatedPaymentId: req.body.relatedPaymentId,
      amount: req.body.amount,
      reason: req.body.reason,
    });
    return sendSuccess(res, { adjustment }, 'Adjustment recorded', 201);
  } catch (err) {
    next(err);
  }
};

module.exports = { getToday, getDay, getOpenDays, getWeekly, getMonthly, createAdjustment };
