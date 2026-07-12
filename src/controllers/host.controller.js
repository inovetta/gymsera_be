const TenantDbManager = require('../database/TenantDbManager');
const { Tenant, TenantSubscription, PlatformPackage, GymListing, User } = require('../models/platform');
const { sendSuccess, createError } = require('../utils/response.utils');
const { Op } = require('sequelize');

const getTodaySummary = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;

    if (!tenantId) {
      return sendSuccess(res, {
        state: 'A',
        applicationStatus: 'DRAFT',
        hasActiveBranch: false
      });
    }

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant || tenant.status === 'DRAFT') {
      return sendSuccess(res, {
        state: 'A',
        applicationStatus: 'DRAFT',
        hasActiveBranch: false
      });
    }

    if (tenant.status === 'PENDING_REVIEW' || tenant.status === 'UNDER_REVIEW' || tenant.status === 'REJECTED') {
      return sendSuccess(res, {
        state: 'B',
        applicationStatus: tenant.status,
        hasActiveBranch: false
      });
    }

    // ACTIVE status: connect to tenant DB
    let tenantDb;
    try {
      tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
    } catch (err) {
      // If db connection fails, e.g. not fully provisioned yet, treat as State B
      return sendSuccess(res, {
        state: 'B',
        applicationStatus: 'APPROVED',
        hasActiveBranch: false
      });
    }

    const { Branch, AttendanceLog, Payment, MemberSubscription, MembershipPlan } = tenantDb.models;

    const activeBranchesCount = await Branch.count({ where: { status: 'ACTIVE' } });
    if (activeBranchesCount === 0) {
      return sendSuccess(res, {
        state: 'B',
        applicationStatus: 'APPROVED',
        hasActiveBranch: false
      });
    }

    // State C: Approved & active
    const todayStr = new Date().toISOString().split('T')[0];
    const startOfDay = new Date(`${todayStr}T00:00:00.000Z`);
    const endOfDay = new Date(`${todayStr}T23:59:59.999Z`);

    // 1. Todays check-ins count
    const todaysCheckins = await AttendanceLog.count({
      where: {
        checkInAt: { [Op.between]: [startOfDay, endOfDay] },
        attendanceType: 'CHECK_IN'
      }
    });

    // 2. This Month Revenue
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const revenueSum = await Payment.sum('amount', {
      where: {
        status: 'COMPLETED',
        paidAt: { [Op.gte]: startOfMonth }
      }
    });
    const monthlyRevenue = parseFloat(revenueSum || 0);

    // 3. Active Members (count)
    const activeMembers = await MemberSubscription.count({
      where: { status: 'ACTIVE' }
    });

    // 4. New Subs (this period / last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const newSubs = await MemberSubscription.count({
      where: {
        status: 'ACTIVE',
        subscribedAt: { [Op.gte]: sevenDaysAgo }
      }
    });

    // 5. Weekly Performance chart (last 7 days, per-day aggregate)
    const weeklyPerformance = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(todayStr);
      dayStart.setDate(dayStart.getDate() - i);
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);
      const dayName = dayStart.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
      const dayCheckins = await AttendanceLog.count({
        where: {
          checkInAt: { [Op.between]: [dayStart, dayEnd] },
          attendanceType: 'CHECK_IN'
        }
      });
      weeklyPerformance.push({ day: dayName, count: dayCheckins });
    }

    // 6. Membership inquiries unanswered: mock 1
    const unansweredInquiries = 1;

    // 7. Recent Check-ins list (last 10 checkins)
    const logs = await AttendanceLog.findAll({
      where: { attendanceType: 'CHECK_IN' },
      order: [['checkInAt', 'DESC']],
      limit: 10
    });

    const recentCheckins = [];
    const userIds = [...new Set(logs.map((log) => log.userId))];

    if (userIds.length > 0) {
      const users = await User.findAll({
        where: { id: { [Op.in]: userIds } },
        attributes: ['id', 'fullName', 'profileImageUrl']
      });
      const userMap = new Map(users.map((u) => [u.id, u]));

      for (const log of logs) {
        const u = userMap.get(log.userId);
        let planName = 'Daily Pass';
        if (log.memberSubscriptionId) {
          const sub = await MemberSubscription.findByPk(log.memberSubscriptionId, {
            include: [{ model: MembershipPlan, as: 'plan', attributes: ['name'] }]
          });
          if (sub && sub.plan) {
            planName = sub.plan.name;
          }
        }

        recentCheckins.push({
          id: log.id,
          name: u ? u.fullName : 'Unknown Athlete',
          time: log.checkInAt,
          passType: planName,
          status: 'ACTIVE'
        });
      }
    }

    return sendSuccess(res, {
      state: 'C',
      applicationStatus: tenant.status,
      hasActiveBranch: true,
      todaysCheckins,
      monthlyRevenue,
      activeMembers,
      newSubs,
      weeklyPerformance,
      unansweredInquiries,
      recentCheckins
    });
  } catch (err) {
    next(err);
  }
};

