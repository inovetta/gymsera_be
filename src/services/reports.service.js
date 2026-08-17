const { Op } = require('sequelize');
const { GymListing, Tenant, UserGymMembership } = require('../models/platform');
const { SubscriptionStatus } = require('../constants/subscription-status');
const { PaymentStatus } = require('../constants/payment-status');

// ── Host dashboard KPIs ────────────────────────────────────────────────────────
/**
 * Returns key metrics for a gym host's dashboard from the tenant DB.
 * All counts are fast aggregations; no heavy joins.
 */
const hostDashboard = async (tenantDb) => {
  const { MemberSubscription, AttendanceLog, Payment, MembershipPlan, Branch } = tenantDb.models;
  const today = new Date().toISOString().split('T')[0];

  const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
  const activeBranchIds = activeBranches.map((b) => b.id);
  const branchFilter = { branchId: { [Op.in]: activeBranchIds } };

  if (activeBranchIds.length === 0) {
    return {
      members: { active: 0, frozen: 0, expiredThisMonth: 0 },
      attendance: { checkInsToday: 0 },
      revenue: { allTime: 0, thisMonth: 0, pendingCount: 0 },
      plans: { active: 0 },
      branches: { active: 0 },
    };
  }

  const [
    totalActiveMembers,
    totalFrozenMembers,
    totalExpiredThisMonth,
    checkInsToday,
    totalRevenue,
    revenueThisMonth,
    pendingPayments,
    activePlans,
  ] = await Promise.all([
    // Active subscriptions
    MemberSubscription.count({ where: { ...branchFilter, status: SubscriptionStatus.ACTIVE } }),

    // Frozen subscriptions
    MemberSubscription.count({ where: { ...branchFilter, status: SubscriptionStatus.FROZEN } }),

    // Expired this calendar month
    MemberSubscription.count({
      where: {
        ...branchFilter,
        status: SubscriptionStatus.EXPIRED,
        endDate: {
          [Op.gte]: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
            .toISOString().split('T')[0],
        },
      },
    }),

    // Attendance check-ins today
    AttendanceLog.count({
      where: {
        ...branchFilter,
        checkInAt: {
          [Op.gte]: new Date(`${today}T00:00:00.000Z`),
          [Op.lte]: new Date(`${today}T23:59:59.999Z`),
        },
        attendanceType: 'CHECK_IN',
      },
    }),

    // All-time completed revenue
    Payment.sum('amount', { where: { ...branchFilter, status: PaymentStatus.COMPLETED } }),

    // Revenue this calendar month
    Payment.sum('amount', {
      where: {
        ...branchFilter,
        status: PaymentStatus.COMPLETED,
        paidAt: {
          [Op.gte]: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        },
      },
    }),

    // Pending payments count
    Payment.count({ where: { ...branchFilter, status: PaymentStatus.PENDING } }),

    // Active membership plans
    MembershipPlan.count({
      where: {
        status: 'ACTIVE',
        [Op.or]: [
          { branchId: { [Op.in]: activeBranchIds } },
          { branchId: null },
        ],
      },
    }),
  ]);

  return {
    members: {
      active:           totalActiveMembers || 0,
      frozen:           totalFrozenMembers || 0,
      expiredThisMonth: totalExpiredThisMonth || 0,
    },
    attendance: {
      checkInsToday: checkInsToday || 0,
    },
    revenue: {
      allTime:      parseFloat(totalRevenue     || 0),
      thisMonth:    parseFloat(revenueThisMonth || 0),
      pendingCount: pendingPayments || 0,
    },
    plans: {
      active: activePlans || 0,
    },
    branches: {
      active: activeBranches.length || 0,
    },
  };
};

// ── Platform admin summary ─────────────────────────────────────────────────────
/**
 * Returns platform-wide aggregates for the admin reports view.
 * Runs entirely on Platform DB — no tenant DB access needed.
 */
