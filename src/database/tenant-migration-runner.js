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
      await ensureCol('branches', 'timezone', '`timezone` VARCHAR(64) NOT NULL DEFAULT \'Asia/Karachi\'');

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
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'payouts\' AND COLUMN_NAME = \'amount\'',
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
        'SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'role_assignments\' AND COLUMN_NAME = \'version\'',
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
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'invoice_sequences\' AND COLUMN_NAME = \'next_number\'',
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

      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'gym_staff\'',
        { type: QueryTypes.SELECT }
      );
      if (!tableExists) return null;

      const [tokenHashCol] = await sequelize.query(
        'SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'gym_staff\' AND COLUMN_NAME = \'invite_token_hash\'',
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
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'gym_staff\' AND COLUMN_NAME = \'token_expires_at\'',
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
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;

      const [paymentsExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'payments\'',
        { type: QueryTypes.SELECT }
      );

      if (paymentsExists) {
        // 1. Check payments.shift
        const [shiftCol] = await sequelize.query(
          'SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'payments\' AND COLUMN_NAME = \'shift\'',
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

        if (!shiftCol) {
          await sequelize.query(
            'ALTER TABLE `payments` ADD COLUMN `shift` VARCHAR(20) NULL DEFAULT \'DEFAULT\''
          );
        }
      }

      const [ledgerExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'ledger_days\'',
        { type: QueryTypes.SELECT }
      );

      if (ledgerExists) {
        // 2. Check ledger_days.closed_collectors_json
        const [closedCol] = await sequelize.query(
          'SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'ledger_days\' AND COLUMN_NAME = \'closed_collectors_json\'',
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

        if (!closedCol) {
          await sequelize.query(
            'ALTER TABLE `ledger_days` ADD COLUMN `closed_collectors_json` TEXT NULL'
          );
        }
      }

      return null;
    },
  },
  {
    // FLOW-08: an upgrade waits for its payment. The payment row records the
    // change it unlocks; verifyPayment applies it. Additive, nullable.
    version: 17,
    name: '017_add_payment_pending_change',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;

      const [paymentsExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'payments\'',
        { type: QueryTypes.SELECT }
      );
      if (!paymentsExists) return null;

      const [col] = await sequelize.query(
        'SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'payments\' AND COLUMN_NAME = \'pending_change_json\'',
        { type: QueryTypes.SELECT }
      );
      if (col) {
        if (['text', 'mediumtext', 'longtext'].includes(String(col.DATA_TYPE).toLowerCase())) return null;
        console.warn(
          `[TenantMigration] SKIPPING 017: payments.pending_change_json already exists as ${col.DATA_TYPE}. Resolve it by hand, then re-run.`
        );
        return {
          skipped: true,
          reason: 'column_exists_with_other_type',
          table: 'payments',
          column: 'pending_change_json',
          type: col.DATA_TYPE,
        };
      }

      await sequelize.query('ALTER TABLE `payments` ADD COLUMN `pending_change_json` TEXT NULL');
      return null;
    },
  },
  {
    // PAY-08: member pending payments get a deadline and can end EXPIRED.
    // Appending a value to the ENUM is metadata-only on MySQL 5.7.
    version: 18,
    name: '018_add_payment_expiry',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;

      const [paymentsExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'payments\'',
        { type: QueryTypes.SELECT }
      );
      if (!paymentsExists) return null;

      // payments.status exists in two shapes in the wild: the model's ENUM
      // (values in any order) and VARCHAR on older tenants (see the
      // mixed-collation fixture). VARCHAR already holds 'EXPIRED'; an ENUM gets
      // it appended, keeping its order, nullability and default.
      const KNOWN_STATUSES = ['PENDING', 'STAFF_COLLECTED', 'COMPLETED', 'FAILED', 'REFUNDED'];
      const [statusCol] = await sequelize.query(
        'SELECT DATA_TYPE, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'payments\' AND COLUMN_NAME = \'status\'',
        { type: QueryTypes.SELECT }
      );
      const dataType = String(statusCol?.DATA_TYPE || '').toLowerCase();
      let statusAlter = null;
      if (dataType === 'enum') {
        const values = [...String(statusCol.COLUMN_TYPE).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]);
        const missing = KNOWN_STATUSES.filter((v) => !values.includes(v));
        if (missing.length > 0) {
          console.warn(
            `[TenantMigration] SKIPPING 018: payments.status is ${statusCol.COLUMN_TYPE}; it lacks ${missing.join(', ')}. Resolve it by hand, then re-run.`
          );
          return { skipped: true, reason: 'unexpected_column_type', table: 'payments', column: 'status', type: statusCol.COLUMN_TYPE };
        }
        if (!values.includes('EXPIRED')) {
          const list = [...values, 'EXPIRED'].map((v) => `'${v}'`).join(',');
          const nullSql = statusCol.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL';
          const defaultSql = statusCol.COLUMN_DEFAULT != null ? ` DEFAULT '${String(statusCol.COLUMN_DEFAULT).replace(/'/g, '\'\'')}'` : '';
          statusAlter = `ALTER TABLE \`payments\` MODIFY COLUMN \`status\` ENUM(${list}) ${nullSql}${defaultSql}`;
        }
      } else if (!(['varchar', 'char'].includes(dataType) && Number(statusCol.CHARACTER_MAXIMUM_LENGTH) >= 'EXPIRED'.length)) {
        console.warn(
          `[TenantMigration] SKIPPING 018: payments.status is ${statusCol?.COLUMN_TYPE}; expected an ENUM or VARCHAR. Resolve it by hand, then re-run.`
        );
        return { skipped: true, reason: 'unexpected_column_type', table: 'payments', column: 'status', type: statusCol?.COLUMN_TYPE };
      }

      const [expiresCol] = await sequelize.query(
        'SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'payments\' AND COLUMN_NAME = \'expires_at\'',
        { type: QueryTypes.SELECT }
      );
      if (expiresCol && !['datetime', 'timestamp'].includes(String(expiresCol.DATA_TYPE).toLowerCase())) {
        console.warn(
          `[TenantMigration] SKIPPING 018: payments.expires_at already exists as ${expiresCol.DATA_TYPE}. Resolve it by hand, then re-run.`
        );
        return { skipped: true, reason: 'column_exists_with_other_type', table: 'payments', column: 'expires_at', type: expiresCol.DATA_TYPE };
      }

      if (statusAlter) await sequelize.query(statusAlter);
      if (!expiresCol) {
        await sequelize.query('ALTER TABLE `payments` ADD COLUMN `expires_at` DATETIME NULL');
        await sequelize.query('ALTER TABLE `payments` ADD INDEX payments_status_expires_at (`status`, `expires_at`)').catch(() => {});
      }
      return null;
    },
  },
  {
    // GLB-02: currency per branch. Every existing branch keeps PKR (what every payment already says).
    version: 19,
    name: '019_add_branch_currency',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;

      const [branchesExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'branches\'',
        { type: QueryTypes.SELECT }
      );
      if (!branchesExists) return null;

      const [col] = await sequelize.query(
        'SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'branches\' AND COLUMN_NAME = \'currency\'',
        { type: QueryTypes.SELECT }
      );
      if (col) {
        const ok = ['varchar', 'char'].includes(String(col.DATA_TYPE).toLowerCase()) && Number(col.CHARACTER_MAXIMUM_LENGTH) >= 3;
        if (ok) return null;
        console.warn(
          `[TenantMigration] SKIPPING 019: branches.currency already exists as ${col.DATA_TYPE}. Resolve it by hand, then re-run.`
        );
        return { skipped: true, reason: 'column_exists_with_other_type', table: 'branches', column: 'currency', type: col.DATA_TYPE };
      }

      await sequelize.query('ALTER TABLE `branches` ADD COLUMN `currency` VARCHAR(3) NOT NULL DEFAULT \'PKR\'');
      return null;
    },
  },
  {
    // Phase 7 P3: the Google place id of a branch's address. Nullable, no backfill: existing branches keep
    // their address and coordinates and get a place id the next time the host picks the address from Google.
    // ROLLBACK (previous app build first): ALTER TABLE `branches` DROP COLUMN `google_place_id`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 20;
    version: 20,
    name: '020_add_branch_google_place_id',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;

      const [branchesExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'branches\'',
        { type: QueryTypes.SELECT }
      );
      if (!branchesExists) return null;

      const [col] = await sequelize.query(
        'SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'branches\' AND COLUMN_NAME = \'google_place_id\'',
        { type: QueryTypes.SELECT }
      );
      if (col) {
        const ok = String(col.DATA_TYPE).toLowerCase() === 'varchar' && Number(col.CHARACTER_MAXIMUM_LENGTH) >= 255;
        if (ok) return null;
        console.warn(
          `[TenantMigration] SKIPPING 020: branches.google_place_id already exists as ${col.DATA_TYPE}. Resolve it by hand, then re-run.`
        );
        return { skipped: true, reason: 'column_exists_with_other_type', table: 'branches', column: 'google_place_id', type: col.DATA_TYPE };
      }

      await sequelize.query('ALTER TABLE `branches` ADD COLUMN `google_place_id` VARCHAR(255) NULL');
      return null;
    },
  },
  {
    // P5b item 2 (R-81): a host can pause a branch (hidden from travellers, nothing else changes).
    // Both nullable, no backfill: no branch is paused. Not a status: the branch stays ACTIVE.
    // ROLLBACK (previous build first): ALTER TABLE `branches` DROP COLUMN `paused_at`, DROP COLUMN `paused_by`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 21;
    version: 21,
    name: '021_add_branch_pause_columns',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;

      const [branchesExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'branches\'',
        { type: QueryTypes.SELECT }
      );
      if (!branchesExists) return null;

      const wanted = { paused_at: ['datetime'], paused_by: ['char', 'varchar'] };
      const existing = await sequelize.query(
        'SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'branches\' AND COLUMN_NAME IN (\'paused_at\', \'paused_by\')',
        { type: QueryTypes.SELECT }
      );
      for (const col of existing) {
        if (!wanted[col.name].includes(String(col.type).toLowerCase())) {
          console.warn(`[TenantMigration] SKIPPING 021: branches.${col.name} already exists as ${col.type}. Resolve it by hand, then re-run.`);
          return { skipped: true, reason: 'column_exists_with_other_type', table: 'branches', column: col.name, type: col.type };
        }
      }
      const have = new Set(existing.map((c) => c.name));
      if (!have.has('paused_at')) await sequelize.query('ALTER TABLE `branches` ADD COLUMN `paused_at` DATETIME NULL');
      if (!have.has('paused_by')) await sequelize.query('ALTER TABLE `branches` ADD COLUMN `paused_by` CHAR(36) NULL');
      return null;
    },
  },
  {
    // ZKTeco Push devices, Phase 1 (docs/ZKTECO_PUSH_DEVICE_SYNC.md §6.2). New tables only.
    // access_device_details: the tenant's copy of a device (id = platform access_devices.id): name,
    //   direction, what the device reports. Not called `devices`, so it never reads like the
    //   platform table of the old /iclock router.
    // device_commands: the queue; id is the protocol CmdID, claimed by claim_token (§8.1).
    //   AUTO_INCREMENT starts at a random offset ≥ 1,000,000 so a device moved between tenants never
    //   sees a CmdID twice (the device answers -7 "repeated command" to an id it already ran).
    // ROLLBACK (previous build first): DROP TABLE `device_commands`; DROP TABLE `access_device_details`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 22;
    version: 22,
    name: '022_access_device_tables',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`access_device_details\` (
          \`id\` CHAR(36) NOT NULL,
          \`branch_id\` CHAR(36) NOT NULL,
          \`name\` VARCHAR(100) NOT NULL,
          \`direction\` VARCHAR(8) NOT NULL DEFAULT 'in',
          \`enabled\` TINYINT(1) NOT NULL DEFAULT 1,
          \`model\` VARCHAR(100) NULL,
          \`firmware\` VARCHAR(100) NULL,
          \`push_version\` VARCHAR(16) NULL,
          \`mac\` VARCHAR(32) NULL,
          \`comm_type\` VARCHAR(32) NULL,
          \`device_type\` VARCHAR(8) NULL,
          \`capabilities_json\` TEXT NULL,
          \`counts_json\` TEXT NULL,
          \`state_json\` TEXT NULL,
          \`door_mask\` TINYINT UNSIGNED NOT NULL DEFAULT 1,
          \`timezone_id\` INT NOT NULL DEFAULT 1,
          \`last_full_audit_at\` DATETIME NULL,
          \`last_error_code\` INT NULL,
          \`last_error_at\` DATETIME NULL,
          \`removed_at\` DATETIME NULL,
          \`created_by\` CHAR(36) NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          KEY \`access_device_details_branch_id\` (\`branch_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
      );
      const start = require('crypto').randomInt(1000000, 50000000);
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`device_commands\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`device_id\` CHAR(36) NOT NULL,
          \`member_id\` CHAR(36) NULL,
          \`push_request_id\` CHAR(26) NULL,
          \`kind\` VARCHAR(24) NOT NULL,
          \`args_json\` TEXT NULL,
          \`priority\` TINYINT UNSIGNED NOT NULL DEFAULT 5,
          \`status\` VARCHAR(12) NOT NULL DEFAULT 'queued',
          \`claim_token\` CHAR(26) NULL,
          \`attempts\` INT UNSIGNED NOT NULL DEFAULT 0,
          \`sent_at\` DATETIME NULL,
          \`acked_at\` DATETIME NULL,
          \`return_code\` INT NULL,
          \`not_before\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`expires_at\` DATETIME NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          KEY \`device_commands_poll\` (\`device_id\`, \`status\`, \`priority\`, \`id\`),
          KEY \`device_commands_claim_token\` (\`claim_token\`)
        ) ENGINE=InnoDB AUTO_INCREMENT=${start} DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
      );
      return null;
    },
  },
  {
    // ZKTeco Push devices, Phase 2: the sync engine (docs/ZKTECO_PUSH_DEVICE_SYNC.md §6.2, §6.3, §7, §8).
    // New tables, plus three additive changes to tables of their own feature:
    //   device_commands.batch_id (+ index), access_device_details.last_sweep_at / offline_since /
    //   offline_notified_at, gym_staff.device_access (D-8; default 0 = nobody changes).
    // Templates are AES-256-GCM (BIOMETRIC_DATA_KEY, utils/biometric-crypto.js), never plain.
    // ROLLBACK (previous build first): DROP TABLE `device_audit_pins`, `device_audits`,
    //   `device_unlinked_users`, `device_error_logs`, `device_state`, `device_access_events`,
    //   `device_member_sync`, `member_biometric_consents`, `member_biometric_photos`,
    //   `member_biometrics`, `member_device_identity`, `device_pin_sequence`;
    //   ALTER TABLE `device_commands` DROP INDEX `device_commands_member`, DROP COLUMN `batch_id`;
    //   ALTER TABLE `access_device_details` DROP COLUMN `last_sweep_at`, DROP COLUMN `offline_since`,
    //     DROP COLUMN `offline_notified_at`;
    //   ALTER TABLE `gym_staff` DROP COLUMN `device_access`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 23;
    // Dropping member_biometrics deletes every stored template: export nothing, there is no copy.
    version: 23,
    name: '023_device_sync_tables',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;
      const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
      const create = (sql) => sequelize.query(sql);
      const hasColumn = async (table, column) =>
        (await sequelize.query(
          'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
          { replacements: [table, column], type: QueryTypes.SELECT }
        )).length > 0;
      const hasIndex = async (table, index) =>
        (await sequelize.query(
          'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
          { replacements: [table, index], type: QueryTypes.SELECT }
        )).length > 0;

      // §6.3: one row; PINs from 1001, never reused (a retired PIN stays reserved).
      await create(`CREATE TABLE IF NOT EXISTS \`device_pin_sequence\` (
        \`id\` TINYINT UNSIGNED NOT NULL,
        \`next_pin\` INT UNSIGNED NOT NULL,
        PRIMARY KEY (\`id\`)
      ) ${T}`);
      await sequelize.query('INSERT IGNORE INTO `device_pin_sequence` (`id`, `next_pin`) VALUES (1, 1001)');

      await create(`CREATE TABLE IF NOT EXISTS \`member_device_identity\` (
        \`member_id\` CHAR(36) NOT NULL,
        \`pin\` INT UNSIGNED NOT NULL,
        \`card_no\` VARCHAR(32) NULL,
        \`retired_at\` DATETIME NULL,
        \`created_at\` DATETIME NOT NULL,
        \`updated_at\` DATETIME NOT NULL,
        PRIMARY KEY (\`member_id\`),
        UNIQUE KEY \`member_device_identity_pin\` (\`pin\`),
        KEY \`member_device_identity_retired_at\` (\`retired_at\`)
      ) ${T}`);

      await create(`CREATE TABLE IF NOT EXISTS \`member_biometrics\` (
        \`id\` CHAR(36) NOT NULL,
        \`member_id\` CHAR(36) NOT NULL,
        \`bio_type\` TINYINT UNSIGNED NOT NULL,
        \`bio_no\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
        \`bio_index\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
        \`major_ver\` VARCHAR(8) NOT NULL,
        \`minor_ver\` VARCHAR(8) NOT NULL DEFAULT '0',
        \`format\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
        \`duress\` TINYINT(1) NOT NULL DEFAULT 0,
        \`valid\` TINYINT(1) NOT NULL DEFAULT 1,
        \`template_enc\` MEDIUMBLOB NOT NULL,
        \`key_version\` SMALLINT UNSIGNED NOT NULL,
        \`template_sha256\` CHAR(64) NOT NULL,
        \`template_size\` INT UNSIGNED NOT NULL,
        \`source_device_id\` CHAR(36) NULL,
        \`consent_pending\` TINYINT(1) NOT NULL DEFAULT 0,
        \`pending_until\` DATETIME NULL,
        \`enrolled_at\` DATETIME NOT NULL,
        \`created_at\` DATETIME NOT NULL,
        \`updated_at\` DATETIME NOT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`member_biometrics_slot\` (\`member_id\`, \`bio_type\`, \`bio_no\`, \`bio_index\`),
        KEY \`member_biometrics_pending\` (\`consent_pending\`, \`pending_until\`),
        KEY \`member_biometrics_key_version\` (\`key_version\`)
      ) ${T}`);

      await create(`CREATE TABLE IF NOT EXISTS \`member_biometric_photos\` (
        \`id\` CHAR(36) NOT NULL,
        \`member_id\` CHAR(36) NOT NULL,
        \`kind\` VARCHAR(10) NOT NULL,
        \`bio_type\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
        \`storage_key\` VARCHAR(255) NOT NULL,
        \`key_version\` SMALLINT UNSIGNED NOT NULL,
        \`sha256\` CHAR(64) NOT NULL,
        \`size\` INT UNSIGNED NOT NULL,
        \`source_device_id\` CHAR(36) NULL,
        \`consent_pending\` TINYINT(1) NOT NULL DEFAULT 0,
        \`pending_until\` DATETIME NULL,
        \`created_at\` DATETIME NOT NULL,
        \`updated_at\` DATETIME NOT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`member_biometric_photos_slot\` (\`member_id\`, \`kind\`, \`bio_type\`),
        KEY \`member_biometric_photos_pending\` (\`consent_pending\`, \`pending_until\`)
      ) ${T}`);

      await create(`CREATE TABLE IF NOT EXISTS \`member_biometric_consents\` (
        \`id\` CHAR(36) NOT NULL,
        \`member_id\` CHAR(36) NOT NULL,
        \`consented_at\` DATETIME NOT NULL,
        \`consented_by_user_id\` CHAR(36) NULL,
        \`method\` VARCHAR(16) NOT NULL,
        \`revoked_at\` DATETIME NULL,
        \`revoked_by_user_id\` CHAR(36) NULL,
        \`created_at\` DATETIME NOT NULL,
        \`updated_at\` DATETIME NOT NULL,
        PRIMARY KEY (\`id\`),
        KEY \`member_biometric_consents_member\` (\`member_id\`, \`revoked_at\`)
      ) ${T}`);

      await create(`CREATE TABLE IF NOT EXISTS \`device_member_sync\` (
        \`device_id\` CHAR(36) NOT NULL,
        \`member_id\` CHAR(36) NOT NULL,
        \`pin\` INT UNSIGNED NOT NULL,
        \`desired\` TINYINT(1) NOT NULL DEFAULT 0,
        \`desired_hash\` CHAR(64) NULL,
        \`desired_json\` TEXT NULL,
        \`applied_hash\` CHAR(64) NULL,
        \`applied_json\` TEXT NULL,
        \`pending_batch_id\` CHAR(26) NULL,
        \`pending_hash\` CHAR(64) NULL,
        \`state\` VARCHAR(16) NOT NULL DEFAULT 'removed',
        \`attempts\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`last_return_code\` INT NULL,
        \`last_error_at\` DATETIME NULL,
        \`undesired_since\` DATETIME NULL,
        \`incompatible_json\` TEXT NULL,
        \`retry_day\` DATE NULL,
        \`retry_count\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
        \`created_at\` DATETIME NOT NULL,
        \`updated_at\` DATETIME NOT NULL,
        PRIMARY KEY (\`device_id\`, \`member_id\`),
        KEY \`device_member_sync_member\` (\`member_id\`),
        KEY \`device_member_sync_state\` (\`device_id\`, \`state\`),
        KEY \`device_member_sync_pin\` (\`device_id\`, \`pin\`)
      ) ${T}`);

      if (!(await hasColumn('device_commands', 'batch_id'))) {
        await sequelize.query('ALTER TABLE `device_commands` ADD COLUMN `batch_id` CHAR(26) NULL AFTER `push_request_id`');
      }
      if (!(await hasIndex('device_commands', 'device_commands_member'))) {
        await sequelize.query('ALTER TABLE `device_commands` ADD INDEX `device_commands_member` (`device_id`, `member_id`, `status`)');
      }
      if (!(await hasIndex('device_commands', 'device_commands_batch'))) {
        await sequelize.query('ALTER TABLE `device_commands` ADD INDEX `device_commands_batch` (`batch_id`)');
      }
      for (const [col, ddl] of [
        ['last_sweep_at', '`last_sweep_at` DATETIME NULL'],
        ['offline_since', '`offline_since` DATETIME NULL'],
        ['offline_notified_at', '`offline_notified_at` DATETIME NULL'],
      ]) {
        if (!(await hasColumn('access_device_details', col))) await sequelize.query(`ALTER TABLE \`access_device_details\` ADD COLUMN ${ddl}`);
      }

      // Every scan, granted or denied (§6.2). device_record_index: the device's `index`; a line without
      // one (ATTLOG) gets minus its PIN, so the same person in the same second is still one row.
      await create(`CREATE TABLE IF NOT EXISTS \`device_access_events\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`device_id\` CHAR(36) NOT NULL,
        \`branch_id\` CHAR(36) NOT NULL,
        \`device_record_index\` BIGINT NOT NULL,
        \`device_time\` DATETIME NOT NULL,
        \`utc_time\` DATETIME NOT NULL,
        \`pin\` VARCHAR(16) NULL,
        \`member_id\` CHAR(36) NULL,
        \`card_no\` VARCHAR(32) NULL,
        \`event_code\` INT NOT NULL,
        \`verify_type\` INT NULL,
        \`inout_status\` INT NULL,
        \`result\` VARCHAR(8) NOT NULL,
        \`reason\` VARCHAR(24) NULL,
        \`attendance_id\` CHAR(36) NULL,
        \`attendance_note\` VARCHAR(40) NULL,
        \`created_at\` DATETIME NOT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`device_access_events_record\` (\`device_id\`, \`device_record_index\`, \`device_time\`),
        KEY \`device_access_events_device_time\` (\`device_id\`, \`utc_time\`),
        KEY \`device_access_events_branch_time\` (\`branch_id\`, \`utc_time\`),
        KEY \`device_access_events_member_time\` (\`member_id\`, \`utc_time\`)
      ) ${T}`);

      await create(`CREATE TABLE IF NOT EXISTS \`device_state\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`device_id\` CHAR(36) NOT NULL,
        \`state_json\` TEXT NOT NULL,
        \`received_at\` DATETIME NOT NULL,
        PRIMARY KEY (\`id\`),
        KEY \`device_state_device_time\` (\`device_id\`, \`received_at\`)
      ) ${T}`);

      // source 'device' = table=errorlog uploads (Appendix 17); 'server' = what we saw (storage full,
      // a refused command, granted-but-not-desired). Never a body or a template.
      await create(`CREATE TABLE IF NOT EXISTS \`device_error_logs\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`device_id\` CHAR(36) NOT NULL,
        \`source\` VARCHAR(8) NOT NULL,
        \`kind\` VARCHAR(32) NOT NULL,
        \`code\` INT NULL,
        \`message\` VARCHAR(255) NULL,
        \`data_json\` TEXT NULL,
        \`occurred_at\` DATETIME NOT NULL,
        \`created_at\` DATETIME NOT NULL,
        PRIMARY KEY (\`id\`),
        KEY \`device_error_logs_device_time\` (\`device_id\`, \`created_at\`),
        KEY \`device_error_logs_kind_time\` (\`kind\`, \`created_at\`)
      ) ${T}`);

      // §7.5: PINs a device knows that match no member. Never auto-created as members.
      await create(`CREATE TABLE IF NOT EXISTS \`device_unlinked_users\` (
        \`device_id\` CHAR(36) NOT NULL,
        \`pin\` VARCHAR(16) NOT NULL,
        \`name\` VARCHAR(24) NULL,
        \`card_no\` VARCHAR(32) NULL,
        \`source\` VARCHAR(8) NOT NULL,
        \`first_seen_at\` DATETIME NOT NULL,
        \`last_seen_at\` DATETIME NOT NULL,
        \`hits\` INT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (\`device_id\`, \`pin\`)
      ) ${T}`);

      // §8.3 layer 3: one row per nightly audit; the PINs the device reported in its query packs.
      await create(`CREATE TABLE IF NOT EXISTS \`device_audits\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`device_id\` CHAR(36) NOT NULL,
        \`status\` VARCHAR(12) NOT NULL,
        \`query_cmd_id\` BIGINT UNSIGNED NULL,
        \`count_cmd_id\` BIGINT UNSIGNED NULL,
        \`packs_expected\` INT UNSIGNED NULL,
        \`packs_received\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`device_user_count\` INT NULL,
        \`desired_count\` INT NULL,
        \`extra_count\` INT NULL,
        \`missing_count\` INT NULL,
        \`unlinked_count\` INT NULL,
        \`report_json\` TEXT NULL,
        \`started_at\` DATETIME NOT NULL,
        \`finished_at\` DATETIME NULL,
        PRIMARY KEY (\`id\`),
        KEY \`device_audits_device_time\` (\`device_id\`, \`started_at\`),
        KEY \`device_audits_query_cmd\` (\`query_cmd_id\`)
      ) ${T}`);
      await create(`CREATE TABLE IF NOT EXISTS \`device_audit_pins\` (
        \`audit_id\` BIGINT UNSIGNED NOT NULL,
        \`pin\` VARCHAR(16) NOT NULL,
        PRIMARY KEY (\`audit_id\`, \`pin\`)
      ) ${T}`);

      // D-8: staff on devices, privilege 0 only, when this flag is on. Default off: nobody changes.
      if (await sequelize.query('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'gym_staff\'', { type: QueryTypes.SELECT }).then((r) => r.length > 0)) {
        if (!(await hasColumn('gym_staff', 'device_access'))) {
          await sequelize.query('ALTER TABLE `gym_staff` ADD COLUMN `device_access` TINYINT(1) NOT NULL DEFAULT 0');
        }
      }
      return null;
    },
  },
  {
    // ZKTeco Phase 3 (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §9, §10, §13, owner decision D-6):
    //   device_push_requests   the manual "Push now" / "Sync now" / remote-enrol requests (15 s / 60 s answer)
    //   device_capture_photos  ATTPHOTO capture photos, only for a branch that opted in; 30-day retention
    //   device_branch_settings per-branch device settings (capture photos off, owner alerts on)
    //   device_commands.merged_into          a biodata command sent inside another one (several members)
    //   device_unlinked_users dismissed / linked   the Unlinked users screen
    //   access_device_details.alerts_json    when each owner alert last went out (one per incident)
    // ROLLBACK (previous build first): DROP TABLE `device_branch_settings`, `device_capture_photos`,
    //   `device_push_requests`;
    //   ALTER TABLE `device_commands` DROP INDEX `device_commands_merged`, DROP COLUMN `merged_into`;
    //   ALTER TABLE `device_unlinked_users` DROP COLUMN `dismissed_at`, DROP COLUMN `linked_member_id`,
    //     DROP COLUMN `linked_at`;
    //   ALTER TABLE `access_device_details` DROP COLUMN `alerts_json`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 24;
    // Capture photo files stay in the private store after a rollback: delete the prefix
    // `device-captures/<tenant id>/` there too.
    version: 24,
    name: '024_device_push_and_settings',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;
      const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
      const hasColumn = async (table, column) =>
        (await sequelize.query(
          'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
          { replacements: [table, column], type: QueryTypes.SELECT }
        )).length > 0;
      const hasIndex = async (table, index) =>
        (await sequelize.query(
          'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
          { replacements: [table, index], type: QueryTypes.SELECT }
        )).length > 0;

      // §9.2. kind: member (push one member), remove (remove one member now), device / branch (every
      // pending change), enroll (remote ENROLL_BIO). dedupe_key: requester + target + 10 s or 60 s
      // window, so a double click or a second tab gets the same request (the rate limit).
      await sequelize.query(`CREATE TABLE IF NOT EXISTS \`device_push_requests\` (
        \`id\` CHAR(26) NOT NULL,
        \`kind\` VARCHAR(8) NOT NULL,
        \`requested_by\` CHAR(36) NULL,
        \`member_id\` CHAR(36) NULL,
        \`branch_id\` CHAR(36) NULL,
        \`device_ids_json\` TEXT NOT NULL,
        \`plan_json\` TEXT NULL,
        \`dedupe_key\` VARCHAR(160) NOT NULL,
        \`created_at\` DATETIME NOT NULL,
        \`deadline_at\` DATETIME NOT NULL,
        \`finished_at\` DATETIME NULL,
        \`result_json\` TEXT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`device_push_requests_dedupe\` (\`dedupe_key\`),
        KEY \`device_push_requests_requester\` (\`requested_by\`, \`created_at\`),
        KEY \`device_push_requests_open\` (\`finished_at\`, \`deadline_at\`)
      ) ${T}`);

      // D-6: encrypted in the private store; the row holds the key, never the image.
      await sequelize.query(`CREATE TABLE IF NOT EXISTS \`device_capture_photos\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`device_id\` CHAR(36) NOT NULL,
        \`branch_id\` CHAR(36) NOT NULL,
        \`event_id\` BIGINT UNSIGNED NULL,
        \`pin\` VARCHAR(16) NULL,
        \`device_time\` DATETIME NULL,
        \`storage_key\` VARCHAR(255) NOT NULL,
        \`key_version\` SMALLINT UNSIGNED NOT NULL,
        \`sha256\` CHAR(64) NOT NULL,
        \`size\` INT UNSIGNED NOT NULL,
        \`created_at\` DATETIME NOT NULL,
        PRIMARY KEY (\`id\`),
        KEY \`device_capture_photos_branch_time\` (\`branch_id\`, \`created_at\`),
        KEY \`device_capture_photos_event\` (\`event_id\`),
        KEY \`device_capture_photos_created\` (\`created_at\`)
      ) ${T}`);

      await sequelize.query(`CREATE TABLE IF NOT EXISTS \`device_branch_settings\` (
        \`branch_id\` CHAR(36) NOT NULL,
        \`capture_photos\` TINYINT(1) NOT NULL DEFAULT 0,
        \`alerts_enabled\` TINYINT(1) NOT NULL DEFAULT 1,
        \`updated_by\` CHAR(36) NULL,
        \`created_at\` DATETIME NOT NULL,
        \`updated_at\` DATETIME NOT NULL,
        PRIMARY KEY (\`branch_id\`)
      ) ${T}`);

      if (!(await hasColumn('device_commands', 'merged_into'))) {
        await sequelize.query('ALTER TABLE `device_commands` ADD COLUMN `merged_into` BIGINT UNSIGNED NULL AFTER `batch_id`');
      }
      if (!(await hasIndex('device_commands', 'device_commands_merged'))) {
        await sequelize.query('ALTER TABLE `device_commands` ADD INDEX `device_commands_merged` (`merged_into`)');
      }
      for (const [col, ddl] of [
        ['dismissed_at', '`dismissed_at` DATETIME NULL'],
        ['linked_member_id', '`linked_member_id` CHAR(36) NULL'],
        ['linked_at', '`linked_at` DATETIME NULL'],
      ]) {
        if (!(await hasColumn('device_unlinked_users', col))) await sequelize.query(`ALTER TABLE \`device_unlinked_users\` ADD COLUMN ${ddl}`);
      }
      if (!(await hasColumn('access_device_details', 'alerts_json'))) {
        await sequelize.query('ALTER TABLE `access_device_details` ADD COLUMN `alerts_json` TEXT NULL');
      }
      return null;
    },
  },
];

