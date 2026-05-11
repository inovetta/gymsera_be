const { GymListing, Tenant } = require('../models/platform');
const { createError } = require('../utils/response.utils');

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
  if (patch.website !== undefined) syncFields.website = patch.website;

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
    facilitiesJson: data.facilitiesJson || null,
    imagesJson: data.imagesJson || null,
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

  const fields = ['branchName', 'address', 'cityId', 'areaId', 'latitude', 'longitude', 'openingTime', 'closingTime', 'phone', 'facilitiesJson', 'imagesJson', 'status'];
  fields.forEach((f) => {
    if (data[f] !== undefined) branch[f] = data[f];
  });
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

module.exports = {
  getProfile,
  updateProfile,
  listBranches,
  createBranch,
  getBranch,
  updateBranch,
  deleteBranch,
  listStaff,
  assignStaff,
  removeStaff,
};
