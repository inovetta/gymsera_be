const TenantDbManager = require('../database/TenantDbManager');
const { Tenant, TenantSubscription, PlatformPackage, GymListing, User } = require('../models/platform');
const { sendSuccess, createError, buildPagination } = require('../utils/response.utils');
const { Op } = require('sequelize');
const gymService = require('../services/gym.service');
const inboxService = require('../services/inbox.service');
const { SubscriptionStatus } = require('../constants/subscription-status');

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

    const { Branch, AttendanceLog, Payment, MemberSubscription, MembershipPlan, Expense } = tenantDb.models;

    const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
    const activeBranchIds = activeBranches.map((b) => b.id);
    if (activeBranchIds.length === 0) {
      return sendSuccess(res, {
        state: 'C',
        applicationStatus: 'APPROVED',
        hasActiveBranch: false,
        activeBranchesCount: 0,
        todaysCheckins: 0,
        monthlyRevenue: 0,
        grossRevenue: 0,
        totalExpenses: 0,
        netProfit: 0,
        activeMembers: 0,
        newSubs: 0,
        recentCheckins: [],
        weeklyPerformance: [
          { day: 'MON', count: 0 },
          { day: 'TUE', count: 0 },
          { day: 'WED', count: 0 },
          { day: 'THU', count: 0 },
          { day: 'FRI', count: 0 },
          { day: 'SAT', count: 0 },
          { day: 'SUN', count: 0 },
        ],
      });
    }

    // State C: Approved & active with at least 1 branch
    const branchFilter = { branchId: { [Op.in]: activeBranchIds } };
    const todayStr = new Date().toISOString().split('T')[0];
    const startOfDay = new Date(`${todayStr}T00:00:00.000Z`);
    const endOfDay = new Date(`${todayStr}T23:59:59.999Z`);

    // 1. Todays check-ins count
    const todaysCheckins = await AttendanceLog.count({
      where: {
        ...branchFilter,
        checkInAt: { [Op.between]: [startOfDay, endOfDay] },
        attendanceType: 'CHECK_IN'
      }
    });

    // 2. This Month Revenue & Expenses
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const revenueSum = await Payment.sum('amount', {
      where: {
        ...branchFilter,
        status: 'COMPLETED',
        paidAt: { [Op.gte]: startOfMonth }
      }
    });
    const monthlyRevenue = parseFloat(revenueSum || 0);
    const grossRevenue = monthlyRevenue;

    let totalExpenses = 0;
    if (Expense) {
      const startOfMonthStr = startOfMonth.toISOString().split('T')[0];
      const expenseSum = await Expense.sum('amount', {
        where: {
          ...branchFilter,
          status: 'approved',
          expenseDate: { [Op.gte]: startOfMonthStr }
        }
      });
      totalExpenses = parseFloat(expenseSum || 0);
    }
    const netProfit = grossRevenue - totalExpenses;

    // 3. Active Members (distinct member count)
    const activeMembers = await MemberSubscription.count({
      where: {
        ...branchFilter,
        status: 'ACTIVE'
      },
      distinct: true,
      col: 'userId'
    });

    // 4. New Subs (this period / last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const newSubs = await MemberSubscription.count({
      where: {
        ...branchFilter,
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
          ...branchFilter,
          checkInAt: { [Op.between]: [dayStart, dayEnd] },
          attendanceType: 'CHECK_IN'
        }
      });
      weeklyPerformance.push({ day: dayName, count: dayCheckins });
    }

    // 6. Membership inquiries unanswered: query platform database
    let pendingInquiries = 0;
    try {
      pendingInquiries = await inboxService.countPendingInquiries(tenantId);
    } catch (e) {
      pendingInquiries = 0;
    }

    return sendSuccess(res, {
      state: 'C',
      applicationStatus: 'APPROVED',
      hasActiveBranch: true,
      activeBranchesCount: activeBranches.length,
      todaysCheckins,
      monthlyRevenue,
      grossRevenue,
      totalExpenses,
      netProfit,
      activeMembers,
      newSubs,
      weeklyPerformance,
      pendingInquiries,
    });
  } catch (err) {
    next(err);
  }
};

