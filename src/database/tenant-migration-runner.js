/**
 * Tenant Database Migration Runner (spec §6.5)
 *
 * Implements the versioned tenant database migration policy:
 * - Records `schema_migrations` per tenant database (tracking `schemaVersion`).
 * - Runs once per tenant, is resumable, and produces a per-tenant failure report.
 * - Migrations are idempotent and safe to re-run.
 * - NEVER run as a side effect of `getConnection` (spec §6.5, §9.6).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { decrypt } = require('../utils/crypto.utils');
const { ensureAccessControlTables } = require('./rbac-migration');
const { ensureLedgerTables } = require('./ledger-migration');

const MIGRATIONS = [
  {
    version: 1,
    name: '001_ensure_rbac_tables',
    up: async (sequelize, context) => {
      await ensureAccessControlTables(sequelize, context?.tenantId || 'unknown');
    },
  },
  {
    version: 2,
    name: '002_ensure_ledger_tables',
    up: async (sequelize, context) => {
      await ensureLedgerTables(sequelize, context?.tenantId || 'unknown');
    },
  },
  {
    version: 3,
    name: '003_audit_and_tracking_columns',
    up: async (sequelize) => {
      const qi = sequelize.getQueryInterface();

      const ensureCol = async (table, col, ddl) => {
        const cols = await qi.describeTable(table).catch(() => ({}));
        if (cols && !cols[col]) {
          await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`).catch(() => {});
        }
      };

      // member_subscriptions
      await ensureCol('member_subscriptions', 'created_by', '`created_by` CHAR(36) NULL');
      await ensureCol('member_subscriptions', 'created_by_role', '`created_by_role` VARCHAR(30) NULL');

      // invoices
      await ensureCol('invoices', 'branch_id', '`branch_id` CHAR(36) NULL');
      await ensureCol('invoices', 'created_by', '`created_by` CHAR(36) NULL');
      await ensureCol('invoices', 'created_by_role', '`created_by_role` VARCHAR(30) NULL');

      // membership_plans
      await ensureCol('membership_plans', 'is_deactivated', '`is_deactivated` TINYINT(1) NOT NULL DEFAULT 0');

      // branches
      await ensureCol('branches', 'gym_listing_id', '`gym_listing_id` CHAR(36) NULL');
      await ensureCol('branches', 'timezone', "`timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Karachi'");

      // approval_requests
      await ensureCol('approval_requests', 'collected_by', '`collected_by` CHAR(36) NULL');
      await ensureCol('approval_requests', 'collected_at', '`collected_at` DATETIME NULL');
      await ensureCol('approval_requests', 'collection_method', '`collection_method` VARCHAR(30) NULL');
      await ensureCol('approval_requests', 'collection_notes', '`collection_notes` TEXT NULL');

      // payments
      await ensureCol('payments', 'business_date', '`business_date` DATE NULL');
      await ensureCol('payments', 'idempotency_key', '`idempotency_key` VARCHAR(120) NULL');
      await ensureCol('payments', 'printed_at', '`printed_at` DATETIME NULL');
      await ensureCol('payments', 'printed_by', '`printed_by` CHAR(36) NULL');

      // payments indexes
      await sequelize.query(
        'ALTER TABLE `payments` ADD INDEX payments_branch_business_date (`branch_id`, `business_date`, `status`)'
      ).catch(() => {});
      await sequelize.query(
        'ALTER TABLE `payments` ADD UNIQUE INDEX payments_idempotency_unique (`idempotency_key`)'
      ).catch(() => {});

      // gyms
      await ensureCol('gyms', 'gym_listing_id', '`gym_listing_id` CHAR(36) NULL');
    },
  },
  {
    version: 4,
    name: '004_backfill_payments_business_date',
    up: async (sequelize) => {
      // Historical backfill using each branch's own timezone via computeBusinessDate
      // and getPaymentCollectionTime (collected_at; otherwise created_at for cash; otherwise paid_at for online/bank)
      const { computeBusinessDate, getPaymentCollectionTime } = require('../services/ledger.service');
      const rows = await sequelize.query(`
        SELECT 
          p.id, 
          p.branch_id, 
          p.method,
          p.collected_at,
          p.paid_at,
          p.created_at,
          b.timezone
        FROM payments p
        LEFT JOIN branches b ON p.branch_id = b.id
        WHERE p.business_date IS NULL
      `, { type: QueryTypes.SELECT }).catch(() => []);

      for (const row of rows) {
        if (!row.id) continue;
        const collectionTime = getPaymentCollectionTime(row);
        const tz = row.timezone || 'Asia/Karachi';
        const bDate = computeBusinessDate(new Date(collectionTime), tz);
        await sequelize.query(
          'UPDATE payments SET business_date = ? WHERE id = ?',
          { replacements: [bDate, row.id] }
        ).catch(() => {});
      }
    },
  },
  {
    version: 5,
    name: '005_backfill_gym_listing_ids',
    up: async (sequelize, context) => {
      if (!context?.tenantId) return;
      try {
        const { GymListing } = require('../models/platform');
        const firstListing = await GymListing.findOne({
          where: { tenantId: context.tenantId, status: { [Sequelize.Op.ne]: 'INACTIVE' } },
        }).catch(() => null);

        if (firstListing && firstListing.id) {
          await sequelize.query(
            'UPDATE branches SET gym_listing_id = ? WHERE gym_listing_id IS NULL OR gym_listing_id = ?',
            { replacements: [firstListing.id, ''] }
          ).catch(() => {});
          await sequelize.query(
            'UPDATE gyms SET gym_listing_id = ? WHERE gym_listing_id IS NULL OR gym_listing_id = ?',
            { replacements: [firstListing.id, ''] }
          ).catch(() => {});
        }
      } catch (_) {
        // Safe skip if platform models not loaded or in standalone test
      }
    },
  },
  {
    version: 6,
    name: '006_enforce_payments_business_date_not_null',
    up: async (sequelize, context) => {
      const tenantId = context?.tenantId || 'unknown';
      // Count NULL business_date rows in payments
      const [result] = await sequelize.query(
        'SELECT COUNT(*) AS null_count FROM payments WHERE business_date IS NULL',
        { type: QueryTypes.SELECT }
      ).catch(() => [{ null_count: 0 }]);

      const nullCount = Number(result?.null_count || 0);
      if (nullCount > 0) {
        console.warn(
          `[TenantMigration] SKIPPING Migration 006 on tenant ${tenantId}: found ${nullCount} payments with NULL business_date. Table remains unchanged.`
        );
        return { skipped: true, reason: 'has_null_business_date_rows', nullCount };
      }

      // Zero NULL rows: safe to make payments.business_date NOT NULL
      await sequelize.query(
        'ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NOT NULL'
      );
    },
  },
];

const TARGET_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * Ensures the `schema_migrations` tracking table exists on a tenant database.
 */
