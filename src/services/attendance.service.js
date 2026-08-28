const { Op } = require('sequelize');
const { createError, buildPagination } = require('../utils/response.utils');
const { SubscriptionStatus } = require('../constants/subscription-status');

// ── Shared: validate subscription + decrement visit count ────────────────────
const _validateSubscription = async (models, subscription) => {
  if (!subscription) throw createError('Subscription not found', 404);
  if (subscription.status !== SubscriptionStatus.ACTIVE) {
    throw createError(`Subscription is ${subscription.status.toLowerCase()}`, 403);
  }

  const today = new Date().toISOString().split('T')[0];
  if (today > subscription.endDate) {
    await subscription.update({ status: SubscriptionStatus.EXPIRED });
    throw createError('Subscription has expired', 403);
  }

  // Decrement remaining visits if the plan has a visit limit
  if (subscription.remainingVisits !== null) {
    if (subscription.remainingVisits <= 0) {
      throw createError('No remaining visits on this subscription', 403);
    }
    await subscription.decrement('remainingVisits', { by: 1 });
  }
};

// ── POST /attendance/qr-scan ──────────────────────────────────────────────────
const qrScan = async (tenantDb, { qrCode, branchId, deviceId }) => {
  const { MemberSubscription, AttendanceLog, Branch, MembershipPlan } = tenantDb.models;

  const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
  if (!branch) throw createError('Branch not found or inactive', 404);

  let subscription = await MemberSubscription.findOne({ where: { qrCode } });
  if (!subscription) {
    // Try finding by subscription ID (in case the QR encoded the sub id)
    subscription = await MemberSubscription.findByPk(qrCode);
  }
  if (!subscription) {
    // Try finding active subscription by userId (in case QR encoded user id)
    subscription = await MemberSubscription.findOne({
      where: { userId: qrCode, status: SubscriptionStatus.ACTIVE },
      order: [['subscribedAt', 'DESC']]
    });
  }

  await _validateSubscription(tenantDb.models, subscription);

  // Ensure subscription belongs to this branch (or is gym-wide / belongs to same gym)
  if (subscription.branchId && subscription.branchId !== branchId) {
    const subBranch = await Branch.findByPk(subscription.branchId);
    if (!subBranch || (subBranch.gymId && subBranch.gymId !== branch.gymId)) {
      throw createError('QR code is not valid for this branch', 403);
    }
  }

  const log = await AttendanceLog.create({
    branchId,
    userId:                subscription.userId,
    memberSubscriptionId:  subscription.id,
    attendanceType:        'CHECK_IN',
    checkInAt:             new Date(),
    entryMethod:           'QR_SCAN',
    deviceId:              deviceId || null,
  });

  return log;
};

// ── POST /attendance/manual ───────────────────────────────────────────────────
const manual = async (tenantDb, staffUserId, { userId, branchId, subscriptionId, notes }) => {
  const { MemberSubscription, AttendanceLog, Branch } = tenantDb.models;

  const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
  if (!branch) throw createError('Branch not found or inactive', 404);

  const subscription = await MemberSubscription.findOne({
    where: { id: subscriptionId, userId, branchId },
  });
  await _validateSubscription(tenantDb.models, subscription);

  const log = await AttendanceLog.create({
    branchId,
    userId,
    memberSubscriptionId: subscriptionId,
    attendanceType:       'CHECK_IN',
    checkInAt:            new Date(),
    entryMethod:          'MANUAL',
    notes:                notes || null,
  });

  return log;
};

// ── GET /attendance ────────────────────────────────────────────────────────────
const list = async (tenantDb, { branchId, date, userId, page, limit, offset }) => {
  const { AttendanceLog } = tenantDb.models;
  const where = {};

  if (branchId) where.branchId = branchId;
  if (userId)   where.userId   = userId;

  if (date) {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd   = new Date(`${date}T23:59:59.999Z`);
    where.checkInAt = { [Op.between]: [dayStart, dayEnd] };
  }

  const { count, rows } = await AttendanceLog.findAndCountAll({
    where,
    order:  [['checkInAt', 'DESC']],
    limit,
    offset,
  });

  return { logs: rows, pagination: buildPagination(count, page, limit) };
};

// ── POST /attendance/device-notify — biometric device push ────────────────────
/**
 * Accepts ZKTeco/biometric device pushes (no JWT — secured by API key).
 * Payload: { deviceId, userId, eventTime, branchId }
 */
const deviceNotify = async (tenantDb, { deviceId, userId, eventTime, branchId }) => {
  const { AttendanceLog, Branch, MemberSubscription } = tenantDb.models;

  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  // Find the user's active subscription for this branch
  const subscription = await MemberSubscription.findOne({
    where: { userId, branchId, status: SubscriptionStatus.ACTIVE },
    order: [['subscribedAt', 'DESC']],
  });
  // Device events are best-effort — don't throw if no active subscription found
  const memberSubscriptionId = subscription ? subscription.id : null;

  const log = await AttendanceLog.create({
    branchId,
    userId,
    memberSubscriptionId,
    attendanceType: 'CHECK_IN',
    checkInAt:      eventTime ? new Date(eventTime) : new Date(),
    entryMethod:    'DEVICE',
    deviceId:       deviceId || null,
  });

  return log;
};