const getBranchQuota = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { organizationId } = req.query;

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
        if (organizationId) {
          usedBranches = await tenantDb.models.Branch.count({
            where: {
              status: 'ACTIVE',
              gymListingId: organizationId,
            }
          });
        } else {
          usedBranches = await tenantDb.models.Branch.count({
            where: { status: 'ACTIVE' }
          });
        }
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

const getOrganizationQuota = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      return sendSuccess(res, {
        maxOrganizations: 1,
        usedOrganizations: 0,
        remainingOrganizations: 1,
        canCreateNext: true,
        blockingListingStatus: null,
      });
    }

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) throw createError('Tenant not found', 404);

    let maxOrganizations = 1;
    const activeSub = await TenantSubscription.findOne({
      where: { tenantId, status: 'ACTIVE' },
      include: [{ model: PlatformPackage, as: 'package', attributes: ['maxOrganizations'] }]
    });

    if (activeSub && activeSub.package) {
      maxOrganizations = activeSub.package.maxOrganizations || 1;
    } else if (tenant.selectedPackageId) {
      const pkg = await PlatformPackage.findByPk(tenant.selectedPackageId);
      if (pkg) maxOrganizations = pkg.maxOrganizations || 1;
    }

    const allListings = await GymListing.findAll({
      where: {
        tenantId,
        status: { [Op.ne]: 'INACTIVE' }
      },
      attributes: ['id', 'status'],
      order: [['created_at', 'ASC']],
    });

    let usedOrganizations = allListings.length;
    let canCreateNext = true;
    let blockingListingStatus = null;

    if (tenant.status !== 'ACTIVE') {
      // First organization is in draft/review state (no listing record in DB yet)
      usedOrganizations = Math.max(1, allListings.length);
      canCreateNext = false;
      if (tenant.status === 'DRAFT') {
        blockingListingStatus = 'draft';
      } else if (tenant.status === 'PENDING_REVIEW' || tenant.status === 'UNDER_REVIEW') {
        blockingListingStatus = 'under_review';
      } else if (tenant.status === 'REJECTED') {
        blockingListingStatus = 'rejected';
      }
    } else {
      // Tenant is active, check the GymListing records
      const blockingListing = allListings.find(
        (l) => l.status === 'DRAFT' || l.status === 'PENDING'
      );
      canCreateNext = !blockingListing && (maxOrganizations - usedOrganizations) > 0;
      if (blockingListing) {
        blockingListingStatus = blockingListing.status === 'DRAFT' ? 'draft' : 'under_review';
      }
    }

    const remainingOrganizations = Math.max(0, maxOrganizations - usedOrganizations);

    return sendSuccess(res, {
      maxOrganizations,
      usedOrganizations,
      remainingOrganizations,
      canCreateNext,
      blockingListingStatus,
      blockingOrganizationStatus: blockingListingStatus,
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

    const platformTx = await Tenant.sequelize.transaction();
    try {
      // Lock tenant row in platform DB to serialize creations
      const tenant = await Tenant.findByPk(tenantId, {
        lock: true,
        transaction: platformTx,
      });
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

      // Check organization quota and sequential approval gate
      let maxOrganizations = 1;
      const activeSub = await TenantSubscription.findOne({
        where: { tenantId, status: 'ACTIVE' },
        include: [{ model: PlatformPackage, as: 'package', attributes: ['maxOrganizations'] }],
        transaction: platformTx,
      });

      if (activeSub && activeSub.package) {
        maxOrganizations = activeSub.package.maxOrganizations || 1;
      } else if (tenant.selectedPackageId) {
        const pkg = await PlatformPackage.findByPk(tenant.selectedPackageId, {
          transaction: platformTx,
        });
        if (pkg) maxOrganizations = pkg.maxOrganizations || 1;
      }

      const existingListings = await GymListing.findAll({
        where: {
          tenantId,
          status: { [Op.ne]: 'INACTIVE' },
        },
        attributes: ['id', 'status'],
        transaction: platformTx,
      });

      // Sequential gate: block if any listing is DRAFT or PENDING
      const blockingListing = existingListings.find(
        (l) => l.status === 'DRAFT' || l.status === 'PENDING'
      );
      if (blockingListing) {
        const msg = blockingListing.status === 'DRAFT'
          ? 'Please complete and submit your current organization setup before creating a new one.'
          : 'Your previous organization is currently under review. You can create a new one once it is approved.';
        const err = createError(msg, 403);
        err.code = 'approval_pending';
        throw err;
      }

      if (existingListings.length >= maxOrganizations) {
        const err = createError('Organization limit reached', 403);
        err.code = 'organization_limit_reached';
        throw err;
      }

      const { gymName, gymDescription, genderType, cityId, areaId, logoUrl, coverImageUrl, contactPhone, latitude, longitude } = req.body;
      if (!gymName) throw createError('gymName is required', 400);

      const targetCityId = cityId || tenant.cityId;
      if (!targetCityId) throw createError('cityId is required', 400);

      const listing = await GymListing.create({
        tenantId,
        cityId: targetCityId,
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
      }, { transaction: platformTx });

      // Create matching Gym row in the tenant DB
      await req.tenantDb.models.Gym.create({
        name: gymName,
        description: gymDescription || null,
        contactPhone: contactPhone || tenant.phone || null,
        genderType: genderType || 'MIXED',
        logoUrl: logoUrl || tenant.logoUrl || null,
        coverImageUrl: coverImageUrl || tenant.coverImageUrl || null,
        gymListingId: listing.id,
      });

      await platformTx.commit();
      return sendSuccess(res, listing, 'Listing created successfully', 201);
    } catch (err) {
      await platformTx.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
};

const updateListing = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) throw createError('Tenant not found', 404);

    const { id } = req.params;
    if (!id) throw createError('Organization ID is required', 400);

    const listing = await GymListing.findOne({
      where: { id, tenantId }
    });

    if (!listing) {
      throw createError('Organization not found or access denied', 404);
    }

    const { gymName, gymDescription, genderType, cityId, areaId, logoUrl, coverImageUrl, contactPhone, latitude, longitude } = req.body;

    const updates = {};
    if (gymName !== undefined) updates.title = gymName;
    if (gymDescription !== undefined) updates.shortDescription = gymDescription;
    if (genderType !== undefined) updates.genderType = genderType;
    if (cityId !== undefined) updates.cityId = cityId;
    if (areaId !== undefined) updates.areaId = areaId || null;
    if (logoUrl !== undefined) updates.logoUrl = logoUrl || null;
    if (coverImageUrl !== undefined) updates.coverImageUrl = coverImageUrl || null;
    if (contactPhone !== undefined) updates.contactPhone = contactPhone || null;
    if (latitude !== undefined) updates.latitude = latitude || null;
    if (longitude !== undefined) updates.longitude = longitude || null;

    await listing.update(updates);

    // Update corresponding Gym in tenant DB
    const gym = await req.tenantDb.models.Gym.findOne({
      where: { gymListingId: listing.id }
    });
    if (gym) {
      const gymUpdates = {};
      if (gymName !== undefined) gymUpdates.name = gymName;
      if (gymDescription !== undefined) gymUpdates.description = gymDescription;
      if (genderType !== undefined) gymUpdates.genderType = genderType;
      if (contactPhone !== undefined) gymUpdates.contactPhone = contactPhone || null;
      if (logoUrl !== undefined) gymUpdates.logoUrl = logoUrl || null;
      if (coverImageUrl !== undefined) gymUpdates.coverImageUrl = coverImageUrl || null;
      await gym.update(gymUpdates);
    }

    return sendSuccess(res, listing, 'Organization updated successfully');
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

const getBranchDashboard = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { Branch, AttendanceLog, Payment, MemberSubscription, MembershipPlan, Expense } = req.tenantDb.models;

    const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
    if (!branch) {
      throw createError('Branch not found or has been deleted', 404);
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const startOfDay = new Date(`${todayStr}T00:00:00.000Z`);
    const endOfDay = new Date(`${todayStr}T23:59:59.999Z`);

    const todaysCheckins = await AttendanceLog.count({
      where: {
        branchId,
        checkInAt: { [Op.between]: [startOfDay, endOfDay] },
        attendanceType: 'CHECK_IN'
      }
    });

    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const revenueSum = await Payment.sum('amount', {
      where: {
        branchId,
        status: 'COMPLETED',
        paidAt: { [Op.gte]: startOfMonth }
      }
    });
    const monthlyRevenue = parseFloat(revenueSum || 0);
    const grossRevenue = monthlyRevenue;

    let totalExpenses = 0;
    if (Expense) {
      const startOfMonthStr = startOfMonth.toISOString().split('T')[0];
      const expenseSum = await Expense.sum('amount', {
        where: {
          branchId,
          status: 'approved',
          expenseDate: { [Op.gte]: startOfMonthStr }
        }
      });
      totalExpenses = parseFloat(expenseSum || 0);
    }
    const netProfit = grossRevenue - totalExpenses;

    const activeMembers = await MemberSubscription.count({
      where: { branchId, status: 'ACTIVE' },
      distinct: true,
      col: 'userId'
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const newSubs = await MemberSubscription.count({
      where: {
        branchId,
        status: 'ACTIVE',
        subscribedAt: { [Op.gte]: sevenDaysAgo }
      }
    });

    const weeklyPerformance = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(todayStr);
      dayStart.setDate(dayStart.getDate() - i);
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);
      const dayName = dayStart.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
      const dayCheckins = await AttendanceLog.count({
        where: {
          branchId,
          checkInAt: { [Op.between]: [dayStart, dayEnd] },
          attendanceType: 'CHECK_IN'
        }
      });
      weeklyPerformance.push({ day: dayName, count: dayCheckins });
    }

    const logs = await AttendanceLog.findAll({
      where: { branchId, attendanceType: 'CHECK_IN' },
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
      todaysCheckins,
      monthlyRevenue,
      grossRevenue,
      totalExpenses,
      netProfit,
      activeMembers,
      newSubs,
      weeklyPerformance,
      recentCheckins
    });
  } catch (err) {
    next(err);
  }
};

