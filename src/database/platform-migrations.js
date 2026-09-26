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
          "Run 'node src/scripts/run-platform-migrations.js --dry-run', then without --dry-run."
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
