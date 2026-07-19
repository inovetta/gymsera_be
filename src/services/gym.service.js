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
    case 'DAILY':     d.setDate(d.getDate() + durationValue); break;
    case 'WEEKLY':    d.setDate(d.getDate() + durationValue * 7); break;
    case 'MONTHLY':   d.setMonth(d.getMonth() + durationValue); break;
    case 'QUARTERLY': d.setMonth(d.getMonth() + durationValue * 3); break;
    case 'YEARLY':    d.setFullYear(d.getFullYear() + durationValue); break;
    default:          d.setMonth(d.getMonth() + 1);
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

  const fields = ['name', 'description', 'contactPhone', 'contactEmail', 'website', 'genderType', 'logoUrl', 'coverImageUrl', 'socialLinksJson'];
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
  let gym = null;
  let whereClause = {};

  if (organizationId) {
    // Check if listing is active on platform DB
    const listing = await GymListing.findOne({
      where: { id: organizationId, tenantId, status: 'ACTIVE' }
    });
    if (!listing) {
      return { gym: null, branches: [] };
    }

    gym = await Gym.findOne({
      where: {
        [Op.or]: [
          { gymListingId: organizationId },
          { id: organizationId }
        ]
      }
    });
    if (!gym) {
      return { gym: null, branches: [] };
    }
    whereClause = { gymId: gym.id };
  } else {
    // List all branches, but filter by active gym listings only
    const activeListings = await GymListing.findAll({
      where: { tenantId, status: 'ACTIVE' },
      attributes: ['id']
    });
    const activeListingIds = activeListings.map(l => l.id);

    const activeGyms = await Gym.findAll({
      where: { gymListingId: { [Op.in]: activeListingIds } }
    });
    const activeGymIds = activeGyms.map(g => g.id);

    if (activeGymIds.length === 0) {
      return { gym: null, branches: [] };
    }

    gym = activeGyms[0];
    whereClause = { gymId: { [Op.in]: activeGymIds } };
  }

  const branches = await Branch.findAll({
    where: whereClause,
    order: [['createdAt', 'ASC']],
  });

  return { gym, branches };
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
      address: data.address || null,
      cityId: data.cityId || null,
      areaId: data.areaId || null,
      latitude: data.latitude || null,
      longitude: data.longitude || null,
      openingTime: data.openingTime || null,
      closingTime: data.closingTime || null,
      phone: data.phone || null,
      facilitiesJson: Array.isArray(data.facilities) ? data.facilities : (data.facilitiesJson || null),
      status: 'ACTIVE',
    });

    await platformTx.commit();
    return { branch };
  } catch (err) {
    await platformTx.rollback();
    throw err;
  }
};

const getBranch = async (tenantDb, branchId) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);
  return { branch };
};

const updateBranch = async (tenantDb, branchId, data) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  const fields = ['branchName', 'address', 'cityId', 'areaId', 'latitude', 'longitude', 'openingTime', 'closingTime', 'phone', 'facilitiesJson', 'status', 'tagline', 'category', 'tagsJson'];
  fields.forEach((f) => {
    if (data[f] !== undefined) branch[f] = data[f];
  });
  // Support sending facilities as plain array (CMS form sends it as 'facilities')
  if (Array.isArray(data.facilities)) branch.facilitiesJson = data.facilities;
  if (Array.isArray(data.tags)) branch.tagsJson = data.tags;
  await branch.save();

  return { branch };
};

const deleteBranch = async (tenantDb, branchId) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  // Soft delete — mark inactive rather than hard delete
  await branch.update({ status: 'INACTIVE' });
  return { message: 'Branch deactivated successfully' };
};

// ── Staff ─────────────────────────────────────────────────────────────────────

