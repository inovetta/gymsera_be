const { GymListing, Tenant } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError } = require('../utils/response.utils');
const { Op } = require('sequelize');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a tenant DB connection from a GymListing UUID.
 * Used by public-facing routes that don't have JWT tenantContext.
 */
const _tenantFromGymListing = async (gymListingId) => {
  let listing = await GymListing.findOne({
    where: { id: gymListingId, status: 'ACTIVE' },
    attributes: ['id', 'tenantId', 'title', 'branchId'],
  });

  let tenantId = listing ? listing.tenantId : null;
  let branchId = listing ? listing.branchId : null;

  if (!listing) {
    // If listing not found, it could be a branch ID directly
    const tenants = await Tenant.findAll({
      where: { status: 'ACTIVE' },
      attributes: ['id', 'connectionStringEncrypted'],
    });

    for (const t of tenants) {
      try {
        if (!t.connectionStringEncrypted || t.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
        const tenantDb = await TenantDbManager.getConnection(t.id, t.connectionStringEncrypted);
        const { Branch } = tenantDb.models;
        const branch = await Branch.findByPk(gymListingId);
        if (branch) {
          tenantId = t.id;
          branchId = branch.id;
          if (branch.gymListingId) {
            listing = await GymListing.findOne({
              where: { id: branch.gymListingId, status: 'ACTIVE' },
              attributes: ['id', 'tenantId', 'title', 'branchId'],
            });
          }
          break;
        }
      } catch (err) {
        // Ignore
      }
    }
  }

  if (!tenantId) throw createError('Gym not found or not active', 404);

  const tenant = await Tenant.findOne({
    where: { id: tenantId, status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });
  if (!tenant) throw createError('Gym tenant not available', 503);

  const { models } = await TenantDbManager.getConnection(
    tenant.id,
    tenant.connectionStringEncrypted
  );
  return { models, gymListing: listing, branchId };
};

/**
 * Resolve the tenant's Gym record (needed for new plan gymId).
 */
const _getGym = async (models) => {
  const gym = await models.Gym.findOne();
  if (!gym) throw createError('Gym profile not found', 404);
  return gym;
};

/**
 * Recalculate and push minPrice to the platform GymListing.
 * Priority order:
 *   1. If a plan is marked isFeatured, use its price.
 *   2. Otherwise fall back to the cheapest ACTIVE + public plan.
 *   3. If no qualifying plans exist, set minPrice to null.
 */
const _syncMinPrice = async (tenantDb, gymId) => {
  try {
    const { MembershipPlan } = tenantDb.models;

    // 1. Check for a manually featured plan
    let featured = await MembershipPlan.findOne({
      where: { gymId, isFeatured: true, status: 'ACTIVE' },
      attributes: ['price'],
    });

    // 2. Fall back to cheapest public plan
    if (!featured) {
      featured = await MembershipPlan.findOne({
        where: { gymId, status: 'ACTIVE', isPublic: true },
        order: [['price', 'ASC']],
        attributes: ['price'],
      });
    }

    // Find the GymListing linked to this tenant
    const gym = await tenantDb.models.Gym.findOne({ attributes: ['gymListingId'] });
    if (!gym || !gym.gymListingId) return;

    await GymListing.update(
      { minPrice: featured ? parseFloat(featured.price) : null },
      { where: { id: gym.gymListingId } }
    );
  } catch (err) {
    // Non-fatal: log and continue — minPrice sync failure shouldn't block the plan operation
    console.error('[minPrice sync] Failed:', err.message);
  }
};

// ── Public: list active + public plans for a gym ──────────────────────────────
const listPublic = async (gymListingId, branchId) => {
  const { models, branchId: resolvedBranchId } = await _tenantFromGymListing(gymListingId);
  const targetBranchId = branchId || resolvedBranchId;

  const where = { status: 'ACTIVE', isPublic: true };
  if (targetBranchId) {
    where.branchId = {
      [Op.or]: [targetBranchId, null],
    };
  } else {
    where.branchId = null;
  }
  // Gym-wide plans OR branch-specific plans for the requested branch
  const plans = await models.MembershipPlan.findAll({ where, order: [['price', 'ASC']] });
  return plans;
};

// ── Public: single plan ───────────────────────────────────────────────────────
const getPublic = async (planId, gymListingId) => {
  const { models } = await _tenantFromGymListing(gymListingId);
  const plan = await models.MembershipPlan.findOne({
    where: { id: planId, status: 'ACTIVE', isPublic: true },
  });
  if (!plan) throw createError('Plan not found', 404);
  return plan;
};

// ── Host: list all plans (active + inactive) for the gym ────────────────────
const listForHost = async (tenantDb, branchId) => {
  const { MembershipPlan } = tenantDb.models;
  const where = {};
  if (branchId) {
    where.branchId = {
      [Op.or]: [branchId, null],
    };
  }
  const plans = await MembershipPlan.findAll({ where, order: [['createdAt', 'DESC']] });
  return plans;
};

// ── Host: create plan ─────────────────────────────────────────────────────────
const createPlan = async (tenantDb, data) => {
  const { MembershipPlan, Branch } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  // Validate branchId belongs to this gym
  if (data.branchId) {
    const branch = await Branch.findByPk(data.branchId);
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
    isPublic: data.isPublic ?? false,
    status: 'ACTIVE',
  });

  await _syncMinPrice(tenantDb, gym.id);
  return plan;
};

// ── Host: update plan ─────────────────────────────────────────────────────────
const updatePlan = async (tenantDb, planId, data) => {
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id } });
  if (!plan) throw createError('Plan not found', 404);

  const allowed = ['name', 'description', 'durationType', 'durationValue', 'price',
    'joiningFee', 'securityFee', 'visitLimit', 'freezeLimitDays', 'isTrial', 'isPublic', 'status'];
  const patch = {};
  for (const key of allowed) {
    if (data[key] !== undefined) patch[key] = data[key];
  }

  await plan.update(patch);
  await _syncMinPrice(tenantDb, gym.id);
  return plan.reload();
};

