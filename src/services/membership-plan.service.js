const { GymListing, Tenant } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError } = require('../utils/response.utils');
const { Op, QueryTypes } = require('sequelize');

// ── Helpers ───────────────────────────────────────────────────────────────────

const _ensureSchema = async (tenantDb) => {
  if (!tenantDb || !tenantDb.query) return;
  try {
    const queryType = (tenantDb.QueryTypes && tenantDb.QueryTypes.SELECT) || QueryTypes.SELECT;
    const existing = await tenantDb.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'membership_plans' AND COLUMN_NAME = 'is_deactivated'",
      { type: queryType }
    );
    if (!existing || existing.length === 0) {
      await tenantDb.query('ALTER TABLE `membership_plans` ADD COLUMN `is_deactivated` TINYINT(1) NOT NULL DEFAULT 0');
    }
  } catch (err) {
    try {
      await tenantDb.query('ALTER TABLE membership_plans ADD COLUMN is_deactivated BOOLEAN NOT NULL DEFAULT false');
    } catch (_) {}
  }
};

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

  const tenantDb = await TenantDbManager.getConnection(
    tenant.id,
    tenant.connectionStringEncrypted
  );
  await _ensureSchema(tenantDb);
  return { tenantDb, models: tenantDb.models, gymListing: listing, branchId };
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
      where: { gymId, isFeatured: true, status: 'ACTIVE', isDeactivated: false },
      attributes: ['price'],
    });

    // 2. Fall back to cheapest public plan
    if (!featured) {
      featured = await MembershipPlan.findOne({
        where: { gymId, status: 'ACTIVE', isPublic: true, isDeactivated: false },
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

  const where = { status: 'ACTIVE', isDeactivated: false, isPublic: true };
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
    where: { id: planId, status: 'ACTIVE', isDeactivated: false, isPublic: true },
  });
  if (!plan) throw createError('Plan not found', 404);
  return plan;
};

// ── Host: list all active plans for the gym (including deactivated ones for host management) ──
const listForHost = async (tenantDb, branchId) => {
  await _ensureSchema(tenantDb);
  const { MembershipPlan, Branch } = tenantDb.models;
  const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
  const activeBranchIds = activeBranches.map((b) => b.id);

  const where = {
    status: 'ACTIVE',
  };
  if (branchId) {
    where.branchId = {
      [Op.or]: [branchId, null],
    };
  } else if (activeBranchIds.length > 0) {
    where.branchId = {
      [Op.or]: [
        { [Op.in]: activeBranchIds },
        null,
      ],
    };
  }
  const plans = await MembershipPlan.findAll({ where, order: [['createdAt', 'DESC']] });
  return plans;
};

// ── Host: create plan ─────────────────────────────────────────────────────────
const createPlan = async (tenantDb, data) => {
  await _ensureSchema(tenantDb);
  const { MembershipPlan, Branch } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  // Validate branchId belongs to this gym and is active
  if (data.branchId) {
    const branch = await Branch.findOne({ where: { id: data.branchId, status: 'ACTIVE' } });
    if (!branch) throw createError('Branch not found or has been deleted', 404);
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
    isDeactivated: false,
    status: 'ACTIVE',
  });

  await _syncMinPrice(tenantDb, gym.id);
  return plan;
};

// ── Host: update plan ─────────────────────────────────────────────────────────
const updatePlan = async (tenantDb, planId, data) => {
  await _ensureSchema(tenantDb);
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id, status: 'ACTIVE' } });
  if (!plan) throw createError('Plan not found', 404);

  const allowed = ['name', 'description', 'durationType', 'durationValue', 'price',
    'joiningFee', 'securityFee', 'visitLimit', 'freezeLimitDays', 'isTrial', 'isPublic', 'isDeactivated', 'status'];
  const patch = {};
  for (const key of allowed) {
    if (data[key] !== undefined) patch[key] = data[key];
  }

  await plan.update(patch);
  await _syncMinPrice(tenantDb, gym.id);
  return plan.reload();
};

// ── Host: delete (soft delete: set status to INACTIVE) ────────────────────────
const deletePlan = async (tenantDb, planId) => {
  await _ensureSchema(tenantDb);
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({
    where: { id: planId, gymId: gym.id, status: 'ACTIVE' },
  });
  if (!plan) throw createError('Plan not found', 404);

  // Soft delete: set status to INACTIVE and remove from public listings
  await plan.update({
    status: 'INACTIVE',
    isPublic: false,
    isFeatured: false,
  });

  await _syncMinPrice(tenantDb, gym.id);
  return { message: 'Plan deleted successfully' };
};

// ── Host: toggle plan deactivation (isDeactivated: true ↔ false) ─────────────
const toggleStatus = async (tenantDb, planId) => {
  await _ensureSchema(tenantDb);
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id, status: 'ACTIVE' } });
  if (!plan) throw createError('Plan not found', 404);

  const newIsDeactivated = !plan.isDeactivated;
  const patch = { isDeactivated: newIsDeactivated };
  if (newIsDeactivated) {
    // If deactivating, unpublish and unfeature
    patch.isPublic = false;
    patch.isFeatured = false;
  }

  await plan.update(patch);
  await _syncMinPrice(tenantDb, gym.id);
  return plan.reload();
};

// ── Host: toggle public visibility (isPublic) ─────────────────────────────────
const togglePublic = async (tenantDb, planId) => {
  await _ensureSchema(tenantDb);
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id } });
  if (!plan) throw createError('Plan not found', 404);

  const newIsPublic = !plan.isPublic;
  await plan.update({ isPublic: newIsPublic });
  await _syncMinPrice(tenantDb, gym.id);
  return plan.reload();
};

// ── Host: update plan poster image ────────────────────────────────────────────
const updatePoster = async (tenantDb, planId, posterUrl) => {
  const { MembershipPlan } = tenantDb.models;
  const gym = await _getGym(tenantDb.models);

  const plan = await MembershipPlan.findOne({ where: { id: planId, gymId: gym.id } });
  if (!plan) throw createError('Plan not found', 404);

  await plan.update({ posterUrl });
  return plan.reload();
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
  return plan.reload();
};

module.exports = {
  listPublic, getPublic, listForHost,
  createPlan, updatePlan, deletePlan,
  toggleStatus, togglePublic, setFeatured, updatePoster,
};
