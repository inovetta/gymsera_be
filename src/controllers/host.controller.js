const TenantDbManager = require('../database/TenantDbManager');
const { Tenant, TenantSubscription, GymListing, User } = require('../models/platform');
const { sendSuccess, createError, buildPagination } = require('../utils/response.utils');
const { likeContains } = require('../utils/sql-like');
const { Op } = require('sequelize');
const gymService = require('../services/gym.service');
const attendanceService = require('../services/attendance.service');
const inboxService = require('../services/inbox.service');
const accessService = require('../services/access.service');
const subscriptionQuotaService = require('../services/subscription-quota.service');
const branchQuotaService = require('../services/branch-quota.service');
const hostStatusService = require('../services/host-status.service');
const subscriptionMigrationService = require('../services/subscription-migration.service');
const storageService = require('../services/storage.service');
const authService = require('../services/auth.service');
const { SubscriptionStatus } = require('../constants/subscription-status');
const { hasBranchAccess } = require('../utils/branchAccess.utils');
const { computeBusinessDate } = require('../services/ledger.service');
const { businessDayRange, startOfBusinessDay, monthStartOf, addDays } = require('../utils/business-date.utils');

/**
 * Check-ins per day for the 7 business days ending at `todayStr`, days cut at the branch's local midnight
 * (GLB-01). `where` is the branch filter. The label is the weekday of the business date itself.
 */
const _weeklyCheckins = async (AttendanceLog, where, todayStr, timezone) => {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const dateStr = addDays(todayStr, -i);
    const { start, end } = businessDayRange(dateStr, timezone);
    const count = await AttendanceLog.count({
      where: { ...where, checkInAt: { [Op.gte]: start, [Op.lt]: end }, attendanceType: 'CHECK_IN' },
    });
    const day = new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).toUpperCase();
    out.push({ day, count });
  }
  return out;
};


/**
 * GET /host/status — where the caller stands as a host (Phase 7 P2). Only
 * `authenticate`: the answer is about the gym the caller owns, found by ownership,
 * so a token issued before they became a host (role MEMBER, no tenantId) still gets
 * the right answer (BUG-11). A non-host gets NONE.
 */
const getHostStatus = async (req, res, next) => {
  try {
    return sendSuccess(res, await hostStatusService.getHostStatus(req.user.id || req.user.sub));
  } catch (err) {
    next(err);
  }
};