const listStaff = async (tenantDb, branchId) => {
  const { Branch, GymStaff } = tenantDb.models;
  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

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
const listMembers = async (tenantDb, tenantId, { q, status, page, limit, offset }) => {
  const { MemberSubscription } = tenantDb.models;

  // Get distinct userIds from tenant subscriptions
  const subscriptions = await MemberSubscription.findAll({
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
const enrollMember = async (tenantDb, tenantId, { email, fullName, phone, planId, branchId, startDate, notes, paymentMethod }, enrollerRole = 'GYM_HOST') => {
  const { MemberSubscription, MembershipPlan, MemberProfile } = tenantDb.models;

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

  const branch = await tenantDb.models.Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
  if (!branch) throw createError('Branch not found or inactive', 404);

  const existing = await MemberSubscription.findOne({
    where: { userId: user.id, branchId, status: [SubscriptionStatus.ACTIVE, SubscriptionStatus.FROZEN, SubscriptionStatus.PENDING] },
  });
  if (existing) throw createError('Member already has an active subscription at this branch', 409);

  const start = startDate || new Date().toISOString().split('T')[0];
  const end = _calcEndDate(start, plan.durationType, plan.durationValue);
  const autoComplete = enrollerRole === 'GYM_HOST';
  const qrCode = autoComplete ? `GE-${crypto.randomBytes(20).toString('hex').toUpperCase()}` : null;

  await MemberProfile.findOrCreate({ where: { userId: user.id }, defaults: { userId: user.id } });

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
  });

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
    }).catch(() => {}); // ignore duplicate
  }

  // Walk-in enrollment: create payment record.
  // GYM_HOST enrollments auto-complete; staff enrollments go to PENDING (collect box).
  const { Payment, Invoice } = tenantDb.models;
  const subtotal    = parseFloat(plan.price);
  const joining     = parseFloat(plan.joiningFee  || 0);
  const security    = parseFloat(plan.securityFee || 0);
  const totalAmount = subtotal + joining + security;

  const payment = await Payment.create({
    userId:            user.id,
    paymentFor:        'MEMBERSHIP',
    referenceEntityId: subscription.id,
    branchId,
    method:            paymentMethod || 'CASH',
    amount:            totalAmount,
    currency:          'PKR',
    status:            autoComplete ? PaymentStatus.COMPLETED : PaymentStatus.PENDING,
    paidAt:            autoComplete ? new Date() : null,
    createdByRole:     enrollerRole,
  });

  const invoice = await Invoice.create({
    userId:            user.id,
    invoiceNo:         _invoiceNo(),
    invoiceType:       'MEMBERSHIP',
    referenceEntityId: subscription.id,
    subtotal,
    discountAmount: 0,
    taxAmount:      0,
    totalAmount,
    dueDate:  new Date().toISOString().split('T')[0],
    paidAt:   autoComplete ? new Date() : null,
    status:   autoComplete ? InvoiceStatus.PAID : InvoiceStatus.ISSUED,
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

  const staffRecords = await GymStaff.findAll({
    where: { employmentStatus: 'ACTIVE' },
    order: [['createdAt', 'ASC']],
  });

  if (staffRecords.length === 0) return { staff: [] };

  const uniqueUserIds = [...new Set(staffRecords.map((s) => s.userId))];
  const users = await User.findAll({
    where: { id: uniqueUserIds },
    attributes: ['id', 'fullName', 'email', 'phone', 'status', 'role', 'profileImageUrl'],
  });
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  const allBranchIds = [...new Set(staffRecords.map((s) => s.branchId))];
  const branches = await Branch.findAll({ where: { id: allBranchIds }, attributes: ['id', 'branchName'] });
  const branchMap = Object.fromEntries(branches.map((b) => [b.id, b]));

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
  const bcrypt = require('bcrypt');
  const { GymStaff, Branch } = tenantDb.models;
  const { UserRole } = require('../constants/roles');

  const existing = await User.findOne({ where: { email: email.toLowerCase().trim() } });
  if (existing) throw createError('An account with this email already exists', 409);

  const rawPassword = password || require('../utils/otp.utils').generateOtpCode(10);
  const passwordHash = await bcrypt.hash(rawPassword, 12);

  const user = await User.create({
    fullName,
    email: email.toLowerCase().trim(),
    phone: phone || null,
    passwordHash,
    role: UserRole.BRANCH_MANAGER,
    status: 'ACTIVE',
    isVerified: true,
  });

  let targetBranchIds = branchIds || [];
  if (assignToAllBranches) {
    const allBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
    targetBranchIds = allBranches.map((b) => b.id);
  }

  const staffAssignments = await Promise.all(
    targetBranchIds.map((branchId) =>
      GymStaff.create({
        userId: user.id,
        branchId,
        designation: designation || 'Staff',
        employmentStatus: 'ACTIVE',
      }).catch(() => null)
    )
  );

  return {
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone || null,
      role: user.role,
      status: user.status,
      ...(process.env.NODE_ENV !== 'production' && { tempPassword: rawPassword }),
    },
    assignedBranches: staffAssignments.filter(Boolean).length,
    ...(process.env.NODE_ENV !== 'production' && { tempPassword: rawPassword }),
  };
};

/**
 * Remove a staff user from all branches (soft-deactivate all GymStaff records).
 */
const removeStaffUser = async (tenantDb, staffUserId) => {
  const { GymStaff } = tenantDb.models;
  const [updated] = await GymStaff.update(
    { employmentStatus: 'TERMINATED' },
    { where: { userId: staffUserId, employmentStatus: 'ACTIVE' } }
  );
  if (updated === 0) throw createError('No active staff assignments found for this user', 404);
  return { message: 'Staff user removed from all branches' };
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
};
