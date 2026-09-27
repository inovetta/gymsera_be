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