const getTodaySummary = async (req, res, next) => {
  try {
    // P2 / BUG-11: the host's own tenant by ownership, not the token's tenantId, which
    // is null in a token issued before the tenant existed and then answered "DRAFT"
    // for a host already under review.
    const hostStatus = await hostStatusService.getHostStatus(req.user.id || req.user.sub);
    const tenantId = hostStatus.tenantId;

    if (!tenantId) {
      return sendSuccess(res, {
        state: 'A',
        applicationStatus: 'DRAFT',
        hasActiveBranch: false,
        hostStatus,
      });
    }

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant || tenant.status === 'DRAFT') {
      return sendSuccess(res, {
        state: 'A',
        applicationStatus: 'DRAFT',
        hasActiveBranch: false,
        hostStatus,
      });
    }

    if (tenant.status === 'PENDING_REVIEW' || tenant.status === 'UNDER_REVIEW' || tenant.status === 'REJECTED') {
      return sendSuccess(res, {
        state: 'B',
        applicationStatus: tenant.status,
        hasActiveBranch: false,
        hostStatus,
      });
    }

    // ACTIVE status: connect to tenant DB. A failure is an error the app shows with
    // Try again; it used to answer "APPROVED" with no data, drawn as an empty dashboard
    // until the app was reloaded (BUG-11).
    let tenantDb;
    try {
      tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
    } catch (err) {
      console.warn(`[today-summary] tenant ${tenantId} database unavailable: ${err.message}`);
      const unavailable = createError('We could not load your gym right now. Please try again.', 503);
      unavailable.code = 'tenant_unavailable';
      throw unavailable;
    }

    const { Branch, AttendanceLog, Payment, MemberSubscription, MembershipPlan, Expense } = tenantDb.models;

    const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id', 'timezone'] });
    const activeBranchIds = activeBranches.map((b) => b.id);
    if (activeBranchIds.length === 0) {
      return sendSuccess(res, {
        state: 'C',
        applicationStatus: 'APPROVED',
        hasActiveBranch: false,
        hostStatus,
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
    // GLB-01: "today" and "this month" are the branch's, not the server's. The aggregate view counts each
    // branch's own day; revenue and expenses use the first branch's month start (an org normally sits in one zone).
    let todaysCheckins = 0;
    for (const b of activeBranches) {
      const { start, end } = businessDayRange(computeBusinessDate(new Date(), b.timezone), b.timezone);
      todaysCheckins += await AttendanceLog.count({
        where: {
          branchId: b.id,
          checkInAt: { [Op.gte]: start, [Op.lt]: end },
          attendanceType: 'CHECK_IN'
        }
      });
    }
    const primaryTz = activeBranches[0].timezone;
    const startOfMonthStr = monthStartOf(computeBusinessDate(new Date(), primaryTz));
    const startOfMonth = startOfBusinessDay(startOfMonthStr, primaryTz);

    // 2. This Month Revenue & Expenses
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
    const weeklyPerformance = await _weeklyCheckins(
      AttendanceLog, branchFilter, computeBusinessDate(new Date(), primaryTz), primaryTz
    );

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
      hostStatus,
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

    const data = await branchQuotaService.getBranchQuota(tenantId, { organizationId });
    return sendSuccess(res, data);
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

    const activeSub = await subscriptionQuotaService.getActiveSubscription(tenantId);
    const maxOrganizations = await subscriptionQuotaService.resolveMaxOrganizations(tenant, activeSub);

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
    const hasOrganizationLimit = maxOrganizations !== subscriptionQuotaService.UNLIMITED_ORGANIZATIONS;

    return sendSuccess(res, {
      maxOrganizations,
      usedOrganizations,
      remainingOrganizations,
      hasOrganizationLimit,
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
      // FLOW-05 diagnostic: the only way this endpoint answers an empty list
      // to a host. Seen right after onboarding, it means a stale token.
      console.warn('[FLOW-05] GET /host/listings: token has no tenantId; returning an empty list');
      return sendSuccess(res, []);
    }

    // Return every non-deleted listing (any status but INACTIVE) so hosts
    // still see DRAFT/PENDING listings under review — INACTIVE is a deleted
    // organization (gym.service.js#deleteOrganization), which should
    // disappear from here the same way a deleted branch disappears from
    // its own list.
    const listings = await GymListing.findAll({
      where: { tenantId, status: { [Op.ne]: 'INACTIVE' } },
      order: [['updated_at', 'DESC']]
    });

    // FLOW-05 diagnostic (temporary, DEBUG_FLOW05=true): counts only, no ids.
    if (process.env.DEBUG_FLOW05 === 'true') {
      const byStatus = {};
      for (const l of listings) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      const header = req.headers['x-tenant-id'];
      const headerVsToken = !header ? 'absent' : (header === tenantId ? 'matches' : 'differs');
      console.log(`[FLOW-05] GET /host/listings: ${listings.length} listing(s) ${JSON.stringify(byStatus)}; X-Tenant-Id ${headerVsToken}`);
    }

    return sendSuccess(res, listings);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /host/listings/staging-images
 *
 * Uploads photos to storage and hands back their URLs — nothing else.
 * Deliberately writes to no database field at all. This exists specifically
 * for the "create a new organization" wizard: the organization (and its
 * first branch, which is what the photos actually belong to) doesn't exist
 * yet while the host is still filling out the form, so there's no real
 * entity to attach photos to until createListing runs. Reusing the
 * tenant-level onboarding-images staging field here (as this briefly did)
 * was wrong — that field is a single shared blob for the whole tenant, so a
 * second organization's photos ended up merged with the first organization's
 * already-live photos. Each call here is independent and stateless;
 * whatever URLs the client collects across calls, it holds client-side and
 * sends as `images` to createListing itself.
 */
const uploadListingStagingImages = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) throw createError('Tenant not found', 404);
    if (!req.files || req.files.length === 0) throw createError('At least one image is required', 422);

    const urls = await storageService.uploadImages(req.files, `hosts/${tenantId}/organizations/staging`);
    return sendSuccess(res, { urls }, 'Images uploaded');
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
      const activeSub = await subscriptionQuotaService.getActiveSubscription(tenantId, { transaction: platformTx });
      const maxOrganizations = await subscriptionQuotaService.resolveMaxOrganizations(tenant, activeSub, { transaction: platformTx });

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

      const { gymName, gymDescription, genderType, cityId, areaId, logoUrl, coverImageUrl, contactPhone, latitude, longitude, address, packages, images } = req.body;
      if (!gymName) throw createError('gymName is required', 400);

      // How this organization's first branch gets filled:
      //   'new'     (default) — build a real branch immediately, same as
      //             before; requires packages, consumes 1 unit of capacity.
      //   'reserve' — no branch yet, just earmark 1 unit of capacity on this
      //             organization (a "slot") to be built later from the Gyms
      //             tab, or moved to a different organization first.
      //   'none'    — bare organization, consumes no capacity at all. Used
      //             right before the client separately calls the move-branch
      //             or transfer-reserved-slot endpoints to attach something
      //             this tenant already owns — moving doesn't change the
      //             tenant's total usage, so there's nothing to check here.
      const branchSource = ['new', 'reserve', 'none'].includes(req.body.branchSource) ? req.body.branchSource : 'new';
      if (branchSource === 'new' && (!Array.isArray(packages) || packages.length === 0)) {
        throw createError('At least 1 membership package/plan is required to create an organization', 400);
      }
      // Phase 7 P5 (NEW-147): the same rule gym.service.js#_createBranchRecord enforces, checked here
      // too because the organization's tenant-DB gym is created before the branch (and outside the
      // platform transaction), so a refusal there would leave an orphan gym behind.
      if (branchSource === 'new' && !packages.some((pkg) => pkg && pkg.name && pkg.price != null && pkg.isPublic !== false)) {
        throw createError('Show at least one plan to travellers before you submit.', 422, 'visible_plan_required');
      }

      const targetCityId = cityId || tenant.cityId;
      if (!targetCityId) throw createError('cityId is required', 400);

      // Organizations are free to create, but every organization comes with
      // its own first branch, and branches (real or reserved) are what the
      // subscription actually charges for — so 'new'/'reserve' must be
      // gated by the SAME tenant-wide capacity createBranch uses, checked
      // before anything is created so a rejected request never leaves behind
      // an organization with no branch and no reservation in it.
      // Set when this organization's unit has to come from an unbuilt slot
      // parked on a sibling organization rather than from free capacity.
      // Released below, once there's a listing id to attribute it to.
      let slotDonorListing = null;

      if (branchSource !== 'none') {
        const maxBranches = await subscriptionQuotaService.resolveMaxBranches(tenant, activeSub, { transaction: platformTx });
        const usedCapacity = await subscriptionQuotaService.getUsedCapacity(tenantId, req.tenantDb, { transaction: platformTx });
        if (usedCapacity >= maxBranches) {
          // Every paid unit is allocated — but "allocated" includes unbuilt
          // reservedSlots parked on other organizations, and one of those is
          // exactly the unit this organization needs. A host who paid for 3
          // branches, built 1, and holds 2 parked slots is not out of
          // capacity; the capacity is just sitting somewhere else.
          //
          // Before the slot concept was removed from the UI, the host fixed
          // this by hand ("move an unused slot here") through
          // transferReservedSlots. There's no such flow to send them to any
          // more — the app presents one tenant-wide pool — so the same
          // transfer happens here instead, invisibly and atomically.
          //
          // Capacity-neutral by construction: the donor loses exactly the
          // one unit this organization consumes (a real branch for 'new', a
          // reservation for 'reserve'), so getUsedCapacity is unchanged
          // either way and the subscription's limit is never exceeded.
          slotDonorListing = await GymListing.findOne({
            where: {
              tenantId,
              status: { [Op.ne]: 'INACTIVE' },
              reservedSlots: { [Op.gt]: 0 },
            },
            // Draw from whichever organization is hoarding the most, so a
            // host with slots spread around keeps the widest spread.
            order: [['reservedSlots', 'DESC']],
            lock: true,
            transaction: platformTx,
          });

          if (!slotDonorListing) {
            const err = createError('Branch limit reached', 403);
            err.code = 'branch_limit_reached';
            throw err;
          }
        }
      }

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
        reservedSlots: branchSource === 'reserve' ? 1 : 0,
      }, { transaction: platformTx });

      if (branchSource === 'reserve') {
        // Drawing 1 unit of already-available tenant-wide capacity (checked
        // above) into this brand-new organization as an unbuilt slot — same
        // shape as any other slot attribution, so it gets the same audit
        // trail treatment.
        await subscriptionQuotaService.recordCapacityEvent(
          {
            tenantId,
            listingId: listing.id,
            action: 'SLOT_ATTRIBUTED_UPGRADE',
            delta: 1,
            reservedSlotsBefore: 0,
            reservedSlotsAfter: 1,
            actorUserId: req.user.sub || req.user.id,
            actorType: 'HOST',
            reason: `Organization "${gymName}" created with a reserved slot (build later)`,
            idempotencyKey: `slot_attribute_reserve:${listing.id}`,
          },
          { transaction: platformTx }
        );
      }

      if (slotDonorListing) {
        // The other half of the transfer decided during the capacity check
        // above. Same action/shape gym.service.js#transferReservedSlots
        // records, so a slot moved automatically is indistinguishable in the
        // audit trail from one a host moved by hand — one ledger, one story.
        // Keyed on the new listing so a retried create can never release two.
        const { applied } = await subscriptionQuotaService.recordCapacityEvent(
          {
            tenantId,
            listingId: slotDonorListing.id,
            action: 'SLOT_TRANSFERRED',
            delta: -1,
            reservedSlotsBefore: slotDonorListing.reservedSlots,
            reservedSlotsAfter: slotDonorListing.reservedSlots - 1,
            actorUserId: req.user.sub || req.user.id,
            actorType: 'HOST',
            reason: `1 unbuilt slot released to new organization "${gymName}" (${listing.id})`,
            idempotencyKey: `slot_transfer:new_org:${listing.id}`,
          },
          { transaction: platformTx }
        );
        if (applied) {
          await slotDonorListing.decrement('reservedSlots', { by: 1, transaction: platformTx });
        }
      }

      // Every organization gets its own Gym row immediately, regardless of
      // branchSource — gym.service.js#_getOrCreateGym's fallback (used when
      // building a branch into an organization with no dedicated Gym row
      // yet) grabs the tenant's FIRST Gym row with no listing filter at all,
      // which would misattribute a branch built later into this organization
      // to a completely different one if this step were skipped for
      // 'reserve'/'none'.
      const gym = await req.tenantDb.models.Gym.create({
        name: gymName,
        description: gymDescription || null,
        contactPhone: contactPhone || tenant.phone || null,
        genderType: genderType || 'MIXED',
        logoUrl: logoUrl || tenant.logoUrl || null,
        coverImageUrl: coverImageUrl || tenant.coverImageUrl || null,
        gymListingId: listing.id,
      });

      let branch = null;
      if (branchSource === 'new') {
        // CAP-03: Route through gymService.createBranch with caller's transaction
        // and capacity already verified/settled above.
        const branchResult = await gymService.createBranch(
          req.tenantDb,
          tenantId,
          {
            branchName: gymName,
            address,
            addressLine1: address,
            cityId: targetCityId,
            areaId,
            latitude,
            longitude,
            phone: contactPhone || tenant.phone || null,
            images: Array.isArray(images) && images.length > 0
              ? images
              : (coverImageUrl ? [coverImageUrl] : []),
            packages,
            gymListingId: listing.id,
          },
          req.user.sub || req.user.id,
          {
            transaction: platformTx,
            skipCapacityCheck: true,
            skipCapacityEvent: !!slotDonorListing,
            reason: `Initial branch "${gymName}" created with new organization`,
          }
        );
        branch = branchResult.branch;
      }

      await platformTx.commit();
      return sendSuccess(res, { ...listing.toJSON(), branch }, 'Listing created successfully', 201);
    } catch (err) {
      await platformTx.rollback();
      throw err;
    }
  } catch (err) {
    next(err);
  }
};