async function ensureMigrationTable(sequelize) {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INT          NOT NULL,
      name        VARCHAR(191) NOT NULL,
      applied_at  DATETIME     NOT NULL,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

/**
 * Run pending migrations on a single tenant database.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {object} [context]
 * @param {string} [context.tenantId]
 * @param {string} [context.gymName]
 * @param {number} [context.targetVersion]
 * @returns {Promise<{ tenantId: string, initialVersion: number, finalVersion: number, applied: string[] }>}
 */
async function runTenantMigrations(sequelize, context = {}) {
  await ensureMigrationTable(sequelize);

  const appliedRows = await sequelize.query(
    'SELECT version FROM schema_migrations ORDER BY version ASC',
    { type: QueryTypes.SELECT }
  );
  const appliedSet = new Set(appliedRows.map((r) => r.version));
  const initialVersion = appliedRows.length > 0 ? Math.max(...appliedRows.map((r) => r.version)) : 0;

  const targetVersion = context.targetVersion || TARGET_SCHEMA_VERSION;
  const applied = [];

  for (const mig of MIGRATIONS) {
    if (mig.version > targetVersion) continue;
    if (appliedSet.has(mig.version)) continue;

    console.log(`[TenantMigration] Tenant ${context.tenantId || 'local'}: running ${mig.name} (v${mig.version})...`);
    const migResult = await mig.up(sequelize, context);

    if (migResult?.skipped) {
      console.warn(`[TenantMigration] Tenant ${context.tenantId || 'local'}: skipped ${mig.name} (v${mig.version}); not recording as applied.`);
      continue;
    }

    await sequelize.query(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())',
      { replacements: [mig.version, mig.name] }
    );
    applied.push(mig.name);
  }

  const finalRows = await sequelize.query(
    'SELECT version FROM schema_migrations ORDER BY version ASC',
    { type: QueryTypes.SELECT }
  );
  const finalVersion = finalRows.length > 0 ? Math.max(...finalRows.map((r) => r.version)) : 0;

  return {
    tenantId: context.tenantId || 'local',
    gymName: context.gymName || 'Local DB',
    initialVersion,
    finalVersion,
    applied,
  };
}

/**
 * Run migrations across all active tenant databases.
 *
 * Resumable: reports errors per tenant and continues across remaining tenants.
 *
 * @param {object} [options]
 * @param {number} [options.targetVersion]
 * @returns {Promise<{ totalTenants: number, successCount: number, failedCount: number, reports: Array }>}
 */
