/**
 * Versioned migrations for the PLATFORM database (spec §6.5).
 *
 * Runs through the same runner as the tenant databases
 * (tenant-migration-runner.js#runTenantMigrations, given this list), so both
 * databases share one set of guarantees: tracked in `schema_migrations`,
 * idempotent, safe to re-run, and `--dry-run` previews with zero writes.
 *
 * Older platform columns are still added by the boot-time block in
 * platform.js#connect; new platform schema changes go here instead, so they
 * can be previewed before they are applied.
 *
 * Deploy order: run `node src/scripts/run-platform-migrations.js --dry-run`,
 * then without the flag, BEFORE the code that needs the change goes live.
 */
const { QueryTypes } = require('sequelize');
const { runTenantMigrations } = require('./tenant-migration-runner');

/**
 * Widens an ENUM column to exactly `values` (existing values first, new ones
 * appended — MySQL can then change it in place, without rebuilding the table).
 *
 * Never loses data: if the column today allows a value that `values` does not
 * list, or a row holds such a value, MODIFY would rewrite or reject it — the
 * migration is then skipped (not recorded) and the conflict is listed for a
 * human, like p003. Already widened → nothing to do.
 */
const _widenEnumColumn = async (sequelize, { table, column, values, defaultValue, migrationName }) => {
  const [tableExists] = await sequelize.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    { replacements: [table], type: QueryTypes.SELECT }
  );
  if (!tableExists) return null;

  const [col] = await sequelize.query(
    'SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ' +
      'AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: [table, column], type: QueryTypes.SELECT }
  );
  if (!col) throw new Error(`${migrationName}: ${table}.${column} does not exist`);
  const current = [...String(col.type).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, '\''));
  if (values.every((v) => current.includes(v)) && current.every((v) => values.includes(v))) return null;

  const unknownAllowed = current.filter((v) => !values.includes(v));
  const unknownRows = await sequelize.query(
    `SELECT \`${column}\` AS value, COUNT(*) AS n FROM \`${table}\` ` +
      `WHERE \`${column}\` NOT IN (${values.map(() => '?').join(',')}) GROUP BY \`${column}\``,
    { replacements: values, type: QueryTypes.SELECT }
  );
  if (unknownAllowed.length > 0 || unknownRows.length > 0) {
    console.warn(
      `[PlatformMigration] SKIPPING ${migrationName}: ${table}.${column} holds values this migration does not know ` +
        `(allowed: ${unknownAllowed.join(', ') || 'none'}; in rows: ` +
        `${unknownRows.map((r) => `${r.value} (${r.n})`).join(', ') || 'none'}). Resolve them by hand, then re-run.`
    );
    return { skipped: true, reason: 'unknown_enum_values', unknownAllowed, unknownRows };
  }

  const list = values.map((v) => `'${v.replace(/'/g, '\'\'')}'`).join(',');
  await sequelize.query(
    `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ENUM(${list}) NOT NULL DEFAULT '${defaultValue}'`
  );
  return null;
};

/**
 * Adds a nullable column. Already there with the same type → nothing to do.
 * Already there with a DIFFERENT type (someone added it by hand) → skipped (not
 * recorded) and reported, never altered: its data may mean something else.
 */