/**
 * The tenant-DB gym of one organization. A gym from before organizations has no gymListingId; it
 * belongs to the tenant's first organization (same rule as gym.service.js#_syncGymListing).
 */
const _organizationGym = async (tenantDb, listing) => {
  const { Gym } = tenantDb.models;
  const linked = await Gym.findOne({ where: { gymListingId: listing.id } });
  if (linked) return linked;
  const first = await GymListing.findOne({ where: { tenantId: listing.tenantId }, order: [['createdAt', 'ASC']], attributes: ['id'] });
  return first && first.id === listing.id ? Gym.findOne({ where: { gymListingId: null } }) : null;
};

/**
 * GET /host/listings/:id — one organization and its own gym details (Phase 7 P5, BUG-22: Edit
 * Organization read /gyms/profile, which is whichever gym comes first, not the one being edited).
 */
const getListing = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) throw createError('Tenant not found', 404);
    const listing = await GymListing.findOne({ where: { id: req.params.id, tenantId } });
    if (!listing) throw createError('Organization not found or access denied', 404);
    const gym = await _organizationGym(req.tenantDb, listing);
    return sendSuccess(res, { ...listing.toJSON(), gym: gym ? gym.toJSON() : null });
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
    // Phase 7 P5 (BUG-22): the rest of Edit Organization, for this organization only.
    // category and establishedYear live on the organization; the gym has no columns for them.
    const { category, establishedYear, contactEmail, website, imagesJson } = req.body;

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
    if (category !== undefined) updates.category = category || null;
    if (establishedYear !== undefined) updates.establishedYear = establishedYear ? parseInt(establishedYear, 10) : null;
    if (website !== undefined) updates.website = website || null;
    if (imagesJson !== undefined) updates.imagesJson = imagesJson || [];

    await listing.update(updates);

    // Update corresponding Gym in tenant DB
    const gym = await _organizationGym(req.tenantDb, listing);
    if (gym) {
      const gymUpdates = {};
      if (gymName !== undefined) gymUpdates.name = gymName;
      if (gymDescription !== undefined) gymUpdates.description = gymDescription;
      if (genderType !== undefined) gymUpdates.genderType = genderType;
      if (contactPhone !== undefined) gymUpdates.contactPhone = contactPhone || null;
      if (logoUrl !== undefined) gymUpdates.logoUrl = logoUrl || null;
      if (coverImageUrl !== undefined) gymUpdates.coverImageUrl = coverImageUrl || null;
      if (contactEmail !== undefined) gymUpdates.contactEmail = contactEmail || null;
      if (website !== undefined) gymUpdates.website = website || null;
      if (imagesJson !== undefined) gymUpdates.imagesJson = imagesJson || [];
      await gym.update(gymUpdates);
    }

    return sendSuccess(res, listing, 'Organization updated successfully');
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /host/listings/:id
 * Body:
 *   Re-auth (required unless exempt): { password } or { provider, idToken } / { reauthProvider, reauthIdToken }
 *     - Exempt ONLY if ALL of these hold (NEW-38 rollback window):
 *       1. Belongs to caller (listing.tenantId === tenantId)
 *       2. Zero branches (zero ACTIVE or INACTIVE in tenant DB)
 *       3. Created < 5 minutes ago
 *       4. No strategy/cascade flag set
 *   Optional strategy (only required if the organization has branches or unbuilt slots):
 *   { strategy: 'deleteBranches' }. Moving branches out was removed (P5b, R-81).
 */