const getBranchMembers = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { q, status, page = 1, limit = 20 } = req.query;
    const { Branch, MemberSubscription, MembershipPlan } = req.tenantDb.models;

    const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
    if (!branch) {
      throw createError('Branch not found or has been deleted', 404);
    }

    const subWhere = { branchId };
    if (status) {
      subWhere.status = status;
    }

    let matchingUserIds = [];
    if (q) {
      const users = await User.findAll({
        where: {
          role: 'MEMBER',
          [Op.or]: [
            { fullName: { [Op.like]: `%${q}%` } },
            { email: { [Op.like]: `%${q}%` } },
            { phone: { [Op.like]: `%${q}%` } }
          ]
        },
        attributes: ['id']
      });
      matchingUserIds = users.map(u => u.id);
      if (matchingUserIds.length === 0) {
        return sendSuccess(res, { users: [], pagination: buildPagination(0, page, limit) });
      }
      subWhere.userId = { [Op.in]: matchingUserIds };
    }

    const offset = (page - 1) * limit;

    const { count, rows: subs } = await MemberSubscription.findAndCountAll({
      where: subWhere,
      include: [{ model: MembershipPlan, as: 'plan', attributes: ['name'] }],
      order: [['updatedAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
      distinct: true
    });

    const userIds = [...new Set(subs.map(s => s.userId))];
    const users = userIds.length
      ? await User.findAll({
        where: { id: { [Op.in]: userIds } },
        attributes: ['id', 'fullName', 'email', 'phone', 'role', 'status', 'isVerified', 'profileImageUrl', 'createdAt']
      })
      : [];

    const userMap = new Map(users.map(u => [u.id, u.toJSON()]));

    const usersList = [];
    const seenUserIds = new Set();
    for (const sub of subs) {
      if (seenUserIds.has(sub.userId)) continue;
      seenUserIds.add(sub.userId);
      const u = userMap.get(sub.userId);
      if (u) {
        usersList.push({
          ...u,
          status: sub.status === 'ACTIVE' ? 'ACTIVE' : (sub.status || u.status),
          planName: sub.plan ? sub.plan.name : 'Daily Pass',
          endDate: sub.endDate,
          subscriptionStatus: sub.status
        });
      }
    }

    return sendSuccess(res, {
      users: usersList,
      pagination: buildPagination(count, page, limit)
    });
  } catch (err) {
    next(err);
  }
};

