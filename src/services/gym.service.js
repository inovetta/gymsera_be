const crypto = require('crypto');
const { GymListing, Tenant, User, UserGymMembership, TenantSubscription, PlatformPackage, sequelize } = require('../models/platform');
const { Op } = require('sequelize');
const { createError, buildPagination } = require('../utils/response.utils');
const { SubscriptionStatus } = require('../constants/subscription-status');
const { PaymentStatus, InvoiceStatus } = require('../constants/payment-status');

const _invoiceNo = () => {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `INV-${date}-${rand}`;
};

const _calcEndDate = (startDate, durationType, durationValue) => {
  const d = new Date(startDate);
  switch (durationType) {
    case 'DAILY': d.setDate(d.getDate() + durationValue); break;
    case 'WEEKLY': d.setDate(d.getDate() + durationValue * 7); break;
    case 'MONTHLY': d.setMonth(d.getMonth() + durationValue); break;
    case 'QUARTERLY': d.setMonth(d.getMonth() + durationValue * 3); break;
    case 'YEARLY': d.setFullYear(d.getFullYear() + durationValue); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().split('T')[0];
};

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Get the single Gym record from the tenant DB.
 * On first access (just after provisioning) there may be no Gym row yet —
 * we auto-create one from the Platform Tenant snapshot.
 */
const _getOrCreateGym = async (tenantDb, tenantId) => {
  const { Gym } = tenantDb.models;
  let gym = await Gym.findOne();

  if (!gym) {
    // Seed initial data from the Platform Tenant record
    const tenant = await Tenant.findByPk(tenantId, {
      attributes: ['businessName', 'gymName', 'gymDescription', 'genderType', 'logoUrl', 'coverImageUrl', 'phone', 'email'],
    });

    gym = await Gym.create({
      name: (tenant && (tenant.gymName || tenant.businessName)) || 'My Gym',
      description: (tenant && tenant.gymDescription) || null,
      contactPhone: (tenant && tenant.phone) || null,
      contactEmail: (tenant && tenant.email) || null,
      genderType: (tenant && tenant.genderType) || 'MIXED',
      logoUrl: (tenant && tenant.logoUrl) || null,
      coverImageUrl: (tenant && tenant.coverImageUrl) || null,
    });
  }

  return gym;
};

/**
 * Sync key public fields back to the platform GymListing record.
 * Called whenever the gym profile is updated.
 */
const _syncGymListing = async (tenantId, patch) => {
  const syncFields = {};
  if (patch.name !== undefined) syncFields.title = patch.name;
  if (patch.description !== undefined) syncFields.shortDescription = patch.description;
  if (patch.logoUrl !== undefined) syncFields.logoUrl = patch.logoUrl;
  if (patch.coverImageUrl !== undefined) syncFields.coverImageUrl = patch.coverImageUrl;
  if (patch.genderType !== undefined) syncFields.genderType = patch.genderType;
  if (patch.contactPhone !== undefined) syncFields.contactPhone = patch.contactPhone;
  // phone is the alias the CMS profile form sends
  if (patch.phone !== undefined) syncFields.contactPhone = patch.phone;
  if (patch.website !== undefined) syncFields.website = patch.website;
  if (patch.imagesJson !== undefined) syncFields.imagesJson = patch.imagesJson;
  if (patch.latitude != null) syncFields.latitude = patch.latitude;
  if (patch.longitude != null) syncFields.longitude = patch.longitude;

  if (Object.keys(syncFields).length > 0) {
    await GymListing.update(syncFields, { where: { tenantId } });
  }
};

// ── Gym profile ───────────────────────────────────────────────────────────────

const getProfile = async (tenantDb, tenantId) => {
  const gym = await _getOrCreateGym(tenantDb, tenantId);
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['paymentDetailsJson'] });
  return {
    gym: {
      ...gym.toJSON(),
      paymentDetailsJson: tenant ? tenant.paymentDetailsJson : null,
    }
  };
};