const deleteListing = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) throw createError('Tenant not found', 404);
    const { id } = req.params;
    const { strategy, password, provider, reauthProvider, idToken, reauthIdToken } = req.body || {};

    const userId = req.user.sub || req.user.id;

    // Check exemption from re-auth: empty organization rollback within 5 minutes of creation
    const listing = await GymListing.findByPk(id);
    const belongsToCaller = Boolean(listing && listing.tenantId === tenantId && listing.status !== 'INACTIVE');

    let hasZeroBranches = false;
    if (belongsToCaller && req.tenantDb && req.tenantDb.models && req.tenantDb.models.Branch) {
      const branchCount = await req.tenantDb.models.Branch.count({
        where: {
          gymListingId: id,
          status: { [Op.in]: ['ACTIVE', 'INACTIVE'] },
        },
      });
      hasZeroBranches = branchCount === 0;
    }

    const ROLLBACK_WINDOW_MS = 5 * 60 * 1000;
    const createdAtMs = listing && listing.createdAt ? new Date(listing.createdAt).getTime() : 0;
    const isRecent = Boolean(
      listing && (Date.now() - createdAtMs) < ROLLBACK_WINDOW_MS && (Date.now() - createdAtMs) >= 0
    );
    const noCascadeOrStrategy = !strategy && !req.body?.cascade && !req.body?.cascadeDelete;

    const isExempt = belongsToCaller && hasZeroBranches && isRecent && noCascadeOrStrategy;
    const hasCredentials = Boolean(password || provider || reauthProvider || idToken || reauthIdToken);
    const allowWithoutReauth = !hasCredentials && isExempt;

    if (!allowWithoutReauth) {
      await authService.assertReauth(userId, {
        password,
        provider: provider || reauthProvider,
        idToken: idToken || reauthIdToken,
      });
    }

    const result = await gymService.deleteOrganization(req.tenantDb, tenantId, id, {
      strategy,
      deletedByUserId: userId,
    });
    return sendSuccess(res, result, result.message);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /host/branches/:branchId/pause and /resume (P5b item 2, R-81).
 * Hidden from travellers while paused; nothing else changes.
 */