const getBranchCheckins = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { page = 1, limit = 20, date } = req.query;
    const { Branch, AttendanceLog, MemberSubscription, MembershipPlan } = req.tenantDb.models;

    const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
    if (!branch) {
      throw createError('Branch not found or has been deleted', 404);
    }

    // Build the where clause — optionally filter by a specific date
    const logWhere = { branchId, attendanceType: 'CHECK_IN' };
    if (date) {
      const dayStart = new Date(`${date}T00:00:00.000Z`);
      const dayEnd = new Date(`${date}T23:59:59.999Z`);
      logWhere.checkInAt = { [Op.between]: [dayStart, dayEnd] };
    }

    const offset = (page - 1) * limit;

    const { count, rows: logs } = await AttendanceLog.findAndCountAll({
      where: logWhere,
      order: [['checkInAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    const userIds = [...new Set(logs.map(l => l.userId))];
    const users = userIds.length
      ? await User.findAll({
        where: { id: { [Op.in]: userIds } },
        attributes: ['id', 'fullName', 'profileImageUrl']
      })
      : [];
    const userMap = new Map(users.map(u => [u.id, u.toJSON()]));

    const logsList = [];
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

      logsList.push({
        id: log.id,
        createdAt: log.checkInAt,
        userName: u ? u.fullName : 'Unknown Athlete',
        planName,
        user: u
      });
    }

    return sendSuccess(res, {
      logs: logsList,
      pagination: buildPagination(count, page, limit)
    });
  } catch (err) {
    next(err);
  }
};

const getBranchAnnouncements = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { Branch, Announcement } = req.tenantDb.models;

    const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
    if (!branch) {
      throw createError('Branch not found or has been deleted', 404);
    }

    const announcements = await Announcement.findAll({
      where: { branchId },
      order: [['createdAt', 'DESC']]
    });

    return sendSuccess(res, announcements);
  } catch (err) {
    next(err);
  }
};