const platformSummary = async () => {
  const today = new Date().toISOString().split('T')[0];
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString().split('T')[0];

  const [
    totalActiveGyms,
    totalPendingGyms,
    totalSuspendedGyms,
    gymsAddedThisMonth,
    totalActiveMembers,
    membersAddedThisMonth,
  ] = await Promise.all([
    Tenant.count({ where: { status: 'ACTIVE' } }),
    Tenant.count({ where: { status: 'PENDING_REVIEW' } }),
    Tenant.count({ where: { status: 'SUSPENDED' } }),
    Tenant.count({
      where: {
        status: 'ACTIVE',
        createdAt: { [Op.gte]: new Date(monthStart) },
      },
    }),
    UserGymMembership.count({ where: { status: SubscriptionStatus.ACTIVE } }),
    UserGymMembership.count({
      where: {
        status: SubscriptionStatus.ACTIVE,
        createdAt: { [Op.gte]: new Date(monthStart) },
      },
    }),
  ]);

  return {
    gyms: {
      active:          totalActiveGyms,
      pendingReview:   totalPendingGyms,
      suspended:       totalSuspendedGyms,
      addedThisMonth:  gymsAddedThisMonth,
    },
    members: {
      totalActive:      totalActiveMembers,
      addedThisMonth:   membersAddedThisMonth,
    },
  };
};

// ── Host dashboard with optional filters ───────────────────────────────────────
/**
 * Enhanced dashboard — accepts year/month/packageId/paymentMethod/paymentStatus
 * query filters for drill-down reporting.
 */
const hostDashboardFiltered = async (tenantDb, { year, month, packageId, paymentMethod, paymentStatus }) => {
  const { MemberSubscription, AttendanceLog, Payment, MembershipPlan } = tenantDb.models;

  const now = new Date();
  const y = parseInt(year) || now.getFullYear();
  const m = month ? parseInt(month) - 1 : now.getMonth(); // 0-indexed

  const periodStart = new Date(y, m, 1);
  const periodEnd   = new Date(y, m + 1, 0, 23, 59, 59); // last day of month

  const subWhere = { startDate: { [Op.between]: [periodStart.toISOString().split('T')[0], periodEnd.toISOString().split('T')[0]] } };
  if (packageId) subWhere.membershipPlanId = packageId;

  const payWhere = { paidAt: { [Op.between]: [periodStart, periodEnd] } };
  if (paymentMethod) payWhere.method = paymentMethod;
  if (paymentStatus) payWhere.status = paymentStatus;
  else payWhere.status = PaymentStatus.COMPLETED;

  const [newSubscriptions, periodRevenue, activeMembers, checkIns] = await Promise.all([
    MemberSubscription.count({ where: subWhere }),
    Payment.sum('amount', { where: payWhere }),
    MemberSubscription.count({ where: { status: SubscriptionStatus.ACTIVE } }),
    AttendanceLog.count({
      where: {
        checkInAt: { [Op.between]: [periodStart, periodEnd] },
        attendanceType: 'CHECK_IN',
      },
    }),
  ]);

  return {
    period: { year: y, month: m + 1 },
    newSubscriptions: newSubscriptions || 0,
    periodRevenue: parseFloat(periodRevenue || 0),
    activeMembers: activeMembers || 0,
    checkIns: checkIns || 0,
  };
};

// ── Monthly breakdown ──────────────────────────────────────────────────────────
/**
 * Detailed daily-granular breakdown for a given month.
 */
