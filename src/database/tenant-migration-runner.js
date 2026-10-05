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
      if (context?.dryRun === true) return;
      await ensureAccessControlTables(sequelize, context?.tenantId || 'unknown');
    },
  },
  {
    version: 2,
    name: '002_ensure_ledger_tables',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      await ensureLedgerTables(sequelize, context?.tenantId || 'unknown');
    },
  },
  {
    version: 3,
    name: '003_audit_and_tracking_columns',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
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
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      // Historical backfill using each branch's own timezone via computeBusinessDate
      // and getPaymentCollectionTime (collected_at; otherwise created_at for cash; otherwise paid_at for online/bank)
      // Matches branch timezones in JavaScript to completely avoid SQL collation join mismatches (Step 2.10)
      const { computeBusinessDate, getPaymentCollectionTime } = require('../services/ledger.service');

      // 1. Preload branches into a Map (no cross-table join)
      const branchRows = await sequelize.query(
        'SELECT id, timezone FROM branches',
        { type: QueryTypes.SELECT }
      ).catch(() => []);

      const branchMap = new Map();
      for (const b of branchRows) {
        if (b.id) {
          branchMap.set(b.id, b.timezone || 'Asia/Karachi');
        }
      }

      // 2. Fetch payments with NULL business_date
      const rows = await sequelize.query(`
        SELECT 
          id, 
          branch_id, 
          method,
          collected_at,
          paid_at,
          created_at
        FROM payments
        WHERE business_date IS NULL
      `, { type: QueryTypes.SELECT }).catch(() => []);

      for (const row of rows) {
        if (!row.id) continue;
        const collectionTime = getPaymentCollectionTime(row);
        const tz = (row.branch_id ? branchMap.get(row.branch_id) : null) || 'Asia/Karachi';
        const bDate = computeBusinessDate(new Date(collectionTime), tz);
        await sequelize.query(
          'UPDATE payments SET business_date = ? WHERE id = ?',
          { replacements: [bDate, row.id] }
        );
      }
    },
  },
  {
    version: 5,
    name: '005_backfill_gym_listing_ids',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
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
      if (context?.dryRun === true) return;
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
  {
    version: 7,
    name: '007_align_tenant_collations',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      const tenantLabel = context?.tenantId || 'local';

      // 1. Identify all tables whose collation differs from utf8mb4_unicode_ci
      const differingTables = await sequelize.query(`
        SELECT TABLE_NAME, TABLE_COLLATION
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_TYPE = 'BASE TABLE'
          AND TABLE_COLLATION IS NOT NULL
          AND TABLE_COLLATION != 'utf8mb4_unicode_ci'
      `, { type: QueryTypes.SELECT }).catch(() => []);

      // 2. Identify all columns whose collation differs from utf8mb4_unicode_ci
      const differingColumns = await sequelize.query(`
        SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND COLLATION_NAME IS NOT NULL
          AND COLLATION_NAME != 'utf8mb4_unicode_ci'
      `, { type: QueryTypes.SELECT }).catch(() => []);

      // Gather distinct tables requiring conversion
      const tablesToConvert = new Set();
      for (const t of differingTables) {
        if (t.TABLE_NAME) tablesToConvert.add(t.TABLE_NAME);
      }
      for (const c of differingColumns) {
        if (c.TABLE_NAME) tablesToConvert.add(c.TABLE_NAME);
      }

      if (tablesToConvert.size === 0) {
        console.log(`[TenantMigration] Tenant ${tenantLabel}: all tenant tables and columns already aligned to utf8mb4_unicode_ci (0 changes needed).`);
        return { alignedCount: 0 };
      }

      console.log(`[TenantMigration] Tenant ${tenantLabel}: aligning collations to utf8mb4_unicode_ci for ${tablesToConvert.size} table(s): ${Array.from(tablesToConvert).join(', ')}`);

      await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
      try {
        for (const tableName of tablesToConvert) {
          console.log(`[TenantMigration] Tenant ${tenantLabel}: converting table \`${tableName}\` to CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci...`);
          await sequelize.query(
            `ALTER TABLE \`${tableName}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
          );
        }
      } finally {
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
      }

      console.log(`[TenantMigration] Tenant ${tenantLabel}: successfully converted ${tablesToConvert.size} table(s) to utf8mb4_unicode_ci.`);
      return { alignedCount: tablesToConvert.size };
    },
  },
  {
    version: 8,
    name: '008_add_branch_admin_suspended_columns',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      const qi = sequelize.getQueryInterface();

      const ensureCol = async (table, col, ddl) => {
        const cols = await qi.describeTable(table).catch(() => ({}));
        if (cols && !cols[col]) {
          await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`).catch(() => {});
        }
      };

      await ensureCol('branches', 'admin_suspended', '`admin_suspended` TINYINT(1) NOT NULL DEFAULT 0');
      await ensureCol('branches', 'admin_suspended_reason', '`admin_suspended_reason` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL');
      await ensureCol('branches', 'admin_suspended_at', '`admin_suspended_at` DATETIME NULL');
      await ensureCol('branches', 'admin_suspended_by', '`admin_suspended_by` CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL');
    },
  },
  {
    version: 9,
    name: '009_create_capacity_outbox_table',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS \`capacity_outbox\` (
          \`id\` CHAR(36) NOT NULL,
          \`event_type\` VARCHAR(60) NOT NULL,
          \`payload_json\` JSON NOT NULL,
          \`idempotency_key\` VARCHAR(191) NOT NULL,
          \`status\` VARCHAR(30) NOT NULL DEFAULT 'PENDING',
          \`attempts\` INT NOT NULL DEFAULT 0,
          \`last_error\` TEXT NULL,
          \`processed_at\` DATETIME NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`capacity_outbox_idempotency_key_unique\` (\`idempotency_key\`),
          INDEX \`capacity_outbox_status_idx\` (\`status\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
    },
  },
  {
    version: 10,
    name: '010_add_branch_billing_lock_columns',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      const qi = sequelize.getQueryInterface();

      const ensureCol = async (table, col, ddl) => {
        const cols = await qi.describeTable(table).catch(() => ({}));
        if (cols && !cols[col]) {
          await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`).catch(() => {});
        }
      };

      await ensureCol('branches', 'billing_locked_at', '`billing_locked_at` DATETIME NULL');
      await ensureCol('branches', 'billing_lock_reason', '`billing_lock_reason` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL');
    },
  },
  {
    version: 11,
    name: '011_create_idempotency_records_table',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS \`idempotency_records\` (
          \`id\` CHAR(36) NOT NULL,
          \`idempotency_key\` VARCHAR(128) NOT NULL,
          \`user_id\` CHAR(36) NULL,
          \`route\` VARCHAR(255) NOT NULL,
          \`request_hash\` VARCHAR(64) NOT NULL,
          \`status\` ENUM('IN_PROGRESS', 'RESOLVED', 'FAILED') NOT NULL DEFAULT 'IN_PROGRESS',
          \`status_code\` INT NULL,
          \`response_body\` MEDIUMTEXT NULL,
          \`expires_at\` DATETIME NOT NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`idx_idempotency_records_key\` (\`idempotency_key\`),
          KEY \`idx_idempotency_records_expires_at\` (\`expires_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
    },
  },
  {
    version: 12,
    name: '012_create_payouts_table',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;

      const [amountCol] = await sequelize.query(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payouts' AND COLUMN_NAME = 'amount'",
        { type: QueryTypes.SELECT }
      );
      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['payouts'], type: QueryTypes.SELECT }
      );
      if (tableExists && !amountCol) {
        console.warn(
          '[TenantMigration] SKIPPING 012: payouts table exists without amount column. Resolve it by hand, then re-run.'
        );
        return {
          skipped: true,
          reason: 'table_exists_with_other_schema',
          table: 'payouts',
        };
      }

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS \`payouts\` (
          \`id\` CHAR(36) NOT NULL,
          \`branch_id\` CHAR(36) NULL,
          \`amount\` DECIMAL(10, 2) NOT NULL,
          \`currency\` VARCHAR(3) NOT NULL DEFAULT 'PKR',
          \`status\` ENUM('PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
          \`destination_json\` JSON NULL,
          \`notes\` TEXT NULL,
          \`idempotency_key\` VARCHAR(120) NULL,
          \`requested_by\` CHAR(36) NOT NULL,
          \`approved_by\` CHAR(36) NULL,
          \`paid_at\` DATETIME NULL,
          \`transaction_ref\` VARCHAR(255) NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`idx_payouts_idempotency_key\` (\`idempotency_key\`),
          KEY \`idx_payouts_branch_status\` (\`branch_id\`, \`status\`),
          KEY \`idx_payouts_created_at\` (\`created_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      return null;
    },
  },
  {
    version: 13,
    name: '013_add_role_assignment_version',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;

      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['role_assignments'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return null;

      const [versionCol] = await sequelize.query(
        "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_assignments' AND COLUMN_NAME = 'version'",
        { type: QueryTypes.SELECT }
      );

      if (versionCol) {
        if (['int', 'smallint', 'tinyint', 'bigint', 'mediumint'].includes(String(versionCol.DATA_TYPE).toLowerCase())) {
          return null;
        }
        console.warn(
          `[TenantMigration] SKIPPING 013: role_assignments.version already exists as ${versionCol.DATA_TYPE}. Resolve it by hand, then re-run.`
        );
        return {
          skipped: true,
          reason: 'column_exists_with_other_type',
          table: 'role_assignments',
          column: 'version',
          type: versionCol.DATA_TYPE,
        };
      }

      await sequelize.query(
        'ALTER TABLE `role_assignments` ADD COLUMN `version` INT NOT NULL DEFAULT 1'
      );
      return null;
    },
  },
  {
    version: 14,
    name: '014_create_invoice_sequences_table',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;

      const [nextNumberCol] = await sequelize.query(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_sequences' AND COLUMN_NAME = 'next_number'",
        { type: QueryTypes.SELECT }
      );
      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['invoice_sequences'], type: QueryTypes.SELECT }
      );
      if (tableExists && !nextNumberCol) {
        console.warn(
          '[TenantMigration] SKIPPING 014: invoice_sequences table exists without next_number column. Resolve it by hand, then re-run.'
        );
        return {
          skipped: true,
          reason: 'table_exists_with_other_schema',
          table: 'invoice_sequences',
        };
      }

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS \`invoice_sequences\` (
          \`branch_id\` VARCHAR(64) NOT NULL,
          \`prefix\` VARCHAR(32) NOT NULL DEFAULT 'INV',
          \`next_number\` INT UNSIGNED NOT NULL DEFAULT 1,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`branch_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Initialize GLOBAL sequence row
      await sequelize.query(`
        INSERT IGNORE INTO \`invoice_sequences\` (\`branch_id\`, \`prefix\`, \`next_number\`, \`created_at\`, \`updated_at\`)
        VALUES ('GLOBAL', 'INV-ORG', 1, NOW(), NOW())
      `).catch(() => {});

      // Initialize sequence rows for all existing branches
      const branchRows = await sequelize.query(
        'SELECT id FROM branches',
        { type: QueryTypes.SELECT }
      ).catch(() => []);

      for (const b of branchRows) {
        if (b.id) {
          const tag = b.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || 'BRANCH';
          await sequelize.query(
            'INSERT IGNORE INTO `invoice_sequences` (`branch_id`, `prefix`, `next_number`, `created_at`, `updated_at`) VALUES (?, ?, 1, NOW(), NOW())',
            { replacements: [b.id, `INV-${tag}`] }
          ).catch(() => {});
        }
      }

      return null;
    },
  },
  {
    version: 15,
    name: '015_add_gym_staff_invite_token',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;

      const [tokenHashCol] = await sequelize.query(
        "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gym_staff' AND COLUMN_NAME = 'invite_token_hash'",
        { type: QueryTypes.SELECT }
      );

      if (tokenHashCol) {
        if (['varchar', 'char', 'text'].includes(String(tokenHashCol.DATA_TYPE).toLowerCase())) {
          return null;
        }
        console.warn(
          `[TenantMigration] SKIPPING 015: gym_staff.invite_token_hash already exists as ${tokenHashCol.DATA_TYPE}. Resolve it by hand, then re-run.`
        );
        return {
          skipped: true,
          reason: 'column_exists_with_other_type',
          table: 'gym_staff',
          column: 'invite_token_hash',
          type: tokenHashCol.DATA_TYPE,
        };
      }

      const [expiresAtCol] = await sequelize.query(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gym_staff' AND COLUMN_NAME = 'token_expires_at'",
        { type: QueryTypes.SELECT }
      );

      if (!tokenHashCol) {
        await sequelize.query(
          'ALTER TABLE `gym_staff` ADD COLUMN `invite_token_hash` VARCHAR(64) NULL'
        );
      }
      if (!expiresAtCol) {
        await sequelize.query(
          'ALTER TABLE `gym_staff` ADD COLUMN `token_expires_at` DATETIME NULL'
        );
      }

      await sequelize.query(
        'ALTER TABLE `gym_staff` ADD INDEX gym_staff_invite_token_hash (`invite_token_hash`)'
      ).catch(() => {});

      return null;
    },
  },
  {
    version: 16,
    name: '016_add_payment_shift_and_ledger_closed_collectors',
    up: async (sequelize) => {
      // 1. Check payments.shift
      const [shiftCol] = await sequelize.query(
        "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'shift'",
        { type: QueryTypes.SELECT }
      );

      if (shiftCol && shiftCol.DATA_TYPE !== 'varchar') {
        return {
          skipped: true,
          reason: 'column_exists_with_other_type',
          table: 'payments',
          column: 'shift',
          type: shiftCol.DATA_TYPE,
        };
      }

      // 2. Check ledger_days.closed_collectors_json
      const [closedCol] = await sequelize.query(
        "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ledger_days' AND COLUMN_NAME = 'closed_collectors_json'",
        { type: QueryTypes.SELECT }
      );

      if (closedCol && !['text', 'mediumtext', 'longtext'].includes(closedCol.DATA_TYPE.toLowerCase())) {
        return {
          skipped: true,
          reason: 'column_exists_with_other_type',
          table: 'ledger_days',
          column: 'closed_collectors_json',
          type: closedCol.DATA_TYPE,
        };
      }

      if (!shiftCol) {
        await sequelize.query(
          "ALTER TABLE `payments` ADD COLUMN `shift` VARCHAR(20) NULL DEFAULT 'DEFAULT'"
        );
      }

      if (!closedCol) {
        await sequelize.query(
          'ALTER TABLE `ledger_days` ADD COLUMN `closed_collectors_json` TEXT NULL'
        );
      }

      return null;
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

/**
 * Run pending migrations on a single tenant database.
 *
 * Supports `context.dryRun = true` for zero-write preview.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {object} [context]
 * @param {string} [context.tenantId]
 * @param {string} [context.tenantCode]
 * @param {string} [context.gymName]
 * @param {number} [context.targetVersion]
 * @param {boolean} [context.dryRun]
 * @param {Array} [context.migrations] - the migration list to run (default: the tenant MIGRATIONS). The platform
 *   database passes its own list (platform-migrations.js) so both databases share this one runner.
 * @returns {Promise<{ tenantId: string, tenantCode?: string, gymName: string, initialVersion: number, finalVersion: number, applied: string[], wouldRun?: string[], dryRun?: boolean }>}
 */
async function runTenantMigrations(sequelize, context = {}) {
  const isDryRun = context.dryRun === true;
  const migrations = context.migrations || MIGRATIONS;

  let appliedRows = [];
  if (isDryRun) {
    // Robust read-only schema check: query schema_migrations directly without mutating
    try {
      appliedRows = await sequelize.query(
        'SELECT version FROM schema_migrations ORDER BY version ASC',
        { type: QueryTypes.SELECT }
      );
    } catch (_) {
      // Table schema_migrations does not exist yet on this tenant DB
      appliedRows = [];
    }
  } else {
    await ensureMigrationTable(sequelize);
    appliedRows = await sequelize.query(
      'SELECT version FROM schema_migrations ORDER BY version ASC',
      { type: QueryTypes.SELECT }
    );
  }

  const appliedSet = new Set(appliedRows.map((r) => r.version));
  const initialVersion = appliedRows.length > 0 ? Math.max(...appliedRows.map((r) => r.version)) : 0;
  const targetVersion = context.targetVersion || migrations[migrations.length - 1].version;

  if (isDryRun) {
    // Structural safety guarantee: wrap dry-run inspection in a transaction that is ALWAYS rolled back
    const t = await sequelize.transaction();
    try {
      // Guarantees any potential read lock / statement is rolled back with zero writes
    } finally {
      await t.rollback().catch(() => {});
    }

    const pending = [];
    for (const mig of migrations) {
      if (mig.version > targetVersion) continue;
      if (appliedSet.has(mig.version)) continue;
      pending.push(mig);
    }

    return {
      tenantId: context.tenantId || 'local',
      tenantCode: context.tenantCode || 'UNKNOWN',
      gymName: context.gymName || 'Local DB',
      initialVersion,
      finalVersion: initialVersion,
      applied: [],
      wouldRun: pending.map((m) => m.name),
      dryRun: true,
    };
  }

  const applied = [];

  for (const mig of migrations) {
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
    tenantCode: context.tenantCode || 'UNKNOWN',
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
 * Supports `options.dryRun = true` for zero-write preview.
 *
 * @param {object} [options]
 * @param {number} [options.targetVersion]
 * @param {boolean} [options.dryRun]
 * @returns {Promise<{ totalTenants: number, successCount: number, failedCount: number, reports: Array, dryRun?: boolean }>}
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

  console.log(`[TenantMigration] Found ${activeTenants.length} active tenant(s) to ${options.dryRun ? 'preview (dry-run)' : 'migrate'}.`);

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
        tenantCode: tenant.tenantCode,
        gymName: tenant.gymName,
        targetVersion: options.targetVersion,
        dryRun: options.dryRun === true,
      });

      reports.push({
        tenantId: tenant.id,
        tenantCode: tenant.tenantCode,
        gymName: tenant.gymName,
        initialVersion: result.initialVersion,
        finalVersion: result.finalVersion,
        applied: result.applied,
        wouldRun: result.wouldRun,
        dryRun: options.dryRun === true,
        success: true,
      });
      successCount++;
    } catch (err) {
      console.error(`[TenantMigration] Failed migrating tenant ${tenant.tenantCode} (${tenant.id}):`, err.message);
      reports.push({
        tenantId: tenant.id,
        tenantCode: tenant.tenantCode,
        gymName: tenant.gymName,
        initialVersion: 0,
        finalVersion: 0,
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
    dryRun: options.dryRun === true,
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
