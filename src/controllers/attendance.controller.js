const attendanceService = require('../services/attendance.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');

// ── POST /attendance/device-notify ────────────────────────────────────────────
const deviceNotify = async (req, res, next) => {
  try {
    const log = await attendanceService.deviceNotify(req.tenantDb, req.body);
    return sendSuccess(res, { log }, 'Device event recorded', 201);
  } catch (err) {
    next(err);
  }
};

// ── POST /attendance/qr-scan ───────────────────────────────────────────────────
const qrScan = async (req, res, next) => {
  try {
    const log = await attendanceService.qrScan(req.tenantDb, req.body);
    return sendSuccess(res, { log }, 'Check-in recorded', 201);
  } catch (err) {
    next(err);
  }
};

// ── POST /attendance/manual ────────────────────────────────────────────────────
const manual = async (req, res, next) => {
  try {
    const log = await attendanceService.manual(req.tenantDb, req.user.id, req.body);
    return sendSuccess(res, { log }, 'Check-in recorded', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /attendance — main list with filters ───────────────────────────────────
const list = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { branchId, date, userId } = req.query;

    const result = await attendanceService.list(req.tenantDb, {
      branchId: branchId || null,
      date:     date     || null,
      userId:   userId   || null,
      page,
      limit,
      offset,
    });

    return sendSuccess(res, { logs: result.logs }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── GET /attendance/today ──────────────────────────────────────────────────────
const todayLogs = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { branchId } = req.query;

    const result = await attendanceService.today(req.tenantDb, {
      branchId: branchId || null,
      page,
      limit,
      offset,
    });

    return sendSuccess(res, { logs: result.logs }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── GET /attendance/range ──────────────────────────────────────────────────────
const rangeLogs = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { from, to, branchId, userId } = req.query;

    const result = await attendanceService.range(req.tenantDb, {
      from, to,
      branchId: branchId || null,
      userId:   userId   || null,
      page,
      limit,
      offset,
    });

    return sendSuccess(res, { logs: result.logs }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── GET /attendance/customer/:userId ──────────────────────────────────────────
const memberHistory = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);

    const result = await attendanceService.memberHistory(req.tenantDb, req.params.userId, {
      page,
      limit,
      offset,
    });

    return sendSuccess(res, { logs: result.logs }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── GET /attendance/report/:period ─────────────────────────────────────────────
const report = async (req, res, next) => {
  try {
    const { period } = req.params;
    const { branchId, year, month } = req.query;

    const result = await attendanceService.aggregateReport(req.tenantDb, period, {
      branchId: branchId || null,
      year,
      month,
    });

    return sendSuccess(res, result, 'Report generated');
  } catch (err) {
    next(err);
  }
};

// ── PATCH /attendance/:id/check-out ───────────────────────────────────────────
const checkOut = async (req, res, next) => {
  try {
    const log = await attendanceService.checkOut(req.tenantDb, req.params.id);
    return sendSuccess(res, { log }, 'Check-out recorded');
  } catch (err) {
    next(err);
  }
};

module.exports = { deviceNotify, qrScan, manual, list, todayLogs, rangeLogs, memberHistory, report, checkOut };

