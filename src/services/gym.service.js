const crypto = require('crypto');
const { GymListing, Tenant, User, UserGymMembership } = require('../models/platform');
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
  return { gym };
};

const updateProfile = async (tenantDb, tenantId, data) => {
  const gym = await _getOrCreateGym(tenantDb, tenantId);

  const fields = ['name', 'description', 'contactPhone', 'contactEmail', 'website', 'genderType', 'logoUrl', 'coverImageUrl', 'socialLinksJson'];
  fields.forEach((f) => {
    if (data[f] !== undefined) gym[f] = data[f];
  });
  await gym.save();

  // Keep the public gym_listings record in sync
  await _syncGymListing(tenantId, data);

  return { gym };
};

// ── Branches ──────────────────────────────────────────────────────────────────

const listBranches = async (tenantDb, tenantId) => {
  const gym = await _getOrCreateGym(tenantDb, tenantId);
  const { Branch } = tenantDb.models;

  const branches = await Branch.findAll({
    where: { gymId: gym.id },
    order: [['createdAt', 'ASC']],
  });

  return { gym, branches };
};

const createBranch = async (tenantDb, tenantId, data) => {
  const gym = await _getOrCreateGym(tenantDb, tenantId);
  const { Branch } = tenantDb.models;

  const branch = await Branch.create({
    gymId: gym.id,
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

  return { branch };
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

  const fields = ['branchName', 'address', 'cityId', 'areaId', 'latitude', 'longitude', 'openingTime', 'closingTime', 'phone', 'facilitiesJson', 'status'];
  fields.forEach((f) => {
    if (data[f] !== undefined) branch[f] = data[f];
  });
  // Support sending facilities as plain array (CMS form sends it as 'facilities')
  if (Array.isArray(data.facilities)) branch.facilitiesJson = data.facilities;
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
const enrollMember = async (tenantDb, tenantId, { email, fullName, phone, planId, branchId, startDate }) => {
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
  const qrCode = `GE-${crypto.randomBytes(20).toString('hex').toUpperCase()}`;

  await MemberProfile.findOrCreate({ where: { userId: user.id }, defaults: { userId: user.id } });

  const subscription = await MemberSubscription.create({
    userId: user.id,
    branchId,
    membershipPlanId: planId,
    startDate: start,
    endDate: end,
    status: SubscriptionStatus.ACTIVE,
    autoRenew: false,
    qrCode,
    subscribedAt: new Date(),
    remainingVisits: plan.visitLimit ?? null,
    sourceChannel: 'WALK_IN',
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
      status: SubscriptionStatus.ACTIVE,
    }).catch(() => {}); // ignore duplicate
  }

  // Walk-in enrollment: create completed CASH payment + paid invoice automatically
  const { Payment, Invoice } = tenantDb.models;
  const subtotal    = parseFloat(plan.price);
  const joining     = parseFloat(plan.joiningFee  || 0);
  const security    = parseFloat(plan.securityFee || 0);
  const totalAmount = subtotal + joining + security;

  const payment = await Payment.create({
    userId:            user.id,
    paymentFor:        'MEMBERSHIP',
    referenceEntityId: subscription.id,
    method:            'CASH',
    amount:            totalAmount,
    currency:          'PKR',
    status:            PaymentStatus.COMPLETED,
    paidAt:            new Date(),
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
    paidAt:   new Date(),
    status:   InvoiceStatus.PAID,
  });

  return { user, subscription, userCreated, payment, invoice };
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
};