const monthlyBreakdown = async (tenantDb, { year, month }) => {
  const { Payment, MemberSubscription, AttendanceLog, sequelize } = tenantDb;
  const models = tenantDb.models;
  const seq = tenantDb.sequelize;

  const y = parseInt(year) || new Date().getFullYear();
  const m = parseInt(month) || new Date().getMonth() + 1;
  const periodStart = new Date(y, m - 1, 1);
  const periodEnd   = new Date(y, m, 0, 23, 59, 59);

  const [revenueByDay, subscriptionsByDay, checkInsByDay] = await Promise.all([
    models.Payment.findAll({
      attributes: [
        [seq.fn('DATE', seq.col('paid_at')), 'day'],
        [seq.fn('SUM', seq.col('amount')), 'totalRevenue'],
        [seq.fn('COUNT', seq.col('id')), 'count'],
      ],
      where: { status: PaymentStatus.COMPLETED, paidAt: { [Op.between]: [periodStart, periodEnd] } },
      group: [seq.fn('DATE', seq.col('paid_at'))],
      order: [[seq.fn('DATE', seq.col('paid_at')), 'ASC']],
      raw: true,
    }),
    models.MemberSubscription.findAll({
      attributes: [
        [seq.fn('DATE', seq.col('subscribed_at')), 'day'],
        [seq.fn('COUNT', seq.col('id')), 'count'],
      ],
      where: { subscribedAt: { [Op.between]: [periodStart, periodEnd] } },
      group: [seq.fn('DATE', seq.col('subscribed_at'))],
      raw: true,
    }),
    models.AttendanceLog.findAll({
      attributes: [
        [seq.fn('DATE', seq.col('check_in_at')), 'day'],
        [seq.fn('COUNT', seq.col('id')), 'count'],
      ],
      where: {
        attendanceType: 'CHECK_IN',
        checkInAt: { [Op.between]: [periodStart, periodEnd] },
      },
      group: [seq.fn('DATE', seq.col('check_in_at'))],
      raw: true,
    }),
  ]);

  return {
    period: { year: y, month: m },
    revenueByDay,
    subscriptionsByDay,
    checkInsByDay,
  };
};

// ── Yearly revenue by month ────────────────────────────────────────────────────
const yearlyRevenue = async (tenantDb, year) => {
  const seq = tenantDb.sequelize;
  const y = parseInt(year) || new Date().getFullYear();

  const rows = await tenantDb.models.Payment.findAll({
    attributes: [
      [seq.fn('MONTH', seq.col('paid_at')), 'month'],
      [seq.fn('SUM', seq.col('amount')), 'revenue'],
    ],
    where: {
      status: PaymentStatus.COMPLETED,
      paidAt: { [Op.between]: [new Date(y, 0, 1), new Date(y, 11, 31, 23, 59, 59)] },
    },
    group: [seq.fn('MONTH', seq.col('paid_at'))],
    order: [[seq.fn('MONTH', seq.col('paid_at')), 'ASC']],
    raw: true,
  });

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const data = MONTHS.map((month, i) => {
    const row = rows.find((r) => parseInt(r.month) === i + 1);
    return { month, revenue: parseFloat(row?.revenue || 0) };
  });

  return { year: y, data };
};

// ── Weekly attendance (last 7 days) ───────────────────────────────────────────
const weeklyAttendance = async (tenantDb) => {
  const seq = tenantDb.sequelize;
  const now = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split('T')[0]);
  }

  const rows = await tenantDb.models.AttendanceLog.findAll({
    attributes: [
      [seq.fn('DATE', seq.col('check_in_at')), 'day'],
      [seq.fn('COUNT', seq.col('id')), 'count'],
    ],
    where: {
      attendanceType: 'CHECK_IN',
      checkInAt: { [Op.gte]: new Date(`${days[0]}T00:00:00Z`) },
    },
    group: [seq.fn('DATE', seq.col('check_in_at'))],
    raw: true,
  });

  const LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const data = days.map((dateStr) => {
    const row = rows.find((r) => r.day === dateStr);
    const d = new Date(dateStr);
    return { day: LABELS[d.getDay()], date: dateStr, count: parseInt(row?.count || 0) };
  });

  return { data };
};

// ── Branch-level report ────────────────────────────────────────────────────────
/**
 * Returns KPIs scoped to a single branch: members, revenue, attendance, and plan distribution.
 */