const TARGET_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// NEW-127: every tenant whose database can be live again without a provisioning run. A SUSPENDED
// tenant goes back to ACTIVE through assignTenantSubscription, a PENDING_DELETION one when the owner
// cancels; neither path migrates, so a deploy run that skipped them left them behind.
const MIGRATABLE_TENANT_STATUSES = Object.freeze(['ACTIVE', 'SUSPENDED', 'PENDING_DELETION']);

const hasTable = async (sequelize, table) => {
  const rows = await sequelize.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    { replacements: [table], type: QueryTypes.SELECT }
  );
  return rows.length > 0;
};

/**
 * Versions of `migrations` not recorded in `schema_migrations` (all of them when the table is missing).
 * Read-only.
 */
async function missingTenantMigrations(sequelize, migrations = MIGRATIONS) {
  if (!(await hasTable(sequelize, 'schema_migrations'))) return migrations.map((m) => m.version);
  const rows = await sequelize.query('SELECT version FROM schema_migrations', { type: QueryTypes.SELECT });
  const recorded = new Set(rows.map((r) => Number(r.version)));
  return migrations.map((m) => m.version).filter((v) => !recorded.has(v));
}

/**
 * NEW-127: a database that already has tenant tables but no `schema_migrations` was made before the
 * runner existed. Replaying every migration from 001 on it (backfills, collation conversion) is not
 * safe; it must be baselined first (src/scripts/repair-tenant-schema.js).
 */
