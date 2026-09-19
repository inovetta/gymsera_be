const { GymListing, Tenant } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError } = require('../utils/response.utils');
const { Op, QueryTypes } = require('sequelize');

// ── Helpers ───────────────────────────────────────────────────────────────────

const _ensureSchema = async (tenantDb) => {
  const seq = tenantDb?.sequelize || tenantDb;
  if (!seq || typeof seq.getQueryInterface !== 'function') return;
  try {
    const queryInterface = seq.getQueryInterface();
    const planCols = await queryInterface.describeTable('membership_plans').catch(() => ({}));
    if (planCols && !planCols.is_deactivated) {
      await seq.query('ALTER TABLE membership_plans ADD COLUMN is_deactivated TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
    }
  } catch (err) {
    try {
      await seq.query('ALTER TABLE membership_plans ADD COLUMN is_deactivated BOOLEAN NOT NULL DEFAULT false').catch(() => {});
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
 *
 * `transaction` — pass the caller's own platform-DB transaction when one is
 * already open (e.g. gym.service.js#createBranch holds a row lock on this
 * exact GymListing via `FOR UPDATE` for its whole duration). Without this,
 * the plain UPDATE below opens a SECOND, unrelated connection and blocks on
 * its own caller's still-held lock until MySQL's innodb_lock_wait_timeout
 * (50s by default) — a real, reproducible ~50s tax on every branch creation
 * that includes a membership plan, found via live end-to-end testing, not
 * something the try/catch's silent failure ever surfaced. Passing the same
 * transaction through makes this UPDATE part of the same unit of work
 * instead of a competing one.
 */
const _syncMinPrice = async (tenantDb, gymId, { transaction } = {}) => {
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
      { where: { id: gym.gymListingId }, transaction }
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

const _ensureTenantOnboardingPlans = async (tenantDb, tenantId) => {
  if (!tenantId) return;
  try {
    const { MembershipPlan, Branch, Gym } = tenantDb.models;
    const planCount = await MembershipPlan.count();
    if (planCount > 0) return;

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) return;

    let b = tenant.mainBranchDataJson;
    if (typeof b === 'string') {
      try { b = JSON.parse(b); } catch (e) { b = {}; }
    }
    b = b || {};

    const rawPlans = (Array.isArray(b.plans) && b.plans.length > 0)
      ? b.plans
      : (Array.isArray(b.packages) && b.packages.length > 0 ? b.packages : []);

    let gym = await Gym.findOne();
    if (!gym && tenant.gymName) {
      gym = await Gym.create({
        name: tenant.gymName,
        description: tenant.gymDescription || null,
        contactPhone: tenant.phone || null,
        genderType: tenant.genderType || 'MIXED',
      });
    }

    if (gym) {
      let branch = await Branch.findOne({ where: { gymId: gym.id } }) || await Branch.findOne();
      if (!branch) {
        branch = await Branch.create({
          gymId: gym.id,
          branchName: b.name || tenant.gymName || 'Main Branch',
          address: b.address || tenant.address || null,
          cityId: b.cityId || tenant.cityId || null,
          status: 'ACTIVE',
          travelerVisibilityStatus: 'active',
        });
      }

      if (branch && rawPlans.length > 0) {
        for (const p of rawPlans) {
          if (!p || !p.name || p.price === undefined || p.price === null) continue;
          try {
            const pPrice = parseFloat(p.price) || 0;
            let durationType = String(p.durationType || 'MONTHLY').toUpperCase();
            if (!['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'].includes(durationType)) {
              if (durationType.includes('DAY') || durationType.includes('DAILY')) durationType = 'DAILY';
              else if (durationType.includes('WEEK')) durationType = 'WEEKLY';
              else if (durationType.includes('QUART')) durationType = 'QUARTERLY';
              else if (durationType.includes('YEAR') || durationType.includes('ANNUAL')) durationType = 'YEARLY';
              else durationType = 'MONTHLY';
            }
            const durationValue = parseInt(p.durationValue, 10) || 1;
            const joiningFee = parseFloat(p.joiningFee) || 0;
            const securityFee = parseFloat(p.securityFee) || 0;
            const visitLimit = (p.visitLimit !== undefined && p.visitLimit !== null && p.visitLimit !== '')
              ? parseInt(p.visitLimit, 10) : null;
            const freezeLimitDays = parseInt(p.freezeLimitDays, 10) || 0;
            const isTrial = Boolean(p.isTrial);
            const isPublic = p.isPublic !== undefined ? Boolean(p.isPublic) : true;

            await MembershipPlan.create({
              gymId: gym.id,
              branchId: branch.id,
              name: p.name.trim(),
              description: p.description || null,
              durationType,
              durationValue,
              price: pPrice,
              joiningFee,
              securityFee,
              visitLimit,
              freezeLimitDays,
              isTrial,
              isPublic,
              isDeactivated: false,
              status: 'ACTIVE',
            });
            console.log(`[MembershipPlan] Auto-synced onboarding plan '${p.name}' for tenant ${tenantId}`);
          } catch (err) {
            console.warn('[MembershipPlan] Auto-sync plan error:', err.message);
          }
        }
        await _syncMinPrice(tenantDb, gym.id).catch(() => {});
      }
    }
  } catch (syncErr) {
    console.warn('[MembershipPlan] Auto-sync check failed:', syncErr.message);
  }
};

// ── Host: list all active and inactive plans for the gym ──────────────────────
const listForHost = async (tenantDb, branchId, tenantId) => {
  await _ensureSchema(tenantDb);
  await _ensureTenantOnboardingPlans(tenantDb, tenantId);

  const { MembershipPlan, Branch } = tenantDb.models;
  const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
  const activeBranchIds = activeBranches.map((b) => b.id);

  const where = {};
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
// `transaction` — forwarded to _syncMinPrice; pass the caller's open
// platform-DB transaction when creating a plan as part of a larger unit of
// work that already holds a lock on this gym's GymListing (see
// _syncMinPrice's doc comment for exactly why this matters).
const createPlan = async (tenantDb, data, { transaction } = {}) => {
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

  await _syncMinPrice(tenantDb, gym.id, { transaction });
  return plan;
};

const _validateRemainingPlansForBranch = async (tenantDb, plan, actionVerb = 'remove') => {
  if (!plan.branchId) return;
  const { Branch, MembershipPlan } = tenantDb.models;
  const branch = await Branch.findByPk(plan.branchId);
  if (branch && branch.status === 'ACTIVE') {
    const remainingCount = await MembershipPlan.count({
      where: {
        branchId: plan.branchId,
        id: { [Op.ne]: plan.id },
        status: 'ACTIVE',
        isDeactivated: false,
        isPublic: true,
      },
    });
    if (remainingCount === 0) {
      throw createError(
        `Cannot ${actionVerb} the only active membership plan for an active branch. Every branch must have at least 1 active plan.`,
        400
      );
    }
  }
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

  if (patch.status === 'INACTIVE' || patch.isDeactivated === true || patch.isPublic === false) {
    await _validateRemainingPlansForBranch(tenantDb, plan, 'modify');
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

  await _validateRemainingPlansForBranch(tenantDb, plan, 'delete');

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
  if (newIsDeactivated) {
    await _validateRemainingPlansForBranch(tenantDb, plan, 'deactivate');
  }

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
  if (!newIsPublic) {
    await _validateRemainingPlansForBranch(tenantDb, plan, 'unpublish');
  }

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
  // Exported so other services (gym.service.js#deleteBranch/restoreBranch)
  // can re-sync minPrice after an operation that changes which plans are
  // active, without duplicating this logic.
  syncMinPrice: _syncMinPrice,
};