const updateProfile = async (tenantDb, tenantId, data) => {
  const gym = await _getOrCreateGym(tenantDb, tenantId);

  const fields = ['name', 'description', 'contactPhone', 'contactEmail', 'website', 'genderType', 'logoUrl', 'coverImageUrl', 'socialLinksJson', 'imagesJson', 'tagline', 'category', 'establishedYear'];
  fields.forEach((f) => {
    if (data[f] !== undefined) gym[f] = data[f];
  });
  await gym.save();

  // If paymentDetailsJson is provided, update the platform Tenant model
  if (data.paymentDetailsJson !== undefined) {
    await Tenant.update(
      { paymentDetailsJson: data.paymentDetailsJson },
      { where: { id: tenantId } }
    );
  }

  // Keep the public gym_listings record in sync
  await _syncGymListing(tenantId, data);

  const tenant = await Tenant.findByPk(tenantId, { attributes: ['paymentDetailsJson'] });
  return {
    gym: {
      ...gym.toJSON(),
      paymentDetailsJson: tenant ? tenant.paymentDetailsJson : null,
    }
  };
};

// ── Branches ──────────────────────────────────────────────────────────────────

const listBranches = async (tenantDb, tenantId, organizationId) => {
  const { Gym, Branch } = tenantDb.models;
  let gym = await Gym.findOne();

  let whereClause = {};

  if (organizationId) {
    whereClause = {
      [Op.or]: [
        { gymListingId: organizationId },
        { gymId: organizationId },
        { gymListingId: null },
      ]
    };
  }

  const branches = await Branch.findAll({
    where: {
      ...whereClause,
      status: { [Op.ne]: 'INACTIVE' },
    },
    order: [['createdAt', 'ASC']],
  });

  // Find default listing for this tenant to ensure every branch has gymListingId populated for frontend mapping
  const defaultListing = await GymListing.findOne({ where: { tenantId } });
  const mappedBranches = branches.map(b => {
    const json = b.toJSON();
    if (!json.gymListingId && defaultListing) {
      json.gymListingId = defaultListing.id;
    }
    return json;
  });

  return { gym, branches: mappedBranches };
};

const createBranch = async (tenantDb, tenantId, data) => {
  const { Branch } = tenantDb.models;

  const platformTx = await sequelize.transaction();
  try {
    // Acquire exclusive write lock on Tenant record in platform DB to serialize branch creations for this tenant.
    const tenant = await Tenant.findByPk(tenantId, {
      lock: true,
      transaction: platformTx,
    });
    if (!tenant) {
      throw createError('Tenant not found', 404);
    }

    let targetListingId = data.gymListingId;
    if (!targetListingId) {
      const firstListing = await GymListing.findOne({
        where: { tenantId },
        transaction: platformTx,
      });
      if (firstListing) targetListingId = firstListing.id;
    }

    let maxBranches = 1;
    const activeSub = await TenantSubscription.findOne({
      where: { tenantId, status: 'ACTIVE' },
      include: [{ model: PlatformPackage, as: 'package', attributes: ['maxBranches'] }],
      transaction: platformTx,
    });

    if (activeSub && activeSub.package) {
      maxBranches = activeSub.package.maxBranches;
    } else if (tenant.selectedPackageId) {
      const pkg = await PlatformPackage.findByPk(tenant.selectedPackageId, {
        transaction: platformTx,
      });
      if (pkg) maxBranches = pkg.maxBranches;
    }

    // Count currently active branches in tenant DB for this listing/org
    const usedBranches = await Branch.count({
      where: {
        status: 'ACTIVE',
        gymListingId: targetListingId || null,
      }
    });

    if (usedBranches >= maxBranches) {
      try {
        const notificationsService = require('./notifications.service');
        if (tenant && tenant.ownerUserId) {
          await notificationsService.createNotification({
            userId: tenant.ownerUserId,
            role: 'host',
            type: 'branch_quota_reached',
            title: 'Branch Limit Reached',
            message: 'You have reached your branch listing quota! Upgrade your package to add more branch listings.',
            deepLink: '/host/listings',
            metadataJson: { tenantId }
          });
        }
      } catch (notifErr) {
        console.warn('[Notification Error] Failed to create branch quota reached notification:', notifErr.message);
      }

      const err = createError('Branch limit reached', 403);
      err.code = 'branch_limit_reached';
      throw err;
    }

    let gym = null;
    if (targetListingId) {
      gym = await tenantDb.models.Gym.findOne({
        where: { gymListingId: targetListingId }
      });
    }
    if (!gym) {
      gym = await _getOrCreateGym(tenantDb, tenantId);
    }

    const branch = await Branch.create({
      gymId: gym.id,
      gymListingId: targetListingId || null,
      branchName: data.branchName,
      address: data.address || data.addressLine1 || null,
      cityId: data.cityId || null,
      areaId: data.areaId || null,
      latitude: data.latitude || null,
      longitude: data.longitude || null,
      openingTime: data.openingTime || null,
      closingTime: data.closingTime || null,
      phone: data.phone || null,
      facilitiesJson: Array.isArray(data.facilities) ? data.facilities : (data.facilitiesJson || null),
      imagesJson: Array.isArray(data.images) ? data.images : (data.imagesJson || null),
      tagline: data.tagline || null,
      category: data.category || null,
      description: data.description || null,
      establishedYear: data.establishedYear ? parseInt(data.establishedYear) : null,
      floorArea: data.floorArea ? parseInt(data.floorArea) : null,
      addressLine1: data.addressLine1 || data.address || null,
      addressLine2: data.addressLine2 || null,
      postalCode: data.postalCode || null,
      country: data.country || null,
      status: 'ACTIVE',
    });

    // Auto-create initial membership packages if provided
    if (Array.isArray(data.packages) && data.packages.length > 0) {
      const membershipPlanService = require('./membership-plan.service');
      for (const pkg of data.packages) {
        try {
          await membershipPlanService.createPlan(tenantDb, {
            branchId: branch.id,
            name: pkg.name,
            price: pkg.price,
            durationType: pkg.durationType || 'MONTHLY',
            durationValue: pkg.durationValue || 1,
            description: pkg.description || null,
            isPublic: true,
          });
        } catch (pkgErr) {
          console.warn('[Branch Creation] Package creation warning:', pkgErr.message);
        }
      }
    }

    await platformTx.commit();
    return { branch };
  } catch (err) {
    await platformTx.rollback();
    throw err;
  }
};