async function isUnbaselinedTenantDb(sequelize) {
  return !(await hasTable(sequelize, 'schema_migrations')) && (await hasTable(sequelize, 'branches'));
}

const repairCommand = (tenantCode) => `node src/scripts/repair-tenant-schema.js --tenant ${tenantCode}`;

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
      status: { [Sequelize.Op.in]: MIGRATABLE_TENANT_STATUSES },
      connectionStringEncrypted: { [Sequelize.Op.ne]: null },
    },
  });

  const activeTenants = tenants.filter(
    (t) => t.connectionStringEncrypted && t.connectionStringEncrypted !== 'PENDING_PROVISIONING'
  );

  console.log(`[TenantMigration] Found ${activeTenants.length} tenant(s) (${MIGRATABLE_TENANT_STATUSES.join(', ')}) to ${options.dryRun ? 'preview (dry-run)' : 'migrate'}.`);

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

      if (await isUnbaselinedTenantDb(tenantSeq)) {
        throw new Error(
          `no schema_migrations table but tenant tables exist (made before the migration runner). Not touched. Run '${repairCommand(tenant.tenantCode)}' (dry run), then add --apply --confirm ${tenant.tenantCode}`
        );
      }

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
 * Read-only check of every tenant database the deploy runner covers (MIGRATABLE_TENANT_STATUSES):
 * is any of them behind TARGET_SCHEMA_VERSION, or could it not be read? 0 writes, never throws.
 * Reporting (error lines, alert, /health) is tenant-schema-health.service.js (NEW-126).
 *
 * @returns {Promise<{ checked: number, targetVersion: number,
 *   behind: Array<{ tenantId: string, tenantCode: string, status: string, currentVersion: number, targetVersion: number, hasMigrationTable: boolean }>,
 *   failed: Array<{ tenantId: string|null, tenantCode: string|null, error: string }> }>}
 */