const branchReport = async (tenantDb, branchId) => {
  const { MemberSubscription, AttendanceLog, Payment, MembershipPlan, GymStaff, Branch } = tenantDb.models;
  const seq = tenantDb.sequelize;
  const today = new Date().toISOString().split('T')[0];
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
  if (!branch) {
    const { createError } = require('../utils/response.utils');
    throw createError('Branch not found or has been deleted', 404);
  }

  const [
    activeMembers,
    frozenMembers,
    pendingMembers,
    expiredThisMonth,
    totalRevenue,
    revenueThisMonth,
    staffCollectedPending,
    pendingCount,
    checkInsToday,
    checkInsThisMonth,
    activeStaff,
    planDistribution,
    revenueByDay,
  ] = await Promise.all([
    MemberSubscription.count({ where: { branchId, status: SubscriptionStatus.ACTIVE } }),
    MemberSubscription.count({ where: { branchId, status: SubscriptionStatus.FROZEN } }),
    MemberSubscription.count({ where: { branchId, status: SubscriptionStatus.PENDING } }),
    MemberSubscription.count({
      where: {
        branchId,
        status: SubscriptionStatus.EXPIRED,
        endDate: { [Op.gte]: monthStart.toISOString().split('T')[0] },
      },
    }),
    Payment.sum('amount', { where: { branchId, status: PaymentStatus.COMPLETED } }),
    Payment.sum('amount', { where: { branchId, status: PaymentStatus.COMPLETED, paidAt: { [Op.gte]: monthStart } } }),
    Payment.count({ where: { branchId, status: PaymentStatus.STAFF_COLLECTED } }),
    Payment.count({ where: { branchId, status: PaymentStatus.PENDING } }),
    AttendanceLog.count({
      where: {
        branchId,
        attendanceType: 'CHECK_IN',
        checkInAt: { [Op.between]: [new Date(`${today}T00:00:00Z`), new Date(`${today}T23:59:59Z`)] },
      },
    }),
    AttendanceLog.count({
      where: {
        branchId,
        attendanceType: 'CHECK_IN',
        checkInAt: { [Op.gte]: monthStart },
      },
    }),
    GymStaff.count({ where: { branchId, employmentStatus: 'ACTIVE' } }),
    MemberSubscription.findAll({
      attributes: ['membershipPlanId', [seq.fn('COUNT', seq.col('id')), 'count']],
      where: { branchId, status: SubscriptionStatus.ACTIVE },
      group: ['membershipPlanId'],
      raw: true,
    }),
    Payment.findAll({
      attributes: [
        [seq.fn('DATE', seq.col('paid_at')), 'day'],
        [seq.fn('SUM', seq.col('amount')), 'totalRevenue'],
        [seq.fn('COUNT', seq.col('id')), 'count'],
      ],
      where: {
        branchId,
        status: PaymentStatus.COMPLETED,
        paidAt: { [Op.gte]: monthStart },
      },
      group: [seq.fn('DATE', seq.col('paid_at'))],
      order: [[seq.fn('DATE', seq.col('paid_at')), 'ASC']],
      raw: true,
    }),
  ]);

  // Enrich plan distribution with plan names
  const planIds = planDistribution.map((p) => p.membershipPlanId);
  const plans = planIds.length
    ? await MembershipPlan.findAll({ where: { id: planIds }, attributes: ['id', 'name'] })
    : [];
  const planMap = Object.fromEntries(plans.map((p) => [p.id, p.name]));

  return {
    branch: { id: branch.id, name: branch.branchName, status: branch.status },
    members: {
      active:           activeMembers   || 0,
      frozen:           frozenMembers   || 0,
      pending:          pendingMembers  || 0,
      expiredThisMonth: expiredThisMonth || 0,
    },
    revenue: {
      allTime:              parseFloat(totalRevenue      || 0),
      thisMonth:            parseFloat(revenueThisMonth  || 0),
      pendingCount:         pendingCount || 0,
      staffCollectedCount:  staffCollectedPending || 0,
    },
    attendance: {
      checkInsToday:     checkInsToday     || 0,
      checkInsThisMonth: checkInsThisMonth || 0,
    },
    staff: {
      active: activeStaff || 0,
    },
    planDistribution: planDistribution.map((p) => ({
      planId:   p.membershipPlanId,
      planName: planMap[p.membershipPlanId] || 'Unknown',
      count:    parseInt(p.count || 0),
    })),
    revenueByDay,
  };
};

module.exports = {
  hostDashboard,
  hostDashboardFiltered,
  monthlyBreakdown,
  platformSummary,
  yearlyRevenue,
  weeklyAttendance,
  branchReport,
};