const createBranchAnnouncement = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { title, message, tag, status } = req.body;
    const { Branch, Announcement } = req.tenantDb.models;

    const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
    if (!branch) {
      throw createError('Branch not found or has been deleted', 404);
    }

    const announcement = await Announcement.create({
      branchId,
      title,
      message,
      tag: tag || 'SENT TO ALL MEMBERS',
      status: status || 'sent',
      createdBy: req.user.id
    });

    return sendSuccess(res, announcement, 'Announcement posted successfully');
  } catch (err) {
    next(err);
  }
};

const deleteBranchAnnouncement = async (req, res, next) => {
  try {
    const { branchId, announcementId } = req.params;
    const { Branch, Announcement } = req.tenantDb.models;

    const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
    if (!branch) {
      throw createError('Branch not found or has been deleted', 404);
    }

    const announcement = await Announcement.findOne({ where: { id: announcementId, branchId } });
    if (!announcement) {
      throw createError('Announcement not found', 404);
    }

    await announcement.destroy();

    return sendSuccess(res, null, 'Announcement deleted successfully');
  } catch (err) {
    next(err);
  }
};

const getBranchSchedule = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { Branch, ClassSchedule } = req.tenantDb.models;

    const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
    if (!branch) {
      throw createError('Branch not found or has been deleted', 404);
    }

    const schedule = await ClassSchedule.findAll({
      where: { branchId },
      order: [['createdAt', 'DESC']]
    });

    return sendSuccess(res, schedule);
  } catch (err) {
    next(err);
  }
};

const createBranchSchedule = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { name, instructor, time, day, maxCapacity } = req.body;
    const { Branch, ClassSchedule } = req.tenantDb.models;

    const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
    if (!branch) {
      throw createError('Branch not found or has been deleted', 404);
    }

    const cls = await ClassSchedule.create({
      branchId,
      name,
      instructor,
      time,
      day,
      maxCapacity: maxCapacity || 20,
      currentCapacity: 0
    });

    return sendSuccess(res, cls, 'Class scheduled successfully');
  } catch (err) {
    next(err);
  }
};

