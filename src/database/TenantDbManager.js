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

    // Access-control tables. Additive and idempotent, so it is safe to run on
    // every connection in every environment — including production, where
    // sequelize.sync() deliberately does not run.
    try {
      const { ensureAccessControlTables } = require('./rbac-migration');
      await ensureAccessControlTables(sequelize, tenantId);
    } catch (rbacErr) {
      console.warn(`[TenantDbManager] RBAC table check warning for tenant ${tenantId}:`, rbacErr.message);
    }

    try {
      const { ensureLedgerTables } = require('./ledger-migration');
      await ensureLedgerTables(sequelize, tenantId);
    } catch (ledgerErr) {
      console.warn(`[TenantDbManager] Ledger table check warning for tenant ${tenantId}:`, ledgerErr.message);
    }

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
      if (branchCols && !branchCols.timezone) {
        await sequelize.query("ALTER TABLE branches ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Karachi'").catch(() => { });
      }

      // Pre-approval collection: lets whoever is physically holding the cash mark
      // a still-PENDING request as collected — from them, correctly attributed —
      // instead of the eventual approver silently becoming the payment's
      // collector of record when the request executes. See approval.service.js
      // #markCollected and gym.service.js#enrollMember's `collection` param.
      const approvalCols = await queryInterface.describeTable('approval_requests').catch(() => ({}));
      if (approvalCols && !approvalCols.collected_by) {
        await sequelize.query('ALTER TABLE approval_requests ADD COLUMN collected_by CHAR(36) NULL').catch(() => { });
      }
      if (approvalCols && !approvalCols.collected_at) {
        await sequelize.query('ALTER TABLE approval_requests ADD COLUMN collected_at DATETIME NULL').catch(() => { });
      }
      if (approvalCols && !approvalCols.collection_method) {
        await sequelize.query('ALTER TABLE approval_requests ADD COLUMN collection_method VARCHAR(30) NULL').catch(() => { });
      }
      if (approvalCols && !approvalCols.collection_notes) {
        await sequelize.query('ALTER TABLE approval_requests ADD COLUMN collection_notes TEXT NULL').catch(() => { });
      }

      // Ledger: the business date a payment is collected on (branch-timezone,
      // stamped once at write time — see ledger.service.js#computeBusinessDate)
      // and an optional idempotency key so a retried/double-tapped submission
      // can't record the same collection twice.
      const paymentCols = await queryInterface.describeTable('payments').catch(() => ({}));
      if (paymentCols && !paymentCols.business_date) {
        await sequelize.query('ALTER TABLE payments ADD COLUMN business_date DATE NULL').catch(() => { });
        await sequelize.query('ALTER TABLE payments ADD INDEX payments_branch_business_date (branch_id, business_date, status)').catch(() => { });
      }
      if (paymentCols && !paymentCols.idempotency_key) {
        await sequelize.query('ALTER TABLE payments ADD COLUMN idempotency_key VARCHAR(120) NULL').catch(() => { });
        await sequelize.query('ALTER TABLE payments ADD UNIQUE INDEX payments_idempotency_unique (idempotency_key)').catch(() => { });
      }
      if (paymentCols && !paymentCols.printed_at) {
        await sequelize.query('ALTER TABLE payments ADD COLUMN printed_at DATETIME NULL').catch(() => { });
      }
      if (paymentCols && !paymentCols.printed_by) {
        await sequelize.query('ALTER TABLE payments ADD COLUMN printed_by CHAR(36) NULL').catch(() => { });
      }
      // One-time backfill for rows that predate the column. Approximate (DB-server
      // date of paid_at/created_at, not branch-local) — acceptable for historical
      // records; every payment recorded from here on gets the real branch-timezone
      // business date at write time, which is what daily close actually depends on.
      await sequelize.query(
        "UPDATE payments SET business_date = DATE(COALESCE(paid_at, created_at)) WHERE business_date IS NULL"
      ).catch(() => { });

      const gymCols = await queryInterface.describeTable('gyms').catch(() => ({}));
      if (gymCols && !gymCols.gym_listing_id) {
        await sequelize.query('ALTER TABLE gyms ADD COLUMN gym_listing_id CHAR(36) NULL').catch(() => { });
      }

      // Backfill ONLY: attach a branch/gym that has never had a
      // gymListingId at all to the tenant's first organization. This never
      // touches `status` on anything, on purpose.
      //
      // Until 2026-09-25 this block (still visible in git history) also
      // unconditionally forced tenant.status, the subscription's
      // status/endDate, the primary listing's status, AND every branch
      // matching `status = 'INACTIVE' OR gym_listing_id IS NULL` back to
      // ACTIVE — on every tenant's *first* getConnection call after a
      // connection-pool cache miss (this.pool.has(tenantId) false), which
      // happens on every process restart (every deploy, every iisreset) and
      // every explicit TenantDbManager.release(tenantId) call.
      //
      // That is exactly suspendTenant/rejectTenant's own cache-eviction
      // call, and _reconcileCapacityForAllTenants (the daily cron) opens a
      // connection for every ACTIVE subscription with no tenant.status
      // filter at all — so a SUSPENDED tenant with a still-ACTIVE
      // subscription (the normal case: suspension doesn't cancel billing)
      // was un-suspended by the very next daily cron run, every single day,
      // with no admin action able to make it stick. The same query also
      // silently resurrected every deleted branch and reset any lapsed
      // subscription to a fresh year — with zero CapacityEvent row, zero
      // reservedSlots debit, and a bare `.catch(() => {})` swallowing any
      // sign it had run at all. This is almost certainly the "it comes back
      // free after a while" a host reported: "after a while" was "after the
      // next deploy or daily cron run."
      //
      // A tenant/subscription/listing/branch's status is a real application
      // decision — approve, suspend, delete, restore, expire — each already
      // owned by its own dedicated, guarded code path (deleteBranch,
      // restoreBranch, suspendTenant, the expiry cron...). None of those
      // decisions may ever be silently reversed by opening a database
      // connection to read from it.
      const { GymListing } = require('../models/platform');
      const firstListing = await GymListing.findOne({ where: { tenantId, status: { [Sequelize.Op.ne]: 'INACTIVE' } } }).catch(() => null);
      if (firstListing) {
        await sequelize.query(
          `UPDATE branches SET gym_listing_id = '${firstListing.id}' WHERE gym_listing_id IS NULL OR gym_listing_id = ''`
        ).catch(() => { });
        await sequelize.query(
          `UPDATE gyms SET gym_listing_id = '${firstListing.id}' WHERE gym_listing_id IS NULL OR gym_listing_id = ''`
        ).catch(() => { });
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

    const entry = { sequelize, models, tenantId };
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
