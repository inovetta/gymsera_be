const { Sequelize } = require('sequelize');
const { decrypt } = require('../utils/crypto.utils');
const registerTenantModels = require('../models/tenant');

/**
 * TenantDbManager
 *
 * Maintains a pool of Sequelize instances, one per tenant.
 * Keyed by tenantId — connections are reused across requests.
 *
 * Usage:
 *   const { models } = await TenantDbManager.getConnection(tenantId, encryptedConnStr);
 *   const { Gym, Branch } = models;
 */
class TenantDbManager {
  constructor() {
    /** @type {Map<string, { sequelize: Sequelize, models: object }>} */
    this.pool = new Map();
  }

  /**
   * Return (or create) the Sequelize instance + models for a tenant.
   * @param {string} tenantId              UUID of the tenant
   * @param {string} encryptedConnStr      AES-256 encrypted MySQL connection URL
   */
  async getConnection(tenantId, encryptedConnStr) {
    if (this.pool.has(tenantId)) {
      return this.pool.get(tenantId);
    }

    const connUrl = decrypt(encryptedConnStr);

    const sequelize = new Sequelize(connUrl, {
      dialect: 'mysql',
      logging: false,
      pool: { max: 5, min: 0, acquire: 20000, idle: 10000 },
      dialectOptions: {
        connectTimeout: 20000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
      },
      define: { underscored: true, timestamps: true },
    });

    await sequelize.authenticate();

    const models = registerTenantModels(sequelize);

    if (process.env.NODE_ENV === 'development') {
      try {
        await sequelize.sync({ force: false, alter: true });
        console.log(`[TenantDbManager] Schema auto-synced for tenant: ${tenantId}`);
      } catch (err) {
        console.error(`[TenantDbManager] Schema auto-sync failed for tenant ${tenantId}:`, err.message);
      }
    }

    const entry = { sequelize, models };
    this.pool.set(tenantId, entry);
    return entry;
  }

  /**
   * Close and remove a tenant connection from the pool.
   * Called during tenant suspension or when cleaning up stale connections.
   */
  async release(tenantId) {
    const entry = this.pool.get(tenantId);
    if (entry) {
      await entry.sequelize.close();
      this.pool.delete(tenantId);
    }
  }

  /**
   * Close all pooled connections. Called on graceful shutdown.
   */
  async releaseAll() {
    const promises = [];
    for (const [tenantId] of this.pool) {
      promises.push(this.release(tenantId));
    }
    await Promise.all(promises);
  }

  /**
   * Return all currently-pooled [tenantId, tenantDb] entries.
   * Used by the subscription expiry cron to iterate live connections.
   * @returns {Array<[string, { sequelize, models }]>}
   */
  getAllEntries() {
    return [...this.pool.entries()];
  }
}

module.exports = new TenantDbManager();