const pauseBranch = async (req, res, next) => {
  try {
    const result = await gymService.pauseBranch(req.tenantDb, req.params.branchId, req.user.sub || req.user.id);
    return sendSuccess(res, result, 'Branch paused');
  } catch (err) {
    next(err);
  }
};

const resumeBranch = async (req, res, next) => {
  try {
    const result = await gymService.resumeBranch(req.tenantDb, req.params.branchId);
    return sendSuccess(res, result, 'Branch resumed');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /host/branches/:branchId/restore
 * Re-activates a previously deleted branch. Re-consumes one unit of
 * capacity the same way building a new branch does — see
 * gymService.restoreBranch for exactly what is and isn't restored (member
 * subscriptions and staff employment are deliberately NOT resurrected).
 */
const restoreBranch = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) throw createError('Tenant not found', 404);
    const { branchId } = req.params;

    const result = await gymService.restoreBranch(req.tenantDb, tenantId, branchId, req.user.sub || req.user.id);
    return sendSuccess(res, result, 'Branch restored successfully');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /host/listings/:id/reserved-slots/transfer
 * Body: { toListingId, count }
 * Moves unbuilt (paid, not-yet-a-real-branch) capacity from :id to
 * toListingId — used both from the Gyms tab's "swap branches between
 * organizations" and from the "create new organization" wizard's option to
 * assign an already-owned unused slot to the new organization instead of
 * building/buying a fresh branch.
 */
