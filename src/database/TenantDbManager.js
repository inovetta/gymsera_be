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

    try {
      // Safe column migration for audit tracking across tenant tables
      const queryInterface = sequelize.getQueryInterface();
      const subCols = await queryInterface.describeTable('member_subscriptions').catch(() => ({}));
      if (subCols && !subCols.created_by) {
        await sequelize.query('ALTER TABLE member_subscriptions ADD COLUMN created_by CHAR(36) NULL').catch(() => { });
      }
      if (subCols && !subCols.created_by_role) {
        await sequelize.query('ALTER TABLE member_subscriptions ADD COLUMN created_by_role VARCHAR(30) NULL').catch(() => { });
      }

      const invCols = await queryInterface.describeTable('invoices').catch(() => ({}));
      if (invCols && !invCols.branch_id) {
        await sequelize.query('ALTER TABLE invoices ADD COLUMN branch_id CHAR(36) NULL').catch(() => { });
      }
      if (invCols && !invCols.created_by) {
        await sequelize.query('ALTER TABLE invoices ADD COLUMN created_by CHAR(36) NULL').catch(() => { });
      }
      if (invCols && !invCols.created_by_role) {
        await sequelize.query('ALTER TABLE invoices ADD COLUMN created_by_role VARCHAR(30) NULL').catch(() => { });
      }

      const planCols = await queryInterface.describeTable('membership_plans').catch(() => ({}));
      if (planCols && !planCols.is_deactivated) {
        await sequelize.query('ALTER TABLE membership_plans ADD COLUMN is_deactivated TINYINT(1) NOT NULL DEFAULT 0').catch(() => { });
      }

      const branchCols = await queryInterface.describeTable('branches').catch(() => ({}));
      if (branchCols && !branchCols.gym_listing_id) {
        await sequelize.query('ALTER TABLE branches ADD COLUMN gym_listing_id CHAR(36) NULL').catch(() => { });
      }

      const gymCols = await queryInterface.describeTable('gyms').catch(() => ({}));
      if (gymCols && !gymCols.gym_listing_id) {
        await sequelize.query('ALTER TABLE gyms ADD COLUMN gym_listing_id CHAR(36) NULL').catch(() => { });
      }

      // Unconditional backfill of gym_listing_id for branches with NULL listing
      const { GymListing } = require('../models/platform');
      const firstListing = await GymListing.findOne({ where: { tenantId } }).catch(() => null);
      if (firstListing) {
        await sequelize.query(`UPDATE branches SET gym_listing_id = '${firstListing.id}' WHERE gym_listing_id IS NULL OR gym_listing_id = ''`).catch(() => { });
        await sequelize.query(`UPDATE gyms SET gym_listing_id = '${firstListing.id}' WHERE gym_listing_id IS NULL OR gym_listing_id = ''`).catch(() => { });
      }
    } catch (migErr) {
      console.warn(`[TenantDbManager] Column check warning for tenant ${tenantId}:`, migErr.message);
    }

    if (process.env.NODE_ENV === 'development') {
      try {
        await sequelize.sync({ force: false, alter: true });
        console.log(`[TenantDbManager] Schema auto-synced for tenant: ${tenantId}`);

        // Backfill gymListingId for existing branches
        const { Branch } = models;
        const nullListingBranches = await Branch.findAll({ where: { gymListingId: null } });
        if (nullListingBranches.length > 0) {
          const { GymListing } = require('../models/platform');
          const firstListing = await GymListing.findOne({ where: { tenantId } });
          if (firstListing) {
            await Branch.update(
              { gymListingId: firstListing.id },
              { where: { gymListingId: null } }
            );
            console.log(`[TenantDbManager] Backfilled gymListingId (${firstListing.id}) for ${nullListingBranches.length} branches`);
          }
        }
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