async function runAllTenantMigrations(options = {}) {
  const { Tenant } = require('../models/platform');
  const tenants = await Tenant.findAll({
    where: {
      status: 'ACTIVE',
      connectionStringEncrypted: { [Sequelize.Op.ne]: null },
    },
  });

  const activeTenants = tenants.filter(
    (t) => t.connectionStringEncrypted && t.connectionStringEncrypted !== 'PENDING_PROVISIONING'
  );

  console.log(`[TenantMigration] Found ${activeTenants.length} active tenant(s) to migrate.`);

  const reports = [];
  let successCount = 0;
  let failedCount = 0;

  for (const tenant of activeTenants) {
    let tenantSeq = null;
    try {
      const connUrl = decrypt(tenant.connectionStringEncrypted);
      tenantSeq = new Sequelize(connUrl, {
        dialect: 'mysql',
        logging: false,
        pool: { max: 2, min: 0, acquire: 20000, idle: 10000 },
        dialectOptions: { connectTimeout: 15000 },
      });

      await tenantSeq.authenticate();

      const result = await runTenantMigrations(tenantSeq, {
        tenantId: tenant.id,
        gymName: tenant.gymName,
        targetVersion: options.targetVersion,
      });

      reports.push({ ...result, success: true });
      successCount++;
    } catch (err) {
      console.error(`[TenantMigration] Failed migrating tenant ${tenant.tenantCode} (${tenant.id}):`, err.message);
      reports.push({
        tenantId: tenant.id,
        gymName: tenant.gymName,
        success: false,
        error: err.message,
      });
      failedCount++;
    } finally {
      if (tenantSeq) {
        await tenantSeq.close().catch(() => {});
      }
    }
  }

  return {
    totalTenants: activeTenants.length,
    successCount,
    failedCount,
    reports,
  };
}

/**
 * Read-only startup check: checks every active tenant database to verify
 * if its schemaVersion is behind TARGET_SCHEMA_VERSION.
 *
 * Logs a clear warning for any tenant that is behind.
 * Performs 0 writes and does NOT crash.
 *
 * @returns {Promise<{ checked: number, behind: Array<{ tenantId: string, gymName: string, currentVersion: number, targetVersion: number }> }>}
 */
async function checkTenantSchemaVersions() {
  const behind = [];
  try {
    const { Tenant } = require('../models/platform');
    const tenants = await Tenant.findAll({
      where: {
        status: 'ACTIVE',
        connectionStringEncrypted: { [Sequelize.Op.ne]: null },
      },
    }).catch(() => []);

    const activeTenants = tenants.filter(
      (t) => t.connectionStringEncrypted && t.connectionStringEncrypted !== 'PENDING_PROVISIONING'
    );

    for (const tenant of activeTenants) {
      let tenantSeq = null;
      try {
        const connUrl = decrypt(tenant.connectionStringEncrypted);
        tenantSeq = new Sequelize(connUrl, {
          dialect: 'mysql',
          logging: false,
          pool: { max: 1, min: 0, acquire: 10000, idle: 5000 },
          dialectOptions: { connectTimeout: 10000 },
        });

        await tenantSeq.authenticate();

        const tables = await tenantSeq.query(
          "SHOW TABLES LIKE 'schema_migrations'",
          { type: QueryTypes.SELECT }
        ).catch(() => []);

        let currentVersion = 0;
        if (tables.length > 0) {
          const rows = await tenantSeq.query(
            'SELECT MAX(version) AS max_version FROM schema_migrations',
            { type: QueryTypes.SELECT }
          ).catch(() => []);
          currentVersion = rows[0]?.max_version || 0;
        }

        if (currentVersion < TARGET_SCHEMA_VERSION) {
          console.warn(
            `[Deploy Warning] Tenant '${tenant.gymName || tenant.tenantCode}' (${tenant.id}) schema version (${currentVersion}) is behind target (${TARGET_SCHEMA_VERSION}). Run 'node src/scripts/run-tenant-migrations.js' to apply pending migrations.`
          );
          behind.push({
            tenantId: tenant.id,
            gymName: tenant.gymName,
            currentVersion,
            targetVersion: TARGET_SCHEMA_VERSION,
          });
        }
      } catch (err) {
        console.warn(
          `[Deploy Warning] Could not check schema version for tenant '${tenant.gymName || tenant.tenantCode}' (${tenant.id}): ${err.message}`
        );
      } finally {
        if (tenantSeq) {
          await tenantSeq.close().catch(() => {});
        }
      }
    }

    return { checked: activeTenants.length, behind };
  } catch (err) {
    console.warn(`[Deploy Warning] Failed to inspect tenant schema versions on startup: ${err.message}`);
    return { checked: 0, behind: [] };
  }
}

module.exports = {
  MIGRATIONS,
  TARGET_SCHEMA_VERSION,
  ensureMigrationTable,
  runTenantMigrations,
  runAllTenantMigrations,
  checkTenantSchemaVersions,
};