// ── Host: delete (archive) plan ───────────────────────────────────────────────
const deletePlan = async (tenantDb, planId) => {
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id } });
  if (!plan) throw createError('Plan not found', 404);

  await plan.update({ status: 'INACTIVE' });
  await _syncMinPrice(tenantDb, gym.id);
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
  await _syncMinPrice(tenantDb, gym.id);
  return { id: plan.id, status: newStatus };
};

// ── Host: toggle public visibility (isPublic) ─────────────────────────────────
const togglePublic = async (tenantDb, planId) => {
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id } });
  if (!plan) throw createError('Plan not found', 404);

  const newIsPublic = !plan.isPublic;
  await plan.update({ isPublic: newIsPublic });
  await _syncMinPrice(tenantDb, gym.id);
  return { id: plan.id, isPublic: newIsPublic };
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

// ── Host: set a plan as the featured ("Starting from") plan ──────────────────
// Unfeatures all other plans for this gym, then features the requested one.
// Calling this on an already-featured plan unfeatures it (toggle behaviour).
const setFeatured = async (tenantDb, planId) => {
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id } });
  if (!plan) throw createError('Plan not found', 404);

  const newIsFeatured = !plan.isFeatured;

  // Clear featured flag on all other plans for this gym
  await MembershipPlan.update(
    { isFeatured: false },
    { where: { gymId: gym.id } }
  );

  // Set featured on this plan (if toggling ON)
  if (newIsFeatured) {
    await plan.update({ isFeatured: true });
  }

  await _syncMinPrice(tenantDb, gym.id);
  return { id: plan.id, isFeatured: newIsFeatured };
};

module.exports = {
  listPublic, getPublic, listForHost,
  createPlan, updatePlan, deletePlan,
  toggleStatus, togglePublic, setFeatured, updatePoster,
};