// ── GET /attendance/today ─────────────────────────────────────────────────────
const today = async (tenantDb, { branchId, page, limit, offset }) => {
  const { AttendanceLog } = tenantDb.models;
  const todayStr = new Date().toISOString().split('T')[0];

  const where = {
    checkInAt: {
      [Op.gte]: new Date(`${todayStr}T00:00:00.000Z`),
      [Op.lte]: new Date(`${todayStr}T23:59:59.999Z`),
    },
  };
  if (branchId) where.branchId = branchId;

  const { count, rows } = await AttendanceLog.findAndCountAll({
    where,
    order: [['checkInAt', 'DESC']],
    limit,
    offset,
  });

  return { logs: rows, pagination: buildPagination(count, page, limit) };
};

// ── GET /attendance/range ─────────────────────────────────────────────────────
const range = async (tenantDb, { from, to, branchId, userId, page, limit, offset }) => {
  const { AttendanceLog } = tenantDb.models;

  if (!from || !to) throw createError('from and to query params are required', 400);

  const where = {
    checkInAt: {
      [Op.gte]: new Date(`${from}T00:00:00.000Z`),
      [Op.lte]: new Date(`${to}T23:59:59.999Z`),
    },
  };
  if (branchId) where.branchId = branchId;
  if (userId)   where.userId   = userId;

  const { count, rows } = await AttendanceLog.findAndCountAll({
    where,
    order: [['checkInAt', 'DESC']],
    limit,
    offset,
  });

  return { logs: rows, pagination: buildPagination(count, page, limit) };
};

const memberHistory = async (tenantDb, userId, { branchId, page, limit, offset }) => {
  const { AttendanceLog } = tenantDb.models;

  const where = { userId };
  if (branchId) {
    where.branchId = branchId;
  }

  const { count, rows } = await AttendanceLog.findAndCountAll({
    where,
    order: [['checkInAt', 'DESC']],
    limit,
    offset,
  });

  return { logs: rows, pagination: buildPagination(count, page, limit) };
};

// ── GET /attendance/report/:period ─────────────────────────────────────────────
/**
 * Aggregate attendance report grouped by period.
 * period: 'daily' | 'weekly' | 'monthly' | 'yearly'
 */
const aggregateReport = async (tenantDb, period, { branchId, year, month }) => {
  const { AttendanceLog, sequelize } = tenantDb;
  const seq = tenantDb.sequelize;
  const models = tenantDb.models;

  const now = new Date();
  const y = parseInt(year) || now.getFullYear();
  let fromDate, toDate, groupExpr, groupAlias;

  switch (period) {
    case 'daily':
      fromDate = new Date(y, (parseInt(month) || now.getMonth() + 1) - 1, 1);
      toDate   = new Date(y, (parseInt(month) || now.getMonth() + 1), 0, 23, 59, 59);
      groupExpr  = seq.fn('DATE', seq.col('check_in_at'));
      groupAlias = 'day';
      break;
    case 'weekly':
      fromDate = new Date(y, 0, 1);
      toDate   = new Date(y, 11, 31, 23, 59, 59);
      groupExpr  = seq.fn('WEEK', seq.col('check_in_at'), 1);
      groupAlias = 'week';
      break;
    case 'monthly':
      fromDate = new Date(y, 0, 1);
      toDate   = new Date(y, 11, 31, 23, 59, 59);
      groupExpr  = seq.fn('MONTH', seq.col('check_in_at'));
      groupAlias = 'month';
      break;
    case 'yearly':
      fromDate = new Date(y - 2, 0, 1);
      toDate   = new Date(y, 11, 31, 23, 59, 59);
      groupExpr  = seq.fn('YEAR', seq.col('check_in_at'));
      groupAlias = 'year';
      break;
    default:
      throw createError('Invalid period. Use: daily, weekly, monthly, yearly', 400);
  }

  const where = { checkInAt: { [Op.between]: [fromDate, toDate] } };
  if (branchId) where.branchId = branchId;

  const rows = await models.AttendanceLog.findAll({
    attributes: [
      [groupExpr, groupAlias],
      [seq.fn('COUNT', seq.col('id')), 'checkIns'],
    ],
    where,
    group: [groupExpr],
    order: [[groupExpr, 'ASC']],
    raw: true,
  });

  return { period, rows };
};

// ── PATCH /attendance/:id/check-out ──────────────────────────────────────────
const checkOut = async (tenantDb, logId) => {
  const { AttendanceLog } = tenantDb.models;

  const log = await AttendanceLog.findByPk(logId);
  if (!log) throw createError('Attendance log not found', 404);
  if (log.checkOutAt) throw createError('Already checked out', 409);

  await log.update({ checkOutAt: new Date(), attendanceType: 'CHECK_OUT' });
  return log;
};

module.exports = { qrScan, manual, list, deviceNotify, today, range, memberHistory, aggregateReport, checkOut };