const getBranchQuota = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      return sendSuccess(res, {
        maxBranches: 1,
        usedBranches: 0,
        remainingBranches: 1
      });
    }

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) throw createError('Tenant not found', 404);

    let maxBranches = 1;
    const activeSub = await TenantSubscription.findOne({
      where: { tenantId, status: 'ACTIVE' },
      include: [{ model: PlatformPackage, as: 'package', attributes: ['maxBranches'] }]
    });

    if (activeSub && activeSub.package) {
      maxBranches = activeSub.package.maxBranches;
    } else if (tenant.selectedPackageId) {
      const pkg = await PlatformPackage.findByPk(tenant.selectedPackageId);
      if (pkg) maxBranches = pkg.maxBranches;
    }

    let usedBranches = 0;
    if (tenant.status === 'ACTIVE' && tenant.connectionStringEncrypted) {
      try {
        const tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
        usedBranches = await tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } });
      } catch (err) {
        // ignore
      }
    }

    const remainingBranches = Math.max(0, maxBranches - usedBranches);

    return sendSuccess(res, {
      maxBranches,
      usedBranches,
      remainingBranches
    });
  } catch (err) {
    next(err);
  }
};

const getListings = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      return sendSuccess(res, []);
    }

    // Return all listings (any status) so hosts see PENDING/INACTIVE listings too
    const listings = await GymListing.findAll({
      where: { tenantId },
      order: [['updated_at', 'DESC']]
    });

    return sendSuccess(res, listings);
  } catch (err) {
    next(err);
  }
};

const createListing = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) throw createError('Tenant not found', 404);

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) throw createError('Tenant not found', 404);

    // Only ACTIVE tenants (admin-approved) may create additional listings
    if (tenant.status !== 'ACTIVE') {
      const statusMsg = {
        PENDING_REVIEW: 'Your gym listing is currently under review. You can add a new listing once the admin approves your current application.',
        UNDER_REVIEW: 'Your gym listing is currently under review. You can add a new listing once the admin approves your current application.',
        DRAFT: 'Please complete your gym onboarding first before creating additional listings.',
        REJECTED: 'Your previous application was rejected. Please contact support.',
      };
      throw createError(
        statusMsg[tenant.status] || 'Cannot create listing at this stage.',
        400
      );
    }

    const { gymName, gymDescription, genderType, cityId, areaId, logoUrl, coverImageUrl, contactPhone, latitude, longitude } = req.body;
    if (!gymName) throw createError('gymName is required', 400);
    if (!cityId) throw createError('cityId is required', 400);

    const listing = await GymListing.create({
      tenantId,
      cityId,
      areaId: areaId || null,
      title: gymName,
      shortDescription: gymDescription || null,
      genderType: genderType || 'MIXED',
      logoUrl: logoUrl || tenant.logoUrl || null,
      coverImageUrl: coverImageUrl || tenant.coverImageUrl || null,
      contactPhone: contactPhone || tenant.phone || null,
      latitude: latitude || null,
      longitude: longitude || null,
      status: 'PENDING',
    });

    return sendSuccess(res, listing, 201);
  } catch (err) {
    next(err);
  }
};

const getCurrentSubscription = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) throw createError('Tenant not found', 404);

    let subscription = await TenantSubscription.findOne({
      where: { tenantId, status: 'ACTIVE' },
      include: [{ model: PlatformPackage, as: 'package' }]
    });

    if (!subscription) {
      const tenant = await Tenant.findByPk(tenantId);
      if (tenant && tenant.selectedPackageId) {
        const pkg = await PlatformPackage.findByPk(tenant.selectedPackageId);
        if (pkg) {
          subscription = await TenantSubscription.create({
            tenantId,
            platformPackageId: pkg.id,
            startDate: new Date().toISOString().split('T')[0],
            endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            amount: pkg.price,
            billingCycle: pkg.billingCycle || 'MONTHLY',
            status: 'ACTIVE',
            autoRenew: true,
            paymentStatus: 'PAID'
          });
          subscription = await TenantSubscription.findByPk(subscription.id, {
            include: [{ model: PlatformPackage, as: 'package' }]
          });
        }
      }
    }

    if (!subscription) {
      throw createError('No active subscription found', 404);
    }

    return sendSuccess(res, subscription);
  } catch (err) {
    next(err);
  }
};

const upgradeSubscription = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) throw createError('Tenant not found', 404);

    const { planId } = req.body;
    if (!planId) throw createError('planId is required', 400);

    const pkg = await PlatformPackage.findByPk(planId);
    if (!pkg) throw createError('Subscription plan package not found', 404);

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) throw createError('Tenant not found', 404);

    // Cancel existing subscriptions
    await TenantSubscription.update(
      { status: 'CANCELLED' },
      { where: { tenantId, status: 'ACTIVE' } }
    );

    // Create new active subscription
    const start = new Date();
    const end = new Date(start);
    const cycle = pkg.billingCycle || 'MONTHLY';
    if (cycle === 'MONTHLY') end.setMonth(end.getMonth() + 1);
    else if (cycle === 'QUARTERLY') end.setMonth(end.getMonth() + 3);
    else if (cycle === 'YEARLY') end.setFullYear(end.getFullYear() + 1);

    const newSub = await TenantSubscription.create({
      tenantId,
      platformPackageId: pkg.id,
      startDate: start.toISOString().split('T')[0],
      endDate: end.toISOString().split('T')[0],
      amount: pkg.price,
      billingCycle: cycle,
      status: 'ACTIVE',
      autoRenew: true,
      paymentStatus: 'PAID'
    });

    // Also update tenant package selection
    await tenant.update({ selectedPackageId: pkg.id });

    const subscription = await TenantSubscription.findByPk(newSub.id, {
      include: [{ model: PlatformPackage, as: 'package' }]
    });

    return sendSuccess(res, subscription, 'Subscription upgraded successfully');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getTodaySummary,
  getBranchQuota,
  getListings,
  createListing,
  getCurrentSubscription,
  upgradeSubscription
};