const getBranch = async (tenantDb, branchId) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findOne({
    where: { id: branchId, status: 'ACTIVE' },
  });
  if (!branch) throw createError('Branch not found or has been deleted', 404);
  return { branch };
};

const updateBranch = async (tenantDb, branchId, data) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  const fields = ['branchName', 'address', 'cityId', 'areaId', 'latitude', 'longitude', 'openingTime', 'closingTime', 'phone', 'facilitiesJson', 'imagesJson', 'status', 'tagline', 'category', 'tagsJson', 'description', 'establishedYear', 'floorArea', 'addressLine1', 'addressLine2', 'postalCode', 'country'];
  fields.forEach((f) => {
    if (data[f] !== undefined) branch[f] = data[f];
  });
  // Support sending facilities as plain array (CMS form sends it as 'facilities')
  if (Array.isArray(data.facilities)) branch.facilitiesJson = data.facilities;
  if (Array.isArray(data.images)) branch.imagesJson = data.images;
  if (Array.isArray(data.tags)) branch.tagsJson = data.tags;
  await branch.save();

  return { branch };
};

const deleteBranch = async (tenantDb, branchId, deletedByUserId) => {
  const {
    Branch,
    MembershipPlan,
    MemberSubscription,
    GymStaff,
    Trainer,
    Announcement,
    ClassSchedule,
    StaffActionRequest,
  } = tenantDb.models;

  const branch = await Branch.findByPk(branchId);
  if (!branch || branch.status === 'INACTIVE') {
    throw createError('Branch not found or already deleted', 404);
  }

  const t = await tenantDb.sequelize.transaction();
  try {
    // 1. Mark branch INACTIVE and traveler visibility deactivated
    await branch.update({
      status: 'INACTIVE',
      travelerVisibilityStatus: 'deactivated',
      deactivatedAt: new Date(),
      deactivatedBy: deletedByUserId || null,
      deactivationReason: 'Branch deleted by host/admin',
    }, { transaction: t });

    // 2. Cascade deactivation to all membership plans for this branch
    if (MembershipPlan) {
      await MembershipPlan.update(
        { status: 'INACTIVE', isPublic: false },
        { where: { branchId }, transaction: t }
      );
    }

    // 3. Cascade cancellation to all active/pending/frozen subscriptions on this branch
    if (MemberSubscription) {
      await MemberSubscription.update(
        { status: 'CANCELLED' },
        {
          where: {
            branchId,
            status: { [Op.in]: ['ACTIVE', 'PENDING', 'FROZEN', 'PAST_DUE'] },
          },
          transaction: t,
        }
      );
    }

    // 4. Terminate active staff assignments on this branch
    if (GymStaff) {
      await GymStaff.update(
        { employmentStatus: 'TERMINATED' },
        { where: { branchId, employmentStatus: 'ACTIVE' }, transaction: t }
      );
    }

    // 5. Cancel any pending staff action requests for this branch
    if (StaffActionRequest) {
      await StaffActionRequest.update(
        { status: 'CANCELLED' },
        { where: { branchId, status: 'PENDING' }, transaction: t }
      );
    }

    // 6. Deactivate/delete announcements, schedules, trainers for this branch
    if (Announcement) {
      await Announcement.destroy({ where: { branchId }, transaction: t });
    }
    if (ClassSchedule) {
      await ClassSchedule.destroy({ where: { branchId }, transaction: t });
    }
    if (Trainer) {
      await Trainer.update(
        { status: 'INACTIVE' },
        { where: { branchId }, transaction: t }
      );
    }

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  // 7. Update Platform GymListing cross-DB reference if linked
  try {
    const { GymListing } = require('../models/platform');
    await GymListing.update(
      { branchId: null },
      { where: { branchId } }
    );
  } catch (platErr) {
    console.warn('[Branch Deletion] Warning unlinking GymListing branchId:', platErr.message);
  }

  // 8. Re-sync minPrice for the gym profile
  try {
    await _syncMinPrice(tenantDb, branch.gymId);
  } catch (syncErr) {
    console.warn('[Branch Deletion] Warning re-syncing minPrice:', syncErr.message);
  }

  return { message: 'Branch deleted successfully' };
};

// ── Staff ─────────────────────────────────────────────────────────────────────

const listStaff = async (tenantDb, branchId) => {
  const { Branch, GymStaff } = tenantDb.models;
  const branch = await Branch.findOne({
    where: { id: branchId, status: 'ACTIVE' },
  });
  if (!branch) throw createError('Branch not found or has been deleted', 404);

  const staff = await GymStaff.findAll({
    where: { branchId, employmentStatus: 'ACTIVE' },
    order: [['createdAt', 'ASC']],
  });

  return { branch, staff };
};

const assignStaff = async (tenantDb, branchId, userId, designation) => {
  const { Branch, GymStaff } = tenantDb.models;

  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  // Prevent duplicate active assignment
  const existing = await GymStaff.findOne({
    where: { branchId, userId, employmentStatus: 'ACTIVE' },
  });
  if (existing) throw createError('This user is already assigned to this branch', 409);

  const staffMember = await GymStaff.create({
    branchId,
    userId,
    designation: designation || null,
    employmentStatus: 'ACTIVE',
  });

  try {
    const { Tenant } = require('../models/platform');
    const notificationsService = require('./notifications.service');
    const tenant = await Tenant.findByPk(tenantDb.tenantId);
    const gymName = tenant ? tenant.gymName : 'your gym';
    await notificationsService.createNotification({
      userId,
      role: 'staff',
      type: 'staff_invite',
      title: 'New Staff Assignment',
      message: `You have been assigned as staff for ${branch.branchName} at ${gymName}.`,
      priority: 'high',
      deepLink: '/staff/dashboard',
      metadataJson: { branchId }
    });
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create staff assignment notification:', notifErr.message);
  }

  return { staffMember };
};

const removeStaff = async (tenantDb, branchId, staffId) => {
  const { GymStaff } = tenantDb.models;

  const staffMember = await GymStaff.findOne({ where: { id: staffId, branchId } });
  if (!staffMember) throw createError('Staff assignment not found', 404);

  await staffMember.update({ employmentStatus: 'TERMINATED' });
  return { message: 'Staff member removed from branch' };
};

// ── Gym profile images ────────────────────────────────────────────────────────

const addGymImages = async (tenantDb, tenantId, newUrls) => {
  const gym = await _getOrCreateGym(tenantDb, tenantId);
  const existing = Array.isArray(gym.imagesJson) ? gym.imagesJson : [];
  const combined = [...existing, ...newUrls];
  await gym.update({ imagesJson: combined });
  await _syncGymListing(tenantId, { imagesJson: combined });
  return { gym };
};

const removeGymImage = async (tenantDb, tenantId, imageUrl) => {
  const gym = await _getOrCreateGym(tenantDb, tenantId);
  const existing = Array.isArray(gym.imagesJson) ? gym.imagesJson : [];
  const updated = existing.filter((url) => url !== imageUrl);
  await gym.update({ imagesJson: updated });
  await _syncGymListing(tenantId, { imagesJson: updated });
  return { gym };
};

// ── Branch images ─────────────────────────────────────────────────────────────

const addBranchImages = async (tenantDb, branchId, newUrls) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  const existing = Array.isArray(branch.imagesJson) ? branch.imagesJson : [];
  const combined = [...existing, ...newUrls];
  await branch.update({ imagesJson: combined });
  return { branch };
};