const transferReservedSlots = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) throw createError('Tenant not found', 404);
    const { id } = req.params;
    const { toListingId, count } = req.body;
    if (!toListingId) throw createError('toListingId is required', 400);

    const result = await gymService.transferReservedSlots(
      tenantId,
      id,
      toListingId,
      count ? parseInt(count, 10) : 1,
      req.user.sub || req.user.id
    );
    return sendSuccess(res, result, 'Slot moved successfully');
  } catch (err) {
    next(err);
  }
};

const getCurrentSubscription = async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) throw createError('Tenant not found', 404);

    // Read-only (NEW-15, owner decision R-21): this endpoint never creates a
    // plan. It used to create a 30-day ACTIVE/PAID row whenever there was no
    // ACTIVE one, which handed refunded/lapsed tenants a free month. The first
    // plan comes only from onboarding (submission / approval).
    // The entitling row: ACTIVE, or GRACE while a failed renewal is retried —
    // then `paymentIssue` carries the provider's own page to fix the payment
    // (BILL-04, spec §7.4). Null otherwise.
    const subscription = await subscriptionQuotaService.getActiveSubscription(tenantId);

    if (!subscription) {
      // P7c item 5 (NEW-174, R-82): a plan that ended, is on hold, paused or refunded is still
      // this host's plan: answered as it is (entitled: false, why, where to fix it, when the
      // branches lock), never as "no subscription". 404 only when there never was one.
      const lapsed = await subscriptionQuotaService.getLapsedSubscription(tenantId);
      if (!lapsed) throw createError('No active subscription found', 404);
      const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'status', 'connectionStringEncrypted'] });
      const tenantDb =
        tenant?.status === 'ACTIVE' && tenant.connectionStringEncrypted
          ? await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted)
          : null;
      const state = await require('../services/branch-billing-lock.service').getOverQuotaState(tenantId, tenantDb, {
        readOnly: true,
      });
      return sendSuccess(res, {
        ...lapsed.toJSON(),
        entitled: false,
        lapse: subscriptionMigrationService.lapseFor(lapsed, state),
        paymentIssue: null,
      });
    }

    const overquotaGraceDays = require('../config/billing.config').overquotaGraceDays;
    const graceDays = overquotaGraceDays();
    let overQuotaGraceRemainingDays = null;
    let isOverQuotaGraceExpired = false;
    if (subscription.overQuotaCount > 0) {
      const change = subscription.pendingChange;
      const appliedAt = change?.appliedAt ? new Date(change.appliedAt) : new Date(subscription.updatedAt);
      const graceExpiry = new Date(appliedAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
      isOverQuotaGraceExpired = Date.now() >= graceExpiry.getTime();
      overQuotaGraceRemainingDays = Math.max(0, Math.ceil((graceExpiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    }

    // BILL-09: Check if any superseded subscription for this tenant is still billing at the store
    const duplicateRow = await TenantSubscription.findOne({
      where: { tenantId, duplicateBilling: true },
      attributes: ['id', 'platform', 'externalOriginalTransactionId'],
    });

    const storeManageUrls = {
      IOS: 'https://apps.apple.com/account/subscriptions',
      ANDROID: 'https://play.google.com/store/account/subscriptions',
      STRIPE: 'https://gymsera.com/billing',
    };

    return sendSuccess(res, {
      ...subscription.toJSON(),
      entitled: true,
      lapse: null,
      overQuotaGraceDays: graceDays,
      overQuotaGraceRemainingDays,
      isOverQuotaGraceExpired,
      paymentIssue: subscriptionMigrationService.paymentIssueFor(subscription),
      duplicateBilling: !!duplicateRow,
      duplicateBillingPlatform: duplicateRow?.platform || null,
      duplicateBillingManageUrl: duplicateRow ? (storeManageUrls[duplicateRow.platform] || null) : null,
    });
  } catch (err) {
    next(err);
  }
};

// NEW-06 (P0): this route used to cancel the tenant's ACTIVE plan and create an ACTIVE / PAID
// PlatformPackage row with no payment, so any host could give itself any plan. Entitlement now
// comes only from a verified store purchase (the /billing sync routes and webhooks) or from a
// platform admin who has seen the money (admin assign, pay-later verify). The route stays so old
// clients get a clear answer; it reads nothing and writes nothing.
const upgradeSubscription = async (req, res, next) => {
  try {
    const err = createError(
      'Plans can no longer be requested here. Buy a plan in the GymsEra app, or contact support to pay by bank transfer.',
      410
    );
    err.code = 'manual_plan_removed';
    throw err;
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

    // GLB-01: the branch's own day and month.
    const todayStr = computeBusinessDate(new Date(), branch.timezone);
    const { start: startOfDay, end: endOfDay } = businessDayRange(todayStr, branch.timezone);

    const todaysCheckins = await AttendanceLog.count({
      where: {
        branchId,
        checkInAt: { [Op.gte]: startOfDay, [Op.lt]: endOfDay },
        attendanceType: 'CHECK_IN'
      }
    });

    const startOfMonthStr = monthStartOf(todayStr);
    const startOfMonth = startOfBusinessDay(startOfMonthStr, branch.timezone);
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

    const weeklyPerformance = await _weeklyCheckins(AttendanceLog, { branchId }, todayStr, branch.timezone);

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

    // `dashboard.view` and `dashboard.revenue.view` are deliberately separate
    // permissions in the catalogue — a Trainer or Front Desk clerk should see
    // today's check-ins without ever seeing takings. The owner fast-path in
    // resolve() means an owner never pays for this extra query.
    let canSeeRevenue = true;
    if (req.user.role !== 'GYM_HOST' && req.user.isHost !== true) {
      try {
        const userId = req.user.id || req.user.sub;
        const tenantId = req.user.tenantId || req.tenantDb?.tenantId;
        const grants = await accessService.resolve(req.tenantDb, tenantId, userId, branchId);
        canSeeRevenue = grants.has('dashboard.revenue.view');
      } catch (err) {
        console.warn('[dashboard] revenue-permission check failed, defaulting to hidden:', err.message);
        canSeeRevenue = false;
      }
    }

    return sendSuccess(res, {
      todaysCheckins,
      monthlyRevenue: canSeeRevenue ? monthlyRevenue : null,
      grossRevenue: canSeeRevenue ? grossRevenue : null,
      totalExpenses: canSeeRevenue ? totalExpenses : null,
      netProfit: canSeeRevenue ? netProfit : null,
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
            { fullName: { [Op.like]: likeContains(q) } },
            { email: { [Op.like]: likeContains(q) } },
            { phone: { [Op.like]: likeContains(q) } }
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

    // The route gate is announcements.create (drafting). A post that goes out to members
    // (status 'sent', the default) is publishing, which is a separate permission.
    const finalStatus = status || 'sent';
    if (finalStatus !== 'draft' && !(await hasBranchAccess(req, branchId, 'announcements.publish'))) {
      throw createError('You do not have permission to publish to members here', 403);
    }

    const announcement = await Announcement.create({
      branchId,
      title,
      message,
      tag: tag || 'SENT TO ALL MEMBERS',
      status: finalStatus,
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

    const { MemberSubscription, MembershipPlan } = req.tenantDb.models;

    // 1. Check globally if user exists
    const user = await User.findOne({ where: { email: email.toLowerCase().trim() } });
    if (!user) {
      return sendSuccess(res, { exists: false, subscriptions: [] });
    }

    // 2. Check if they have subscription in this branch
    const subscription = await MemberSubscription.findOne({
      where: {
        userId: user.id,
        branchId,
        status: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PENDING, SubscriptionStatus.FROZEN],
      },
    });

    // NEW-56: what the CMS Manual Check-in needs, so a team member with checkins.manual.create
    // but not subscriptions.view need not call GET /subscriptions/staff. Same validity as
    // POST /attendance/manual; id, plan name, end date and visits left only, nothing financial.
    const activeSubs = await MemberSubscription.findAll({
      where: { userId: user.id, branchId, status: SubscriptionStatus.ACTIVE },
      include: [{ model: MembershipPlan, as: 'plan', attributes: ['name'] }],
      order: [['endDate', 'ASC']],
    });
    const lookupBranch = await req.tenantDb.models.Branch.findByPk(branchId, { attributes: ['id', 'timezone'] });
    const today = computeBusinessDate(new Date(), lookupBranch ? lookupBranch.timezone : undefined);
    const subscriptions = activeSubs
      .filter((s) => attendanceService.isCheckinValid(s, today))
      .map((s) => ({
        id: s.id,
        planName: s.plan ? s.plan.name : null,
        endDate: s.endDate,
        remainingVisits: s.remainingVisits,
      }));

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
        subscriptions,
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
      subscriptions,
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
    const message = await inboxService.replyToInquiry(inquiryId, req.user.id, text.trim(), tenantId, {
      clientMessageId: req.body.clientMessageId ?? req.body.client_message_id,
    });
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
  getHostStatus,
  getTodaySummary,
  getBranchQuota,
  getOrganizationQuota,
  getListings,
  uploadListingStagingImages,
  createListing,
  getListing,
  updateListing,
  deleteListing,
  restoreBranch,
  pauseBranch,
  resumeBranch,
  transferReservedSlots,
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
