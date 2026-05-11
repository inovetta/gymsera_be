const { GymListing, Tenant } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError } = require('../utils/response.utils');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a tenant DB connection from a GymListing UUID.
 * Used by public-facing routes that don't have JWT tenantContext.
 */
const _tenantFromGymListing = async (gymListingId) => {
  const listing = await GymListing.findOne({
    where: { id: gymListingId, status: 'ACTIVE' },
    attributes: ['id', 'tenantId', 'title'],
  });
  if (!listing) throw createError('Gym not found or not active', 404);

  const tenant = await Tenant.findOne({
    where: { id: listing.tenantId, status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });
  if (!tenant) throw createError('Gym tenant not available', 503);

  const { models } = await TenantDbManager.getConnection(
    tenant.id,
    tenant.connectionStringEncrypted
  );
  return { models, gymListing: listing };
};

/**
 * Resolve the tenant's Gym record (needed for new plan gymId).
 */
const _getGym = async (models) => {
  const gym = await models.Gym.findOne();
  if (!gym) throw createError('Gym profile not found', 404);
  return gym;
};

// ── Public: list active plans for a gym ──────────────────────────────────────
const listPublic = async (gymListingId, branchId) => {
  const { models } = await _tenantFromGymListing(gymListingId);
  const where = { status: 'ACTIVE' };
  if (branchId) where.branchId = branchId;
  // Gym-wide plans OR branch-specific plans for the requested branch
  const plans = await models.MembershipPlan.findAll({ where, order: [['price', 'ASC']] });
  return plans;
};

// ── Public: single plan ───────────────────────────────────────────────────────
const getPublic = async (planId, gymListingId) => {
  const { models } = await _tenantFromGymListing(gymListingId);
  const plan = await models.MembershipPlan.findOne({
    where: { id: planId, status: 'ACTIVE' },
  });
  if (!plan) throw createError('Plan not found', 404);
  return plan;
};

// ── Host: list all plans (active + inactive) for the gym ────────────────────
const listForHost = async (tenantDb, branchId) => {
  const { MembershipPlan } = tenantDb.models;
  const where = {};
  if (branchId) where.branchId = branchId;
  const plans = await MembershipPlan.findAll({ where, order: [['createdAt', 'DESC']] });
  return plans;
};

// ── Host: create plan ─────────────────────────────────────────────────────────
const createPlan = async (tenantDb, data) => {
  const { MembershipPlan, Branch } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  // Validate branchId belongs to this gym
  if (data.branchId) {
    const branch = await Branch.findOne({ where: { id: data.branchId, gymId: gym.id } });
    if (!branch) throw createError('Branch not found in this gym', 404);
  }

  const plan = await MembershipPlan.create({
    gymId: gym.id,
    branchId: data.branchId || null,
    name: data.name,
    description: data.description || null,
    durationType: data.durationType,
    durationValue: data.durationValue,
    price: data.price,
    joiningFee: data.joiningFee ?? 0,
    securityFee: data.securityFee ?? 0,
    visitLimit: data.visitLimit ?? null,
    freezeLimitDays: data.freezeLimitDays ?? 0,
    isTrial: data.isTrial ?? false,
    status: 'ACTIVE',
  });

  return plan;
};

// ── Host: update plan ─────────────────────────────────────────────────────────
const updatePlan = async (tenantDb, planId, data) => {
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id } });
  if (!plan) throw createError('Plan not found', 404);

  const allowed = ['name', 'description', 'durationType', 'durationValue', 'price',
    'joiningFee', 'securityFee', 'visitLimit', 'freezeLimitDays', 'isTrial', 'status'];
  const patch = {};
  for (const key of allowed) {
    if (data[key] !== undefined) patch[key] = data[key];
  }

  await plan.update(patch);
  return plan.reload();
};

// ── Host: delete (archive) plan ───────────────────────────────────────────────
const deletePlan = async (tenantDb, planId) => {
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id } });
  if (!plan) throw createError('Plan not found', 404);

  await plan.update({ status: 'INACTIVE' });
  return { message: 'Plan archived successfully' };
};

// ── Host: toggle plan status (ACTIVE ↔ INACTIVE) ─────────────────────────────
const toggleStatus = async (tenantDb, planId) => {
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id } });
  if (!plan) throw createError('Plan not found', 404);

  const newStatus = plan.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
  await plan.update({ status: newStatus });
  return { id: plan.id, status: newStatus };
};

// ── Host: update plan poster image ────────────────────────────────────────────
const updatePoster = async (tenantDb, planId, posterUrl) => {
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id } });
  if (!plan) throw createError('Plan not found', 404);

  await plan.update({ posterUrl });
  return { id: plan.id, posterUrl };
};

module.exports = {
  listPublic, getPublic, listForHost,
  createPlan, updatePlan, deletePlan,
  toggleStatus, updatePoster,
};