async function checkTenantSchemaVersions() {
  const behind = [];
  const failed = [];
  let tenants;
  try {
    const { Tenant } = require('../models/platform');
    tenants = (await Tenant.findAll({
      where: {
        status: { [Sequelize.Op.in]: MIGRATABLE_TENANT_STATUSES },
        connectionStringEncrypted: { [Sequelize.Op.ne]: null },
      },
    })).filter((t) => t.connectionStringEncrypted !== 'PENDING_PROVISIONING');
  } catch (err) {
    failed.push({ tenantId: null, tenantCode: null, error: `could not list tenants: ${err.message}` });
    return { checked: 0, targetVersion: TARGET_SCHEMA_VERSION, behind, failed };
  }

  for (const tenant of tenants) {
    let tenantSeq = null;
    try {
      tenantSeq = new Sequelize(decrypt(tenant.connectionStringEncrypted), {
        dialect: 'mysql',
        logging: false,
        pool: { max: 1, min: 0, acquire: 10000, idle: 5000 },
        dialectOptions: { connectTimeout: 10000 },
      });
      await tenantSeq.authenticate();

      const hasMigrationTable = await hasTable(tenantSeq, 'schema_migrations');
      const missing = await missingTenantMigrations(tenantSeq);
      if (missing.length > 0) {
        let currentVersion = 0;
        if (hasMigrationTable) {
          const rows = await tenantSeq.query('SELECT MAX(version) AS max_version FROM schema_migrations', { type: QueryTypes.SELECT });
          currentVersion = Number(rows[0]?.max_version || 0);
        }
        behind.push({
          tenantId: tenant.id,
          tenantCode: tenant.tenantCode,
          status: tenant.status,
          currentVersion,
          targetVersion: TARGET_SCHEMA_VERSION,
          hasMigrationTable,
          missingVersions: missing,
        });
      }
    } catch (err) {
      failed.push({ tenantId: tenant.id, tenantCode: tenant.tenantCode, error: err.message });
    } finally {
      if (tenantSeq) await tenantSeq.close().catch(() => {});
    }
  }

  return { checked: tenants.length, targetVersion: TARGET_SCHEMA_VERSION, behind, failed };
}

module.exports = {
  MIGRATIONS,
  TARGET_SCHEMA_VERSION,
  MIGRATABLE_TENANT_STATUSES,
  ensureMigrationTable,
  missingTenantMigrations,
  isUnbaselinedTenantDb,
  repairCommand,
  runTenantMigrations,
  runAllTenantMigrations,
  checkTenantSchemaVersions,
};