const lookupBranchMember = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { email } = req.query;

    if (!email) {
      return res.status(422).json({ success: false, message: 'Email query parameter is required' });
    }

    const { MemberSubscription } = req.tenantDb.models;

    // 1. Check globally if user exists
    const user = await User.findOne({ where: { email: email.toLowerCase().trim() } });
    if (!user) {
      return sendSuccess(res, { exists: false });
    }

    // 2. Check if they have subscription in this branch
    const subscription = await MemberSubscription.findOne({
      where: {
        userId: user.id,
        branchId,
        status: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PENDING, SubscriptionStatus.FROZEN],
      },
    });

    if (subscription) {
      return sendSuccess(res, {
        exists: true,
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          phone: user.phone || null,
          status: subscription.status,
        },
      });
    }

    // Exist globally, but not subscribed in this branch
    return sendSuccess(res, {
      exists: false,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone || null,
      },
    });
  } catch (err) {
    next(err);
  }
};

const createBranchMember = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const result = await gymService.enrollMember(
      req.tenantDb,
      req.user.tenantId,
      { ...req.body, branchId },
      req.user
    );
    return sendSuccess(res, result, 'Member enrolled successfully', 201);
  } catch (err) {
    next(err);
  }
};

const resubmitBranchReview = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { Branch, BranchVisibilityHistory } = req.tenantDb.models;

    const branch = await Branch.findByPk(branchId);
    if (!branch) {
      throw createError('Branch not found', 404);
    }

    await branch.update({
      travelerVisibilityStatus: 'pending',
      deactivationReason: null,
      deactivatedAt: null,
      deactivatedBy: null,
    });

    if (BranchVisibilityHistory) {
      await BranchVisibilityHistory.create({
        branchId,
        status: 'pending',
        reason: 'Resubmitted by host',
        changedBy: req.user.id,
        changedAt: new Date(),
      });
    }

    return sendSuccess(res, { branch }, 'Branch listing resubmitted for review.');
  } catch (err) {
    next(err);
  }
};

const listInquiries = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      return sendSuccess(res, [], 'No inquiries found');
    }
    const inquiries = await inboxService.listInquiries(tenantId);
    return sendSuccess(res, inquiries, 'Inquiries retrieved');
  } catch (err) {
    next(err);
  }
};

const getInquiryDetail = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { inquiryId } = req.params;
    const result = await inboxService.getInquiryDetail(inquiryId, tenantId);
    return sendSuccess(res, result, 'Inquiry details retrieved');
  } catch (err) {
    next(err);
  }
};

const replyToInquiry = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { inquiryId } = req.params;
    const { text } = req.body;
    if (!text || !text.trim()) {
      throw createError('Message text is required', 400);
    }
    const message = await inboxService.replyToInquiry(inquiryId, req.user.id, text.trim(), tenantId);
    return sendSuccess(res, message, 'Reply sent successfully', 201);
  } catch (err) {
    next(err);
  }
};

const markInquiryRead = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { inquiryId } = req.params;
    const result = await inboxService.markInquiryRead(inquiryId, tenantId);
    return sendSuccess(res, result, 'Inquiry marked as read');
  } catch (err) {
    next(err);
  }
};

const findOrCreateConversation = async (req, res, next) => {
  try {
    const { userId, branchId, initialMessage } = req.body;
    if (!userId) {
      throw createError('userId is required to start a conversation', 400);
    }
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      throw createError('Tenant not found for host', 404);
    }
    const conversation = await inboxService.findOrCreateHostConversation(
      tenantId,
      userId,
      branchId,
      initialMessage
    );
    return sendSuccess(res, conversation, 'Conversation ready', 200);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getTodaySummary,
  getBranchQuota,
  getOrganizationQuota,
  getListings,
  createListing,
  updateListing,
  getCurrentSubscription,
  upgradeSubscription,
  getBranchDashboard,
  getBranchMembers,
  getBranchCheckins,
  getBranchAnnouncements,
  createBranchAnnouncement,
  deleteBranchAnnouncement,
  getBranchSchedule,
  createBranchSchedule,
  lookupBranchMember,
  createBranchMember,
  resubmitBranchReview,
  listInquiries,
  getInquiryDetail,
  replyToInquiry,
  markInquiryRead,
  findOrCreateConversation,
};
