const { Op } = require('sequelize');
const { safeRedisGet, safeRedisSetex } = require('../config/redis.config');
const TenantDbManager = require('../database/TenantDbManager');

const CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * Helper to find active staff record in tenantDb and elevate user role
 */
const _findAndElevateStaff = async (tenantDb, user, branchId = null) => {
  if (!user || !tenantDb?.models?.GymStaff) return null;

  const userId = user.id || user.sub;
  const userEmail = user.email ? user.email.toLowerCase().trim() : null;

  const userConditions = [];
  if (userId) userConditions.push({ userId });
  if (userEmail) userConditions.push({ email: userEmail });

  if (userConditions.length === 0) return null;

  const statusConditions = [
    { status: 'active' },
    { employmentStatus: 'ACTIVE' },
  ];

  const whereClause = {
    [Op.or]: userConditions,
    [Op.and]: [{ [Op.or]: statusConditions }],
  };

  let staff = null;
  if (branchId) {
    staff = await tenantDb.models.GymStaff.findOne({
      where: {
        ...whereClause,
        branchId,
      },
    });
  }

  if (!staff) {
    staff = await tenantDb.models.GymStaff.findOne({
      where: whereClause,
    });
  }

  if (staff) {
    // If staff was matched by email or was pending, link and activate
    if (userId && (!staff.userId || staff.status !== 'active')) {
      await staff.update({ userId, status: 'active' }).catch(() => {});
    }
    user.role = 'BRANCH_MANAGER';
    user.branchId = staff.branchId;
    return staff;
  }

  return null;
};

/**
 * tenantContext — resolves the Sequelize instance for the current request's tenant.
 *
 * Requires authenticate middleware to run first (populates req.user).
 * Attaches req.tenantDb = { sequelize, models } for use in controllers.
 *
 * Flow:
 *   JWT tenantId claim
 *     → Redis cache (key: tenant:{id}:connStr)
 *     → Platform DB (Tenant.connectionStringEncrypted)
 *     → TenantDbManager.getConnection(tenantId, encryptedConnStr)
 *     → req.tenantDb
 */
const tenantContext = async (req, res, next) => {
  try {
    let tenantId = req.user?.tenantId;

    if (!tenantId) {
      tenantId = req.headers['x-tenant-id'] || req.query.tenantId || req.body.tenantId;

      const branchId = req.params.branchId || req.query.branchId || req.body.branchId;
      if (!tenantId && branchId) {
        const branchCacheKey = `branch:${branchId}:tenantId`;
        tenantId = await safeRedisGet(branchCacheKey);

        if (!tenantId) {
          const { Tenant } = require('../models/platform');
          const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
          for (const t of tenants) {
            try {
              const tDb = await TenantDbManager.getConnection(t.id, t.connectionStringEncrypted);
              const exists = await tDb.models.Branch.findByPk(branchId);
              if (exists) {
                tenantId = t.id;
                await safeRedisSetex(branchCacheKey, CACHE_TTL_SECONDS, tenantId);
                break;
              }
            } catch (err) {
              // Ignore
            }
          }
        }
      }

      if (!tenantId && (req.user?.id || req.user?.sub || req.user?.email)) {
        const { Tenant } = require('../models/platform');
        const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
        for (const t of tenants) {
          try {
            const tDb = await TenantDbManager.getConnection(t.id, t.connectionStringEncrypted);
            const staff = await _findAndElevateStaff(tDb, req.user, branchId);
            if (staff) {
              tenantId = t.id;
              break;
            }
          } catch (err) {
            // Ignore
          }
        }
      }
    }

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'This route requires a tenant context. Ensure you are logged in as a gym host or branch manager.',
      });
    }

    const cacheKey = `tenant:${tenantId}:connStr`;

    let encryptedConnStr = await safeRedisGet(cacheKey);

    if (!encryptedConnStr) {
      // Lazy-require to avoid circular dependency at module load time
      const { Tenant } = require('../models/platform');

      const tenant = await Tenant.findOne({
        where: { id: tenantId, status: ['ACTIVE', 'SUSPENDED'] },
        attributes: ['id', 'connectionStringEncrypted', 'status'],
      });

      if (!tenant) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found or not active',
        });
      }

      if (tenant.status === 'SUSPENDED') {
        await tenant.update({ status: 'ACTIVE' }).catch(() => {});
      }

      if (!tenant.connectionStringEncrypted) {
        return res.status(503).json({
          success: false,
          message: 'Tenant database is not provisioned yet. Please wait for admin approval.',
        });
      }

      encryptedConnStr = tenant.connectionStringEncrypted;
      await safeRedisSetex(cacheKey, CACHE_TTL_SECONDS, encryptedConnStr);
    }

    req.tenantDb = await TenantDbManager.getConnection(tenantId, encryptedConnStr);

    // If user is a traveler (MEMBER) or BRANCH_MANAGER, verify staff status in the resolved tenant DB
    if (req.user && (req.user.role === 'MEMBER' || req.user.role === 'BRANCH_MANAGER')) {
      const branchId = req.params.branchId || req.query.branchId || req.body.branchId;
      await _findAndElevateStaff(req.tenantDb, req.user, branchId);
    }

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = tenantContext;