const removeBranchImage = async (tenantDb, branchId, imageUrl) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  const existing = Array.isArray(branch.imagesJson) ? branch.imagesJson : [];
  const updated = existing.filter((url) => url !== imageUrl);
  await branch.update({ imagesJson: updated });
  return { branch };
};

// ── Members (tenant-scoped) ───────────────────────────────────────────────────
/**
 * Returns platform users who have a subscription record in this gym's tenant DB.
 * Gym hosts only ever see their own gym's members.
 */
const listMembers = async (tenantDb, tenantId, { q, status, branchId, page, limit, offset }) => {
  const { MemberSubscription, Branch } = tenantDb.models;

  const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
  const activeBranchIds = activeBranches.map((b) => b.id);
  if (activeBranchIds.length === 0) {
    return { members: [], pagination: buildPagination(0, page, limit) };
  }

  const subWhere = {
    status: ['ACTIVE', 'PENDING', 'FROZEN'],
  };
  if (branchId) {
    if (!activeBranchIds.includes(branchId)) {
      return { members: [], pagination: buildPagination(0, page, limit) };
    }
    subWhere.branchId = branchId;
  } else {
    subWhere.branchId = { [Op.in]: activeBranchIds };
  }

  // Get distinct userIds from active tenant subscriptions
  const subscriptions = await MemberSubscription.findAll({
    where: subWhere,
    attributes: ['userId'],
    group: ['userId'],
  });
  const userIds = subscriptions.map((s) => s.userId);

  if (userIds.length === 0) {
    return { members: [], pagination: buildPagination(0, page, limit) };
  }

  const where = { id: { [Op.in]: userIds } };
  if (status) where.status = status;
  if (q) {
    where[Op.or] = [
      { fullName: { [Op.like]: `%${q}%` } },
      { email: { [Op.like]: `%${q}%` } },
      { phone: { [Op.like]: `%${q}%` } },
    ];
  }

  const { count, rows } = await User.findAndCountAll({
    where,
    attributes: ['id', 'fullName', 'email', 'phone', 'status', 'profileImageUrl', 'createdAt'],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return { members: rows, pagination: buildPagination(count, page, limit) };
};

// ── Member search (by email) ──────────────────────────────────────────────────
const searchMember = async (email) => {
  const user = await User.findOne({
    where: { email: email.toLowerCase().trim() },
    attributes: ['id', 'fullName', 'email', 'phone', 'status', 'profileImageUrl', 'isVerified'],
  });
  return { user: user || null };
};

// ── Enroll member (walk-in or staff-assigned) ─────────────────────────────────
const enrollMember = async (tenantDb, tenantId, { email, fullName, phone, planId, branchId, startDate, notes, paymentMethod }, enroller = { role: 'GYM_HOST' }) => {
  const { MemberSubscription, MembershipPlan, MemberProfile } = tenantDb.models;
  const enrollerRole = typeof enroller === 'string' ? enroller : (enroller?.role || 'GYM_HOST');
  const enrollerId = typeof enroller === 'object' && enroller !== null
    ? (enroller.id || enroller.sub || enroller.userId || null)
    : null;

  // Find or create platform user
  const [user, userCreated] = await User.findOrCreate({
    where: { email: email.toLowerCase().trim() },
    defaults: {
      fullName: fullName || email.split('@')[0],
      phone: phone || null,
      status: 'ACTIVE',
      isVerified: true,
      role: 'MEMBER',
    },
  });

  const plan = await MembershipPlan.findOne({ where: { id: planId, status: 'ACTIVE' } });
  if (!plan) throw createError('Plan not found or inactive', 404);

  const branch = await tenantDb.models.Branch.findOne({ where: { id: branchId } });
  if (!branch) throw createError('Branch not found', 404);
  if (branch.status !== 'ACTIVE') throw createError(`Branch is not active (current status: ${branch.status})`, 404);

  const today = new Date().toISOString().split('T')[0];
  const existing = await MemberSubscription.findOne({
    where: { userId: user.id, branchId, status: [SubscriptionStatus.ACTIVE, SubscriptionStatus.FROZEN, SubscriptionStatus.PENDING] },
    order: [['createdAt', 'DESC']],
  });

  if (existing) {
    if (existing.status === SubscriptionStatus.ACTIVE && existing.endDate && existing.endDate < today) {
      // Prior subscription has passed its end date, mark expired so new subscription can be enrolled
      await existing.update({ status: SubscriptionStatus.EXPIRED });
    } else if (existing.status === SubscriptionStatus.PENDING && enrollerRole === 'GYM_HOST') {
      // Pending subscription being enrolled by host: cancel previous pending record
      await existing.update({ status: SubscriptionStatus.CANCELLED, cancelledAt: new Date() });
    } else {
      throw createError(`Member already has an active subscription at this branch (valid until ${existing.endDate || 'active'}). Please use Renew or Change Plan instead.`, 409);
    }
  }

  const start = startDate || new Date().toISOString().split('T')[0];
  const end = _calcEndDate(start, plan.durationType, plan.durationValue);
  const autoComplete = enrollerRole === 'GYM_HOST';
  const qrCode = autoComplete ? `GE-${crypto.randomBytes(20).toString('hex').toUpperCase()}` : null;

  await MemberProfile.findOrCreate({ where: { userId: user.id }, defaults: { userId: user.id } });

  const { resolveCreatorRole } = require('../utils/audit.utils');
  const creatorRole = await resolveCreatorRole(tenantDb, enrollerId, enrollerRole, branchId);

  const subscription = await MemberSubscription.create({
    userId: user.id,
    branchId,
    membershipPlanId: planId,
    startDate: start,
    endDate: end,
    status: autoComplete ? SubscriptionStatus.ACTIVE : SubscriptionStatus.PENDING,
    autoRenew: false,
    qrCode,
    subscribedAt: new Date(),
    remainingVisits: plan.visitLimit ?? null,
    sourceChannel: 'WALK_IN',
    notes: notes || null,
    createdBy: enrollerId || null,
    createdByRole: creatorRole,
  });

  // Create unified Host notification for staff action pending approval
  if (!autoComplete) {
    try {
      const { Tenant, User: PlatformUser } = require('../models/platform');
      const notificationsService = require('./notifications.service');
      const tenant = await Tenant.findByPk(tenantId);

      const staffUser = enrollerId ? await PlatformUser.findByPk(enrollerId) : null;
      const staffName = staffUser ? staffUser.fullName : 'Staff';

      if (tenant && tenant.ownerUserId) {
        await notificationsService.createNotification({
          userId: tenant.ownerUserId,
          role: 'host',
          type: 'staff_action_pending',
          title: 'Pending Staff Action',
          message: `${staffName} requested to add member for ${user.fullName} at ${branch.branchName} — needs your approval.`,
          deepLink: '/host/subscriptions',
          metadataJson: { subscriptionId: subscription.id, branchId },
        });
      }
    } catch (notifErr) {
      console.warn('[Notification Error] Failed to create staff enrollment pending notification:', notifErr.message);
    }
  }

  // Cross-tenant platform index
  const gymListing = await GymListing.findOne({ where: { tenantId } });
  if (gymListing) {
    await UserGymMembership.create({
      userId: user.id,
      tenantId,
      gymListingId: gymListing.id,
      subscriptionId: subscription.id,
      gymName: gymListing.title,
      planName: plan.name,
      startDate: start,
      endDate: end,
      status: autoComplete ? SubscriptionStatus.ACTIVE : SubscriptionStatus.PENDING,
    }).catch(() => { }); // ignore duplicate
  }

  // Walk-in enrollment: create payment record.
  // GYM_HOST enrollments auto-complete; staff enrollments go to PENDING (collect box).
  const { Payment, Invoice } = tenantDb.models;
  const subtotal = parseFloat(plan.price);
  const joining = parseFloat(plan.joiningFee || 0);
  const security = parseFloat(plan.securityFee || 0);
  const totalAmount = subtotal + joining + security;

  const payment = await Payment.create({
    userId: user.id,
    paymentFor: 'MEMBERSHIP',
    referenceEntityId: subscription.id,
    branchId,
    method: paymentMethod || 'CASH',
    amount: totalAmount,
    currency: 'PKR',
    status: autoComplete ? PaymentStatus.COMPLETED : PaymentStatus.PENDING,
    paidAt: autoComplete ? new Date() : null,
    createdBy: enrollerId || null,
    createdByRole: creatorRole,
  });

  const invoice = await Invoice.create({
    userId: user.id,
    invoiceNo: _invoiceNo(),
    invoiceType: 'MEMBERSHIP',
    referenceEntityId: subscription.id,
    branchId,
    subtotal,
    discountAmount: 0,
    taxAmount: 0,
    totalAmount,
    dueDate: new Date().toISOString().split('T')[0],
    paidAt: autoComplete ? new Date() : null,
    status: autoComplete ? InvoiceStatus.PAID : InvoiceStatus.ISSUED,
    createdBy: enrollerId || null,
    createdByRole: creatorRole,
  });

  return { user, subscription, userCreated, payment, invoice };
};

// ── Gym-wide staff management (GYM_HOST) ─────────────────────────────────────

/**
 * List all active staff across all branches for this gym.
 * Enriches each GymStaff record with platform user data.
 */
const listAllStaff = async (tenantDb) => {
  const { GymStaff, Branch } = tenantDb.models;

  const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id', 'branchName'] });
  const activeBranchIds = activeBranches.map((b) => b.id);
  if (activeBranchIds.length === 0) return { staff: [] };

  const staffRecords = await GymStaff.findAll({
    where: {
      employmentStatus: 'ACTIVE',
      branchId: { [Op.in]: activeBranchIds },
    },
    order: [['createdAt', 'ASC']],
  });

  if (staffRecords.length === 0) return { staff: [] };

  const uniqueUserIds = [...new Set(staffRecords.map((s) => s.userId))];
  const users = await User.findAll({
    where: { id: uniqueUserIds },
    attributes: ['id', 'fullName', 'email', 'phone', 'status', 'role', 'profileImageUrl'],
  });
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  const branchMap = Object.fromEntries(activeBranches.map((b) => [b.id, b]));

  const staff = staffRecords.map((s) => ({
    id: s.id,
    userId: s.userId,
    branchId: s.branchId,
    designation: s.designation,
    employmentStatus: s.employmentStatus,
    createdAt: s.createdAt,
    user: userMap[s.userId] || null,
    branch: branchMap[s.branchId] || null,
  }));

  return { staff };
};

/**
 * Create a new staff user (BRANCH_MANAGER) and assign them to branches.
 * assignToAllBranches: if true, assign to every active branch in the gym.
 * branchIds: specific branch UUIDs to assign to (used when assignToAllBranches is false).
 */
const createStaffUser = async (tenantDb, { fullName, email, phone, password, designation, branchIds, assignToAllBranches }) => {
  const { GymStaff, Branch } = tenantDb.models;
  const { User, Tenant } = require('../models/platform');
  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');
  const notificationsService = require('./notifications.service');

  const emailClean = email.toLowerCase().trim();

  // Check if a staff/admin with this email already exists and is active in this gym
  const existingActiveStaff = await GymStaff.findOne({
    where: {
      email: emailClean,
      employmentStatus: 'ACTIVE',
    }
  });

  let existingUser = await User.findOne({ where: { email: emailClean } });
  let userActiveStaff = null;
  if (existingUser) {
    userActiveStaff = await GymStaff.findOne({
      where: {
        userId: existingUser.id,
        employmentStatus: 'ACTIVE',
      }
    });
  }

  const conflictStaff = existingActiveStaff || userActiveStaff;
  if (conflictStaff) {
    const existingRole = conflictStaff.designation || 'Staff/Admin';
    throw createError(
      `User with email "${emailClean}" is already assigned as ${existingRole}. Please remove them from ${existingRole} first before assigning a new role.`,
      409
    );
  }

  let tempPasswordGenerated = null;

  if (!existingUser) {
    tempPasswordGenerated = password || (crypto.randomBytes(4).toString('hex') + '!Aa1');
    const passwordHash = await bcrypt.hash(tempPasswordGenerated, 12);
    existingUser = await User.create({
      fullName: fullName || emailClean.split('@')[0],
      email: emailClean,
      phone: phone || null,
      passwordHash,
      role: 'BRANCH_MANAGER',
      status: 'ACTIVE',
      emailVerified: true,
    });
  } else if (existingUser.role === 'MEMBER') {
    await existingUser.update({ role: 'BRANCH_MANAGER' });
  }

  let targetBranchIds = branchIds || [];
  if (assignToAllBranches) {
    const allBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
    targetBranchIds = allBranches.map((b) => b.id);
  }

  const staffRecords = [];
  const tenant = await Tenant.findByPk(tenantDb.tenantId);
  const gymName = tenant ? tenant.gymName : 'your gym';

  for (const branchId of targetBranchIds) {
    // Check if staff assignment already exists
    let staffMember = await GymStaff.findOne({
      where: {
        branchId,
        userId: existingUser.id,
      }
    });

    if (!staffMember) {
      staffMember = await GymStaff.findOne({
        where: {
          branchId,
          email: emailClean,
        }
      });
    }

    if (staffMember) {
      await staffMember.update({
        userId: existingUser.id,
        email: emailClean,
        designation: designation || staffMember.designation || 'Staff',
        employmentStatus: 'ACTIVE',
        status: 'active',
      });
      staffRecords.push(staffMember);
      continue;
    }

    staffMember = await GymStaff.create({
      userId: existingUser.id,
      email: emailClean,
      branchId,
      designation: designation || 'Staff',
      employmentStatus: 'ACTIVE',
      status: 'active',
    });
    staffRecords.push(staffMember);

    // Create notification
    try {
      const br = await Branch.findByPk(branchId);
      const brName = br ? br.branchName : 'branch';
      await notificationsService.createNotification({
        userId: existingUser.id,
        role: 'traveler',
        type: 'staff_invite',
        title: 'Staff / Admin Assignment',
        message: `You've been assigned to ${brName} as ${designation || 'staff'} for ${gymName}.`,
        priority: 'normal',
        metadataJson: { staffId: staffMember.id, branchId, tenantId: tenantDb.tenantId }
      });
    } catch (notifErr) {
      console.warn('[Notification Error] Failed to create staff assignment notification:', notifErr.message);
    }
  }

  return {
    user: {
      id: existingUser.id,
      fullName: existingUser.fullName,
      email: existingUser.email,
      phone: existingUser.phone || null,
      role: existingUser.role,
      status: existingUser.status,
    },
    tempPassword: tempPasswordGenerated,
    assignedBranches: staffRecords.length,
  };
};

/**
 * Remove a staff user from all branches (soft-deactivate all GymStaff records).
 */
const removeStaffUser = async (tenantDb, staffUserId) => {
  const { GymStaff } = tenantDb.models;
  const { Op } = require('sequelize');

  const [updated] = await GymStaff.update(
    { employmentStatus: 'TERMINATED', status: 'declined' },
    {
      where: {
        [Op.or]: [
          { userId: staffUserId },
          { email: String(staffUserId).toLowerCase().trim() }
        ],
        employmentStatus: 'ACTIVE'
      }
    }
  );
  if (updated === 0) throw createError('No active staff assignments found for this user', 404);
  return { message: 'Staff user removed from all branches' };
};

const checkAndTriggerPendingStaffInvites = async (user) => {
  try {
    const { Tenant } = require('../models/platform');
    const TenantDbManager = require('../database/TenantDbManager');
    const notificationsService = require('./notifications.service');

    const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
    for (const tenant of tenants) {
      try {
        const { models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const { GymStaff, Branch } = models;

        const invites = await GymStaff.findAll({
          where: {
            email: user.email.toLowerCase().trim(),
            status: 'pending',
            userId: null
          }
        });

        for (const invite of invites) {
          await invite.update({ userId: user.id });

          const br = await Branch.findByPk(invite.branchId);
          const brName = br ? br.branchName : 'branch';
          const gymName = tenant.gymName || 'your gym';

          await notificationsService.createNotification({
            userId: user.id,
            role: 'traveler',
            type: 'staff_invite',
            title: 'Staff Invitation',
            message: `You've been invited to join ${brName} as staff by ${gymName}. Tap to view details.`,
            priority: 'high',
            deepLink: `/traveler/staff-invite-confirmation?staffId=${invite.id}&tenantId=${tenant.id}`,
            metadataJson: { staffId: invite.id, branchId: invite.branchId, tenantId: tenant.id }
          });
        }
      } catch (err) {
        console.warn(`[Staff Invite Sync] Failed for tenant ${tenant.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Staff Invite Sync Error] Failed to scan pending invites:', err);
  }
};

module.exports = {
  getProfile,
  updateProfile,
  addGymImages,
  removeGymImage,
  listBranches,
  createBranch,
  getBranch,
  updateBranch,
  deleteBranch,
  listStaff,
  assignStaff,
  removeStaff,
  addBranchImages,
  removeBranchImage,
  listMembers,
  searchMember,
  enrollMember,
  listAllStaff,
  createStaffUser,
  removeStaffUser,
  checkAndTriggerPendingStaffInvites,
};