const _addNullableColumn = async (sequelize, { table, column, type, expectedType, migrationName }) => {
  const [col] = await sequelize.query(
    'SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ' +
      'AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: [table, column], type: QueryTypes.SELECT }
  );
  if (col) {
    if (String(col.type).toLowerCase() === expectedType && col.nullable === 'YES') return null;
    const [{ n }] = await sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` IS NOT NULL`, {
      type: QueryTypes.SELECT,
    });
    console.warn(
      `[PlatformMigration] SKIPPING ${migrationName}: ${table}.${column} already exists as ${col.type} ` +
        `(nullable: ${col.nullable}, ${n} row(s) with a value); expected ${expectedType} NULL. Resolve it by hand, then re-run.`
    );
    return { skipped: true, reason: 'column_exists_with_other_type', existingType: col.type, rowsWithValue: Number(n) };
  }
  await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type} NULL`);
  return null;
};

const PLATFORM_MIGRATIONS = [
  {
    version: 1,
    name: 'p001_create_billing_events',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      // Inbox for provider webhooks (BILL-12) — see BillingEvent.model.js.
      // `id` pinned to utf8mb4_bin to match what Sequelize generates for a
      // DataTypes.UUID column (see the note in platform.js#connect).
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS billing_events (
          id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
          provider ENUM('APPLE','GOOGLE','STRIPE') NOT NULL,
          provider_event_id VARCHAR(191) NOT NULL,
          event_type VARCHAR(100) NULL,
          raw_payload LONGTEXT NOT NULL,
          status ENUM('RECEIVED','PROCESSED','IGNORED','FAILED') NOT NULL DEFAULT 'RECEIVED',
          attempts INT NOT NULL DEFAULT 0,
          last_error VARCHAR(500) NULL,
          received_at DATETIME NOT NULL,
          processed_at DATETIME NULL,
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL,
          UNIQUE INDEX billing_events_provider_event (provider, provider_event_id),
          INDEX billing_events_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
    },
  },
  {
    version: 2,
    name: 'p002_tenant_subscriptions_status_revoked',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      // Adds REVOKED (BILL-02). Only ever grows the list, so existing values are
      // untouched and re-running is a no-op. Previously widened at every boot
      // in platform.js#connect (PENDING_MIGRATION/PENDING_CANCEL/SCHEDULED).
      await sequelize.query(
        'ALTER TABLE `tenant_subscriptions` MODIFY COLUMN `status` ' +
          'ENUM(\'ACTIVE\',\'EXPIRED\',\'CANCELLED\',\'PENDING_MIGRATION\',\'PENDING_CANCEL\',\'SCHEDULED\',\'REVOKED\') ' +
          'NOT NULL DEFAULT \'ACTIVE\''
      );
    },
  },
  {
    version: 3,
    name: 'p003_tenant_subscriptions_unique_external_id',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      // UNIQUE (platform, external_original_transaction_id): one row per store
      // subscription, so one owner (BILL-01). NULL ids (MANUAL rows) never
      // collide. Existing duplicates are never deleted or merged here — the
      // migration is skipped (not recorded) and they are listed for a human.
      const existing = await sequelize.query(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ' +
          'AND TABLE_NAME = \'tenant_subscriptions\' AND INDEX_NAME = \'tenant_subscriptions_platform_external_unique\' LIMIT 1',
        { type: QueryTypes.SELECT }
      );
      if (existing.length > 0) return;

      const duplicates = await sequelize.query(
        'SELECT platform, external_original_transaction_id AS externalId, COUNT(*) AS n ' +
          'FROM tenant_subscriptions WHERE external_original_transaction_id IS NOT NULL ' +
          'GROUP BY platform, external_original_transaction_id HAVING COUNT(*) > 1',
        { type: QueryTypes.SELECT }
      );
      if (duplicates.length > 0) {
        console.warn(
          `[PlatformMigration] SKIPPING p003: ${duplicates.length} store subscription id(s) appear on more than one ` +
            `tenant_subscriptions row: ${duplicates.map((d) => `${d.platform}:${d.externalId} (${d.n})`).join(', ')}. ` +
            'Resolve them by hand, then re-run.'
        );
        return { skipped: true, reason: 'duplicate_external_ids', duplicates };
      }

      await sequelize.query(
        'ALTER TABLE `tenant_subscriptions` ADD UNIQUE INDEX `tenant_subscriptions_platform_external_unique` ' +
          '(`platform`, `external_original_transaction_id`)'
      );
    },
  },
  {
    version: 4,
    name: 'p004_tenant_subscriptions_status_grace_hold_pause',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      // Adds GRACE, ON_HOLD, PAUSED (BILL-04, spec §7.4), appended after the
      // p002 list so existing values keep their positions.
      return _widenEnumColumn(sequelize, {
        table: 'tenant_subscriptions',
        column: 'status',
        values: [
          'ACTIVE', 'EXPIRED', 'CANCELLED', 'PENDING_MIGRATION', 'PENDING_CANCEL', 'SCHEDULED', 'REVOKED',
          'GRACE', 'ON_HOLD', 'PAUSED',
        ],
        defaultValue: 'ACTIVE',
        migrationName: 'p004',
      });
    },
  },
  {
    version: 5,
    name: 'p005_tenant_subscriptions_currency',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      // Currency of `amount`, from the provider's actual charge (BILL-05).
      // Existing rows stay NULL (= the catalog's PKR); no data is rewritten.
      return _addNullableColumn(sequelize, {
        table: 'tenant_subscriptions',
        column: 'currency',
        type: 'CHAR(3)',
        expectedType: 'char(3)',
        migrationName: 'p005',
      });
    },
  },
  {
    version: 6,
    name: 'p006_tenant_subscriptions_pending_change',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      // Deferred plan change + the host's keep-list (BILL-03). New rows only;
      // no existing data is rewritten.
      return _addNullableColumn(sequelize, {
        table: 'tenant_subscriptions',
        column: 'pending_change',
        type: 'JSON',
        expectedType: 'json',
        migrationName: 'p006',
      });
    },
  },
  {
    version: 7,
    name: 'p007_widen_capacity_events_action',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;
      return _widenEnumColumn(sequelize, {
        table: 'capacity_events',
        column: 'action',
        values: [
          'BRANCH_DELETED',
          'BRANCH_RESTORED',
          'SLOT_TRANSFERRED',
          'SLOT_TRIMMED_DOWNGRADE',
          'SLOT_ATTRIBUTED_UPGRADE',
          'SLOT_CONSUMED_BUILD',
          'ORG_DELETED',
          'ORG_BRANCHES_MOVED',
          'BRANCH_BILLING_LOCKED',
          'BRANCH_BILLING_UNLOCKED',
        ],
        defaultValue: 'BRANCH_DELETED',
        migrationName: 'p007',
      });
    },
  },
  {
    version: 8,
    name: 'p008_refresh_tokens_family_id',
    up: async (sequelize, context = {}) => {
      if (context.dryRun) return;
      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['refresh_tokens'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return;

      const [col] = await sequelize.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ' +
          'AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        { replacements: ['refresh_tokens', 'family_id'], type: QueryTypes.SELECT }
      );
      if (!col) {
        await sequelize.query('ALTER TABLE `refresh_tokens` ADD COLUMN `family_id` CHAR(36) NULL;');
      }

      // Add indexes if missing
      try {
        await sequelize.query('CREATE INDEX `refresh_tokens_family_id` ON `refresh_tokens` (`family_id`);');
      } catch (_) {}
    },
  },
  {
    version: 9,
    name: 'p009_otp_security_hash_and_attempts',
    up: async (sequelize, context = {}) => {
      if (context.dryRun) return;
      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['otps'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return;

      try {
        await sequelize.query('ALTER TABLE `otps` MODIFY COLUMN `code` VARCHAR(64) NOT NULL;');
      } catch (_) {}

      const [attemptsCol] = await sequelize.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ' +
          'AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        { replacements: ['otps', 'attempts'], type: QueryTypes.SELECT }
      );
      if (!attemptsCol) {
        await sequelize.query('ALTER TABLE `otps` ADD COLUMN `attempts` INT NOT NULL DEFAULT 0;');
      }

      const [maxAttemptsCol] = await sequelize.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ' +
          'AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        { replacements: ['otps', 'max_attempts'], type: QueryTypes.SELECT }
      );
      if (!maxAttemptsCol) {
        await sequelize.query('ALTER TABLE `otps` ADD COLUMN `max_attempts` INT NOT NULL DEFAULT 5;');
      }
    },
  },
  {
    version: 10,
    name: 'p010_tenant_invitations_and_audit',
    description: 'Create tenant_invitations and platform_audit_logs tables for AUTH-09 admin tenant invitation flow',
    up: async (sequelize, context) => {
      if (context.dryRun) return;

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS \`tenant_invitations\` (
          \`id\` CHAR(36) NOT NULL,
          \`token_hash\` VARCHAR(64) NOT NULL,
          \`owner_email\` VARCHAR(150) NOT NULL,
          \`owner_full_name\` VARCHAR(150) NOT NULL,
          \`owner_phone\` VARCHAR(25) NULL,
          \`business_name\` VARCHAR(200) NOT NULL,
          \`email\` VARCHAR(150) NOT NULL,
          \`phone\` VARCHAR(25) NULL,
          \`city_id\` INT NULL,
          \`package_id\` CHAR(36) NULL,
          \`invited_by\` CHAR(36) NOT NULL,
          \`status\` ENUM('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED') NOT NULL DEFAULT 'PENDING',
          \`expires_at\` DATETIME NOT NULL,
          \`accepted_at\` DATETIME NULL,
          \`tenant_id\` CHAR(36) NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`idx_tenant_invitations_token_hash\` (\`token_hash\`),
          KEY \`idx_tenant_invitations_owner_email\` (\`owner_email\`),
          KEY \`idx_tenant_invitations_status\` (\`status\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS \`platform_audit_logs\` (
          \`id\` CHAR(36) NOT NULL,
          \`actor_user_id\` CHAR(36) NULL,
          \`action\` VARCHAR(100) NOT NULL,
          \`target_type\` VARCHAR(50) NULL,
          \`target_id\` VARCHAR(100) NULL,
          \`details\` JSON NULL,
          \`created_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          KEY \`idx_platform_audit_actor\` (\`actor_user_id\`),
          KEY \`idx_platform_audit_action\` (\`action\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
    },
  },
];

const PLATFORM_TARGET_VERSION = PLATFORM_MIGRATIONS[PLATFORM_MIGRATIONS.length - 1].version;

/**
 * @param {import('sequelize').Sequelize} sequelize - the platform database connection.
 * @param {{ dryRun?: boolean, targetVersion?: number }} [options]
 */
const runPlatformMigrations = (sequelize, options = {}) =>
  runTenantMigrations(sequelize, {
    tenantId: 'platform',
    gymName: 'Platform DB',
    migrations: PLATFORM_MIGRATIONS,
    targetVersion: options.targetVersion,
    dryRun: options.dryRun === true,
  });

/**
 * Read-only startup check: warns when the platform database is behind
 * PLATFORM_TARGET_VERSION. Never writes, never throws.
 */
const checkPlatformSchemaVersion = async (sequelize) => {
  try {
    let currentVersion = 0;
    try {
      const rows = await sequelize.query('SELECT MAX(version) AS max_version FROM schema_migrations', {
        type: QueryTypes.SELECT,
      });
      currentVersion = rows[0]?.max_version || 0;
    } catch (_) {
      currentVersion = 0; // schema_migrations not created yet
    }
    if (currentVersion < PLATFORM_TARGET_VERSION) {
      console.warn(
        `[Deploy Warning] Platform schema version (${currentVersion}) is behind target (${PLATFORM_TARGET_VERSION}). ` +
          'Run \'node src/scripts/run-platform-migrations.js --dry-run\', then without --dry-run.'
      );
    }
    return { currentVersion, targetVersion: PLATFORM_TARGET_VERSION };
  } catch (err) {
    console.warn(`[Deploy Warning] Could not check platform schema version: ${err.message}`);
    return { currentVersion: null, targetVersion: PLATFORM_TARGET_VERSION };
  }
};

module.exports = {
  PLATFORM_MIGRATIONS,
  PLATFORM_TARGET_VERSION,
  runPlatformMigrations,
  checkPlatformSchemaVersion,
};
