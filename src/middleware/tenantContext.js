const { getRedisClient } = require('../config/redis.config');
const TenantDbManager = require('../database/TenantDbManager');

const CACHE_TTL_SECONDS = 3600; // 1 hour

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
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'This route requires a tenant context. Ensure you are logged in as a gym host or branch manager.',
      });
    }

    const redis = getRedisClient();
    const cacheKey = `tenant:${tenantId}:connStr`;

    let encryptedConnStr = await redis.get(cacheKey);

    if (!encryptedConnStr) {
      // Lazy-require to avoid circular dependency at module load time
      const { Tenant } = require('../models/platform');

      const tenant = await Tenant.findOne({
        where: { id: tenantId, status: 'ACTIVE' },
        attributes: ['id', 'connectionStringEncrypted', 'status'],
      });

      if (!tenant) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found or not active',
        });
      }

      if (!tenant.connectionStringEncrypted) {
        return res.status(503).json({
          success: false,
          message: 'Tenant database is not provisioned yet. Please wait for admin approval.',
        });
      }

      encryptedConnStr = tenant.connectionStringEncrypted;
      await redis.setex(cacheKey, CACHE_TTL_SECONDS, encryptedConnStr);
    }

    req.tenantDb = await TenantDbManager.getConnection(tenantId, encryptedConnStr);
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = tenantContext;
