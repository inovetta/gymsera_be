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

/**
 * Appends `add` to the END of an ENUM column's current values (keeps every value
 * the column has today and their order, so MySQL changes it in place). Reuses
 * _widenEnumColumn for the checks and the ALTER. Already has them → nothing to do.
 */
const _appendEnumValues = async (sequelize, { table, column, add, defaultValue, migrationName }) => {
  const [col] = await sequelize.query(
    'SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ' +
      'AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: [table, column], type: QueryTypes.SELECT }
  );
  if (!col) throw new Error(`${migrationName}: ${table}.${column} does not exist`);
  const current = [...String(col.type).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, '\''));
  return _widenEnumColumn(sequelize, {
    table,
    column,
    values: [...current, ...add.filter((v) => !current.includes(v))],
    defaultValue,
    migrationName,
  });
};

/**
 * Account-deletion schema for one table (AUTH-07): widen `status`, then add the
 * nullable columns. ALL-OR-NOTHING: every column is checked before anything is
 * written, so a conflict (a column someone added by hand with another type, or
 * NOT NULL) leaves the table exactly as it was — skipped, not recorded, listed.
 */
const _addAccountDeletionSchema = async (sequelize, { table, extraColumns = [], addStatuses, defaultStatus, migrationName }) => {
  const [tableExists] = await sequelize.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    { replacements: [table], type: QueryTypes.SELECT }
  );
  if (!tableExists) return null;

  const wanted = [
    { column: 'deletion_requested_at', type: 'DATETIME', expectedType: 'datetime' },
    { column: 'deletion_scheduled_for', type: 'DATETIME', expectedType: 'datetime' },
    { column: 'deleted_at', type: 'DATETIME', expectedType: 'datetime' },
    ...extraColumns,
  ];
  const existing = await sequelize.query(
    'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (?)',
    { replacements: [table, wanted.map((c) => c.column)], type: QueryTypes.SELECT }
  );
  const toAdd = [];
  for (const c of wanted) {
    const col = existing.find((e) => e.name === c.column);
    if (!col) {
      toAdd.push(c);
      continue;
    }
    if (String(col.type).toLowerCase() !== c.expectedType || col.nullable !== 'YES') {
      console.warn(
        `[PlatformMigration] SKIPPING ${migrationName}: ${table}.${c.column} already exists as ${col.type} ` +
          `(nullable: ${col.nullable}); expected ${c.expectedType} NULL. Resolve it by hand, then re-run.`
      );
      return { skipped: true, reason: 'column_exists_with_other_type', column: c.column, existingType: col.type };
    }
  }

  const widened = await _appendEnumValues(sequelize, {
    table, column: 'status', add: addStatuses, defaultValue: defaultStatus, migrationName,
  });
  if (widened?.skipped) return widened;

  if (toAdd.length > 0) {
    await sequelize.query(
      `ALTER TABLE \`${table}\` ${toAdd.map((c) => `ADD COLUMN \`${c.column}\` ${c.type} NULL`).join(', ')}`
    );
  }
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
        'ALTER TABLE `organization_subscriptions` MODIFY COLUMN `status` ' +
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
          'AND TABLE_NAME = \'organization_subscriptions\' AND INDEX_NAME = \'organization_subscriptions_platform_external_unique\' LIMIT 1',
        { type: QueryTypes.SELECT }
      );
      if (existing.length > 0) return;

      const duplicates = await sequelize.query(
        'SELECT platform, external_original_transaction_id AS externalId, COUNT(*) AS n ' +
          'FROM organization_subscriptions WHERE external_original_transaction_id IS NOT NULL ' +
          'GROUP BY platform, external_original_transaction_id HAVING COUNT(*) > 1',
        { type: QueryTypes.SELECT }
      );
      if (duplicates.length > 0) {
        console.warn(
          `[PlatformMigration] SKIPPING p003: ${duplicates.length} store subscription id(s) appear on more than one ` +
            `organization_subscriptions row: ${duplicates.map((d) => `${d.platform}:${d.externalId} (${d.n})`).join(', ')}. ` +
            'Resolve them by hand, then re-run.'
        );
        return { skipped: true, reason: 'duplicate_external_ids', duplicates };
      }

      await sequelize.query(
        'ALTER TABLE `organization_subscriptions` ADD UNIQUE INDEX `organization_subscriptions_platform_external_unique` ' +
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
        table: 'organization_subscriptions',
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
        table: 'organization_subscriptions',
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
        table: 'organization_subscriptions',
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
          // R-120: ORG_DELETED / ORG_BRANCHES_MOVED until p033 renamed them (they are business events).
          'BUSINESS_DELETED',
          'BUSINESS_BRANCHES_MOVED',
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
      if (context?.dryRun === true) return;
      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['refresh_tokens'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return null;

      const res = await _addNullableColumn(sequelize, {
        table: 'refresh_tokens',
        column: 'family_id',
        type: 'CHAR(36)',
        expectedType: 'char(36)',
        migrationName: 'p008',
      });
      if (res?.skipped) return res;

      // Add indexes if missing
      try {
        await sequelize.query('CREATE INDEX `refresh_tokens_family_id` ON `refresh_tokens` (`family_id`);');
      } catch (_) { /* ignored on purpose */ }
      return null;
    },
  },
  {
    version: 9,
    name: 'p009_otp_security_hash_and_attempts',
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return;
      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['otps'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return null;

      // Check code column
      const [codeCol] = await sequelize.query(
        'SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        { replacements: ['otps', 'code'], type: QueryTypes.SELECT }
      );
      if (codeCol && !String(codeCol.type).toLowerCase().startsWith('varchar')) {
        console.warn(
          `[PlatformMigration] SKIPPING p009: otps.code already exists as ${codeCol.type}; expected VARCHAR. Resolve it by hand, then re-run.`
        );
        return {
          skipped: true,
          reason: 'column_exists_with_other_type',
          column: 'code',
          existingType: codeCol.type,
        };
      }

      // Check attempts column
      const [attemptsCol] = await sequelize.query(
        'SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        { replacements: ['otps', 'attempts'], type: QueryTypes.SELECT }
      );
      if (attemptsCol && !String(attemptsCol.type).toLowerCase().startsWith('int')) {
        console.warn(
          `[PlatformMigration] SKIPPING p009: otps.attempts already exists as ${attemptsCol.type}; expected INT. Resolve it by hand, then re-run.`
        );
        return {
          skipped: true,
          reason: 'column_exists_with_other_type',
          column: 'attempts',
          existingType: attemptsCol.type,
        };
      }

      // Check max_attempts column
      const [maxAttemptsCol] = await sequelize.query(
        'SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        { replacements: ['otps', 'max_attempts'], type: QueryTypes.SELECT }
      );
      if (maxAttemptsCol && !String(maxAttemptsCol.type).toLowerCase().startsWith('int')) {
        console.warn(
          `[PlatformMigration] SKIPPING p009: otps.max_attempts already exists as ${maxAttemptsCol.type}; expected INT. Resolve it by hand, then re-run.`
        );
        return {
          skipped: true,
          reason: 'column_exists_with_other_type',
          column: 'max_attempts',
          existingType: maxAttemptsCol.type,
        };
      }

      // All checks passed — perform DDL modifications
      await sequelize.query('ALTER TABLE `otps` MODIFY COLUMN `code` VARCHAR(64) NOT NULL;');
      if (!attemptsCol) {
        await sequelize.query('ALTER TABLE `otps` ADD COLUMN `attempts` INT NOT NULL DEFAULT 0;');
      }
      if (!maxAttemptsCol) {
        await sequelize.query('ALTER TABLE `otps` ADD COLUMN `max_attempts` INT NOT NULL DEFAULT 5;');
      }
      return null;
    },
  },
  {
    version: 10,
    name: 'p010_tenant_invitations_and_audit',
    description: 'Create tenant_invitations and platform_audit_logs tables for AUTH-09 admin tenant invitation flow',
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return;

      const [invCol] = await sequelize.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        { replacements: ['organization_invitations', 'token_hash'], type: QueryTypes.SELECT }
      );
      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['organization_invitations'], type: QueryTypes.SELECT }
      );
      if (tableExists && !invCol) {
        console.warn(
          '[PlatformMigration] SKIPPING p010: organization_invitations table exists without token_hash column. Resolve it by hand, then re-run.'
        );
        return {
          skipped: true,
          reason: 'table_exists_with_other_schema',
          table: 'organization_invitations',
        };
      }

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS \`organization_invitations\` (
          \`id\` CHAR(36) NOT NULL,
          \`token_hash\` VARCHAR(64) NOT NULL,
          \`owner_email\` VARCHAR(150) NOT NULL,
          \`owner_full_name\` VARCHAR(150) NOT NULL,
          \`owner_phone\` VARCHAR(25) NULL,
          \`organization_name\` VARCHAR(200) NOT NULL,
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
          UNIQUE KEY \`idx_organization_invitations_token_hash\` (\`token_hash\`),
          KEY \`idx_organization_invitations_owner_email\` (\`owner_email\`),
          KEY \`idx_organization_invitations_status\` (\`status\`)
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
      return null;
    },
  },
  {
    version: 11,
    name: 'p011_create_idempotency_records',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return;

      const [idemCol] = await sequelize.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'idempotency_records\' AND COLUMN_NAME = \'idempotency_key\'',
        { type: QueryTypes.SELECT }
      );
      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['idempotency_records'], type: QueryTypes.SELECT }
      );
      if (tableExists && !idemCol) {
        console.warn(
          '[PlatformMigration] SKIPPING p011: idempotency_records table exists without idempotency_key column. Resolve it by hand, then re-run.'
        );
        return {
          skipped: true,
          reason: 'table_exists_with_other_schema',
          table: 'idempotency_records',
        };
      }

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
      return null;
    },
  },
  {
    version: 12,
    name: 'p012_add_payment_details_updated_at',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;

      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['organizations'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return null;

      const [col] = await sequelize.query(
        'SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'organizations\' AND COLUMN_NAME = \'payment_details_updated_at\'',
        { type: QueryTypes.SELECT }
      );
      if (col) {
        if (col.DATA_TYPE !== 'datetime' && col.DATA_TYPE !== 'timestamp') {
          console.warn(
            '[PlatformMigration] SKIPPING p012: payment_details_updated_at exists with non-datetime type. Resolve by hand, then re-run.'
          );
          return {
            skipped: true,
            reason: 'column_exists_with_other_type',
            table: 'organizations',
          };
        }
        return null;
      }

      await sequelize.query(`
        ALTER TABLE \`organizations\`
        ADD COLUMN \`payment_details_updated_at\` DATETIME NULL
        AFTER \`payment_details_json\`;
      `);
      return null;
    },
  },
  {
    version: 13,
    name: 'p013_tenants_provisioning_state',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;
      // Resumable provisioning (FLOW-02): the last finished step, a lease lock
      // (token + expiry) so only one run provisions a tenant, and the last
      // error for the admin. All NULL on existing rows; no data is rewritten.
      const columns = [
        { column: 'provisioning_state', type: 'VARCHAR(32)', expectedType: 'varchar(32)' },
        { column: 'provisioning_lock_token', type: 'CHAR(36)', expectedType: 'char(36)' },
        { column: 'provisioning_locked_until', type: 'DATETIME', expectedType: 'datetime' },
        { column: 'provisioning_error', type: 'VARCHAR(500)', expectedType: 'varchar(500)' },
      ];
      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['organizations'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return null;

      // Check every column before changing anything, so a conflict leaves the
      // table exactly as it was (like _addNullableColumn, but all-or-nothing).
      const existing = await sequelize.query(
        'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS ' +
          'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'organizations\' AND COLUMN_NAME IN (?)',
        { replacements: [columns.map((c) => c.column)], type: QueryTypes.SELECT }
      );
      const toAdd = [];
      for (const c of columns) {
        const col = existing.find((e) => e.name === c.column);
        if (!col) {
          toAdd.push(c);
          continue;
        }
        if (String(col.type).toLowerCase() !== c.expectedType || col.nullable !== 'YES') {
          console.warn(
            `[PlatformMigration] SKIPPING p013: tenants.${c.column} already exists as ${col.type} ` +
              `(nullable: ${col.nullable}); expected ${c.expectedType} NULL. Resolve it by hand, then re-run.`
          );
          return { skipped: true, reason: 'column_exists_with_other_type', column: c.column, existingType: col.type };
        }
      }
      if (toAdd.length === 0) return null;
      await sequelize.query(
        `ALTER TABLE \`organizations\` ${toAdd.map((c) => `ADD COLUMN \`${c.column}\` ${c.type} NULL`).join(', ')}`
      );
      return null;
    },
  },
  {
    version: 14,
    name: 'p014_users_account_deletion',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;
      // Self-service account deletion (AUTH-07, R-28): PENDING_DELETION = inside the
      // 30-day undo window, DELETED = anonymized. All new columns are NULL on
      // existing rows; no data is rewritten.
      return _addAccountDeletionSchema(sequelize, {
        table: 'users',
        addStatuses: ['PENDING_DELETION', 'DELETED'],
        defaultStatus: 'INACTIVE',
        migrationName: 'p014',
      });
    },
  },
  {
    version: 15,
    name: 'p015_tenants_account_deletion',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;
      // Same for tenants (AUTH-07, R-28); `status_before_deletion` is what undo restores.
      return _addAccountDeletionSchema(sequelize, {
        table: 'organizations',
        extraColumns: [{ column: 'status_before_deletion', type: 'VARCHAR(20)', expectedType: 'varchar(20)' }],
        addStatuses: ['PENDING_DELETION', 'DELETED'],
        defaultStatus: 'DRAFT',
        migrationName: 'p015',
      });
    },
  },
  {
    version: 16,
    name: 'p016_users_apple_refresh_token',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;
      // Sign in with Apple: the (encrypted) refresh token, kept only so account deletion can
      // revoke it at Apple (AUTH-07, R-28 point 5). NULL for everyone until their next Apple sign-in.
      // A platform database without a `users` table yet (a scratch/partial database) has nothing to alter.
      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['users'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return null;
      return _addNullableColumn(sequelize, {
        table: 'users',
        column: 'apple_refresh_token_encrypted',
        type: 'TEXT',
        expectedType: 'text',
        migrationName: 'p016',
      });
    },
  },
  {
    version: 17,
    name: 'p017_tenant_subscriptions_duplicate_billing',
    up: async (sequelize, context) => {
      if (context?.dryRun === true) return null;
      // BILL-09: Flag on superseded subscription rows that the provider still reports
      // as auto-renewing / billing. Prompts a banner to the host with a manage link.
      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['organization_subscriptions'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return null;
      return _addNullableColumn(sequelize, {
        table: 'organization_subscriptions',
        column: 'duplicate_billing',
        type: 'TINYINT(1) DEFAULT 0',
        expectedType: 'tinyint(1)',
        migrationName: 'p017',
      });
    },
  },
  {
    version: 18,
    name: 'p018_create_audit_logs',
    description: 'Create audit_logs table for HTTP mutation audit logging (SEC-12)',
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;

      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['audit_logs'], type: QueryTypes.SELECT }
      );
      if (tableExists) {
        const [statusCol] = await sequelize.query(
          'SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'audit_logs\' AND COLUMN_NAME = \'status_code\'',
          { type: QueryTypes.SELECT }
        );
        if (!statusCol || (statusCol.DATA_TYPE !== 'smallint' && statusCol.DATA_TYPE !== 'int')) {
          console.warn(
            '[PlatformMigration] SKIPPING p018: audit_logs table exists without valid status_code column. Resolve it by hand, then re-run.'
          );
          return {
            skipped: true,
            reason: 'table_exists_with_other_schema',
            table: 'audit_logs',
          };
        }
        return null;
      }

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS \`audit_logs\` (
          \`id\` CHAR(36) NOT NULL,
          \`user_id\` CHAR(36) NULL,
          \`tenant_id\` CHAR(36) NULL,
          \`method\` VARCHAR(10) NOT NULL,
          \`path\` VARCHAR(500) NOT NULL,
          \`status_code\` SMALLINT NOT NULL,
          \`ip_address\` VARCHAR(45) NULL,
          \`user_agent\` TEXT NULL,
          \`duration_ms\` INT NOT NULL,
          \`created_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          KEY \`idx_audit_logs_user_id\` (\`user_id\`),
          KEY \`idx_audit_logs_tenant_id\` (\`tenant_id\`),
          KEY \`idx_audit_logs_created_at\` (\`created_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      return null;
    },
  },
  {
    version: 19,
    name: 'p019_create_billing_plan_prices',
    description: 'Per-currency catalog prices and Stripe Price IDs for each BillingPlan tier (BILL-11)',
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;

      const [plansExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['billing_plans'], type: QueryTypes.SELECT }
      );
      if (!plansExists) return null;

      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['billing_plan_prices'], type: QueryTypes.SELECT }
      );
      if (tableExists) {
        const [col] = await sequelize.query(
          'SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'billing_plan_prices\' AND COLUMN_NAME = \'monthly_minor\'',
          { type: QueryTypes.SELECT }
        );
        if (!col || String(col.DATA_TYPE).toLowerCase() !== 'bigint') {
          console.warn(
            '[PlatformMigration] SKIPPING p019: billing_plan_prices exists with another shape. Resolve it by hand, then re-run.'
          );
          return { skipped: true, reason: 'table_exists_with_other_schema', table: 'billing_plan_prices' };
        }
        return null;
      }

      // billing_plans.id may carry a different collation on old databases, so no FOREIGN KEY here
      // (a failing constraint would block the whole migration); the service layer validates the plan.
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS \`billing_plan_prices\` (
          \`id\` CHAR(36) NOT NULL,
          \`billing_plan_id\` CHAR(36) NOT NULL,
          \`currency\` VARCHAR(3) NOT NULL,
          \`monthly_minor\` BIGINT NOT NULL,
          \`annual_minor\` BIGINT NOT NULL,
          \`stripe_monthly_price_id\` VARCHAR(150) NULL,
          \`stripe_annual_price_id\` VARCHAR(150) NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`billing_plan_prices_plan_currency\` (\`billing_plan_id\`, \`currency\`),
          KEY \`billing_plan_prices_stripe_monthly\` (\`stripe_monthly_price_id\`),
          KEY \`billing_plan_prices_stripe_annual\` (\`stripe_annual_price_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      return null;
    },
  },
  {
    version: 20,
    name: 'p020_add_device_token_context',
    description: 'device_tokens.app_version, locale, timezone (RT-01). Nullable, no backfill; safe to re-run.',
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;

      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['device_tokens'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return null;

      const columns = [
        ['app_version', 'VARCHAR(40) NULL'],
        ['locale', 'VARCHAR(35) NULL'],
        ['timezone', 'VARCHAR(64) NULL'],
      ];
      for (const [name, ddl] of columns) {
        const [has] = await sequelize.query(
          'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'device_tokens\' AND COLUMN_NAME = ?',
          { replacements: [name], type: QueryTypes.SELECT }
        );
        if (!has) await sequelize.query(`ALTER TABLE \`device_tokens\` ADD COLUMN \`${name}\` ${ddl}`);
      }
      return null;
    },
  },
  {
    version: 21,
    name: 'p021_add_message_client_message_id',
    description:
      'messages.client_message_id (nullable, no backfill) + UNIQUE (conversation_id, sender_id, client_message_id) so a resent message is idempotent (RT-05). Safe to re-run.',
    // BACKUP before applying live:  mysqldump <platform_db> messages > messages_pre_p021.sql
    // ROLLBACK (deploy the previous app build FIRST: the model selects this column):
    //   ALTER TABLE `messages` DROP INDEX `messages_conversation_sender_client_msg`, DROP COLUMN `client_message_id`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 21;
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;

      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['messages'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return null;

      const [col] = await sequelize.query(
        'SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'messages\' AND COLUMN_NAME = \'client_message_id\'',
        { type: QueryTypes.SELECT }
      );
      if (col && String(col.DATA_TYPE).toLowerCase() !== 'varchar') {
        console.warn(
          '[PlatformMigration] SKIPPING p021: messages.client_message_id exists with another type. Resolve it by hand, then re-run.'
        );
        return { skipped: true, reason: 'column_exists_with_other_type', table: 'messages' };
      }
      if (!col) {
        await sequelize.query('ALTER TABLE `messages` ADD COLUMN `client_message_id` VARCHAR(64) NULL');
      }

      const [hasIndex] = await sequelize.query(
        'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'messages\' AND INDEX_NAME = \'messages_conversation_sender_client_msg\' LIMIT 1',
        { type: QueryTypes.SELECT }
      );
      if (hasIndex) return null;

      // A pre-existing column could already hold repeated keys; never delete rows to make the
      // constraint fit. NULLs (every old row) never collide.
      const [dup] = await sequelize.query(
        'SELECT conversation_id FROM `messages` WHERE client_message_id IS NOT NULL GROUP BY conversation_id, sender_id, client_message_id HAVING COUNT(*) > 1 LIMIT 1',
        { type: QueryTypes.SELECT }
      );
      if (dup) {
        console.warn(
          '[PlatformMigration] SKIPPING p021 unique key: duplicate (conversation_id, sender_id, client_message_id) rows exist. Resolve them by hand, then re-run.'
        );
        return { skipped: true, reason: 'duplicate_client_message_ids', table: 'messages' };
      }
      await sequelize.query(
        'ALTER TABLE `messages` ADD UNIQUE KEY `messages_conversation_sender_client_msg` (`conversation_id`, `sender_id`, `client_message_id`)'
      );
      return null;
    },
  },
  {
    version: 22,
    name: 'p022_billing_events_tenant_id',
    description:
      'billing_events.tenant_id (nullable, no backfill) + index (tenant_id, status, received_at) so an admin can list a tenant\'s billing events (OBS-05). Safe to re-run.',
    // BACKUP before applying live:  mysqldump <platform_db> billing_events > billing_events_pre_p022.sql
    // ROLLBACK (deploy the previous app build FIRST: the model selects this column):
    //   ALTER TABLE `billing_events` DROP INDEX `billing_events_tenant_status`, DROP COLUMN `tenant_id`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 22;
    // Old rows keep tenant_id NULL (no backfill): their tenant is not recorded anywhere reliable,
    // and guessing it from the payload would attach events to the wrong tenant.
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;

      const [tableExists] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: ['billing_events'], type: QueryTypes.SELECT }
      );
      if (!tableExists) return null;

      // Same type and collation as tenants.id / tenant_subscriptions.tenant_id (CHAR(36) utf8mb4_bin).
      const added = await _addNullableColumn(sequelize, {
        table: 'billing_events',
        column: 'tenant_id',
        type: 'CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
        expectedType: 'char(36)',
        migrationName: 'p022',
      });
      if (added?.skipped) return added;

      const [hasIndex] = await sequelize.query(
        'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'billing_events\' AND INDEX_NAME = \'billing_events_tenant_status\' LIMIT 1',
        { type: QueryTypes.SELECT }
      );
      if (!hasIndex) {
        await sequelize.query(
          'ALTER TABLE `billing_events` ADD INDEX `billing_events_tenant_status` (`tenant_id`, `status`, `received_at`)'
        );
      }
      return null;
    },
  },
  {
    version: 23,
    name: 'p023_billing_plan_price_checks',
    description:
      'billing_plan_price_checks: the result of the read-only store price check per plan and provider (BILL-15). New table only; nothing existing changes. Safe to re-run.',
    // BACKUP: not needed (new table).
    // ROLLBACK (deploy the previous app build first; it does not read this table):
    //   DROP TABLE `billing_plan_price_checks`;  DELETE FROM `schema_migrations` WHERE `version` = 23;
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`billing_plan_price_checks\` (
          \`id\` CHAR(36) BINARY NOT NULL,
          \`billing_plan_id\` CHAR(36) BINARY NOT NULL,
          \`provider\` VARCHAR(10) NOT NULL,
          \`status\` ENUM('VERIFIED','MISMATCH','UNVERIFIABLE') NOT NULL,
          \`mismatch_count\` INT NOT NULL DEFAULT 0,
          \`details_json\` JSON NULL,
          \`checked_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`billing_plan_price_checks_billing_plan_id_provider\` (\`billing_plan_id\`, \`provider\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      return null;
    },
  },
  {
    version: 24,
    name: 'p024_city_area_google_place',
    description:
      'cities.google_place_id / latitude / longitude and areas.google_place_id (nullable, no backfill) + unique keys on the place ids, so Places results upsert without duplicates (Phase 7 P3, BUG-01). Safe to re-run.',
    // BACKUP before applying live:  mysqldump <platform_db> cities areas > cities_areas_pre_p024.sql
    // ROLLBACK (deploy the previous app build FIRST: the models select these columns):
    //   ALTER TABLE `cities` DROP INDEX `cities_google_place_id`, DROP COLUMN `google_place_id`, DROP COLUMN `latitude`, DROP COLUMN `longitude`;
    //   ALTER TABLE `areas` DROP INDEX `areas_google_place_id`, DROP COLUMN `google_place_id`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 24;
    // Existing cities and areas keep NULL (no backfill): the first time someone picks one from Google
    // it is matched by name and gets its place id then.
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;

      const columns = [
        { table: 'cities', column: 'google_place_id', type: 'VARCHAR(255)', expectedType: 'varchar(255)' },
        { table: 'cities', column: 'latitude', type: 'DECIMAL(10,8)', expectedType: 'decimal(10,8)' },
        { table: 'cities', column: 'longitude', type: 'DECIMAL(11,8)', expectedType: 'decimal(11,8)' },
        { table: 'areas', column: 'google_place_id', type: 'VARCHAR(255)', expectedType: 'varchar(255)' },
      ];
      const present = new Set(
        (await sequelize.query(
          'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (\'cities\', \'areas\')',
          { type: QueryTypes.SELECT }
        )).map((r) => r.name)
      );
      for (const c of columns) {
        if (!present.has(c.table)) continue; // created later with the column (model sync)
        const added = await _addNullableColumn(sequelize, { ...c, migrationName: 'p024' });
        if (added?.skipped) return added;
      }

      for (const table of ['cities', 'areas']) {
        if (!present.has(table)) continue;
        const index = `${table}_google_place_id`;
        const [hasIndex] = await sequelize.query(
          'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
          { replacements: [table, index], type: QueryTypes.SELECT }
        );
        if (!hasIndex) {
          await sequelize.query(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${index}\` (\`google_place_id\`)`);
        }
      }
      return null;
    },
  },
  {
    version: 25,
    name: 'p025_city_country_code',
    description:
      'cities.country_code VARCHAR(2) NULL (no backfill), so Places autocomplete stays in the selected city country (P3 device follow-up). Safe to re-run.',
    // BACKUP before applying live:  mysqldump <platform_db> cities > cities_pre_p025.sql
    // ROLLBACK (deploy the previous app build FIRST: the City model selects this column):
    //   ALTER TABLE `cities` DROP COLUMN `country_code`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 25;
    // Existing cities keep NULL, which means the default country (GOOGLE_PLACES_REGION_CODES, else
    // Pakistan); a city gets its code the next time it is resolved from Google.
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      const [hasTable] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'cities\' LIMIT 1',
        { type: QueryTypes.SELECT }
      );
      if (!hasTable) return null; // created later with the column (model sync)
      const added = await _addNullableColumn(sequelize, {
        table: 'cities',
        column: 'country_code',
        type: 'VARCHAR(2)',
        expectedType: 'varchar(2)',
        migrationName: 'p025',
      });
      return added?.skipped ? added : null;
    },
  },
  {
    version: 26,
    name: 'p026_tenant_subscriptions_entitlement_ended_at',
    description:
      'organization_subscriptions.entitlement_ended_at DATETIME NULL (no backfill): when a plan stopped entitling, so a lapsed plan locks branches after the 7-day over-quota grace (P7c, R-82, NEW-170). Safe to re-run.',
    // BACKUP before applying live:  mysqldump <platform_db> tenant_subscriptions > tenant_subscriptions_pre_p026.sql
    // ROLLBACK (deploy the previous app build FIRST: the TenantSubscription model selects this column):
    //   ALTER TABLE `tenant_subscriptions` DROP COLUMN `entitlement_ended_at`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 26;
    // Rows that are already lapsed keep NULL; the first capacity pass after the deploy sets it to that
    // moment (branch-billing-lock.service.js), so those hosts get the full 7 days from the deploy.
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      const [hasTable] = await sequelize.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'organization_subscriptions\' LIMIT 1',
        { type: QueryTypes.SELECT }
      );
      if (!hasTable) return null; // created later with the column (model sync)
      const added = await _addNullableColumn(sequelize, {
        table: 'organization_subscriptions',
        column: 'entitlement_ended_at',
        type: 'DATETIME',
        expectedType: 'datetime',
        migrationName: 'p026',
      });
      return added?.skipped ? added : null;
    },
  },
  {
    version: 27,
    name: 'p027_payout_accounts',
    description:
      'payout_accounts: the tenant\'s payout account (tenant id + OPTIONAL organization id, provider BANK_TRANSFER), and each tenant\'s saved tenants.payment_details_json copied in as its tenant default (P7b, R-73, R-94, NEW-217). tenants.payment_details_json is kept, not cleared. Safe to re-run.',
    // PREVIEW (read-only) before applying live:  node src/scripts/preview-payout-accounts-backfill.js
    // BACKUP before applying live:  mysqldump <platform_db> tenants > tenants_pre_p027.sql
    // ROLLBACK (deploy the previous API build FIRST: this build reads only payout_accounts):
    //   UPDATE tenants t JOIN payout_accounts a ON a.tenant_id = t.id AND a.scope_key = 'TENANT' AND a.provider = 'BANK_TRANSFER'
    //     SET t.payment_details_json = a.details_json, t.payment_details_updated_at = a.details_updated_at;
    //   DROP TABLE `payout_accounts`;  DELETE FROM `schema_migrations` WHERE `version` = 27;
    // (the UPDATE carries back details saved after the deploy; without it the previous build shows the pre-deploy values)
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      const { planPayoutAccountBackfill, applyPayoutAccountBackfill } = require('./payout-accounts-backfill');
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`payout_accounts\` (
          \`id\` CHAR(36) BINARY NOT NULL,
          \`tenant_id\` CHAR(36) BINARY NOT NULL,
          \`business_id\` CHAR(36) BINARY NULL,
          \`scope_key\` VARCHAR(36) NOT NULL,
          \`provider\` VARCHAR(32) NOT NULL DEFAULT 'BANK_TRANSFER',
          \`status\` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
          \`country_code\` VARCHAR(2) NULL,
          \`external_account_id\` VARCHAR(255) NULL,
          \`capabilities_json\` JSON NULL,
          \`details_json\` JSON NULL,
          \`details_updated_at\` DATETIME NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`payout_accounts_tenant_scope_provider\` (\`tenant_id\`, \`scope_key\`, \`provider\`),
          KEY \`payout_accounts_business_id\` (\`business_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      const plan = await planPayoutAccountBackfill(sequelize);
      const copied = await applyPayoutAccountBackfill(sequelize, plan);
      console.log(
        `[PlatformMigration] p027: copied ${copied} tenant default payout account(s); ` +
          `${plan.alreadyHaveDefault.length} already had one; ${plan.emptyOrUnreadable.length} empty or unreadable (left as they are).`
      );
      return null;
    },
  },
  {
    version: 28,
    name: 'p028_plan_payment_requests',
    description:
      'plan_payment_requests: a host pays for a GymsEra plan outside the stores (bank transfer with a receipt), a platform admin approves or rejects (P9c item D, R-95). New table only; nothing existing changes. Safe to re-run.',
    // ROLLBACK (deploy the previous API build FIRST: it never reads this table):
    //   DROP TABLE `plan_payment_requests`;  DELETE FROM `schema_migrations` WHERE `version` = 28;
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`plan_payment_requests\` (
          \`id\` CHAR(36) BINARY NOT NULL,
          \`tenant_id\` CHAR(36) BINARY NOT NULL,
          \`requested_by_user_id\` CHAR(36) BINARY NOT NULL,
          \`billing_plan_id\` CHAR(36) BINARY NOT NULL,
          \`branch_count\` INT NOT NULL,
          \`billing_cycle\` VARCHAR(16) NOT NULL,
          \`amount\` DECIMAL(12,2) NOT NULL,
          \`currency\` VARCHAR(3) NOT NULL,
          \`method\` VARCHAR(32) NOT NULL DEFAULT 'BANK_TRANSFER',
          \`status\` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
          \`proof_key\` VARCHAR(500) NULL,
          \`payer_reference\` VARCHAR(100) NULL,
          \`external_reference\` VARCHAR(255) NULL,
          \`reviewed_by_user_id\` CHAR(36) BINARY NULL,
          \`reviewed_at\` DATETIME NULL,
          \`rejection_reason\` VARCHAR(500) NULL,
          \`organization_subscription_id\` CHAR(36) BINARY NULL,
          \`period_start\` DATE NULL,
          \`period_end\` DATE NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          KEY \`plan_payment_requests_tenant_id_status\` (\`tenant_id\`, \`status\`),
          KEY \`plan_payment_requests_status_created_at\` (\`status\`, \`created_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      return null;
    },
  },
  {
    version: 29,
    name: 'p029_access_devices',
    description:
      'ZKTeco Push devices, Phase 1 (docs/ZKTECO_PUSH_DEVICE_SYNC.md §6.1): access_devices (device key, bound serial, per-device RegistryCode and SessionID, status) and unclaimed_device_contacts (unknown serials and keys, 7-day rows). New tables only; the old router\'s `devices` / `device_members` are not touched. Safe to re-run.',
    // ROLLBACK (deploy the previous API build FIRST: it never reads these tables):
    //   DROP TABLE `access_devices`;  DROP TABLE `unclaimed_device_contacts`;  DELETE FROM `schema_migrations` WHERE `version` = 29;
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      // Routing happens before the tenant is known (spec §6), so this lives in the platform DB.
      // status: awaiting_connection → active (registered) ; disabled (host switched it off) ; removed (unpaired).
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`access_devices\` (
          \`id\` CHAR(36) BINARY NOT NULL,
          \`device_key\` CHAR(8) NOT NULL,
          \`serial_number\` VARCHAR(32) NULL,
          \`previous_serial_number\` VARCHAR(32) NULL,
          \`tenant_id\` CHAR(36) BINARY NOT NULL,
          \`business_id\` CHAR(36) BINARY NULL,
          \`branch_id\` CHAR(36) BINARY NOT NULL,
          \`link_mode\` VARCHAR(8) NOT NULL,
          \`comm_key\` VARCHAR(8) NULL,
          \`registry_code\` VARCHAR(32) NOT NULL,
          \`session_id\` VARCHAR(32) NOT NULL,
          \`token_mode\` VARCHAR(8) NOT NULL DEFAULT 'log',
          \`status\` VARCHAR(24) NOT NULL DEFAULT 'awaiting_connection',
          \`registered_at\` DATETIME NULL,
          \`last_seen_at\` DATETIME NULL,
          \`last_ip\` VARCHAR(45) NULL,
          \`last_pushver\` VARCHAR(16) NULL,
          \`last_host\` VARCHAR(255) NULL,
          \`last_scheme\` VARCHAR(8) NULL,
          \`last_token_state\` VARCHAR(16) NULL,
          \`serial_mismatch_at\` DATETIME NULL,
          \`serial_mismatch_value\` VARCHAR(32) NULL,
          \`created_by\` CHAR(36) BINARY NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`access_devices_device_key\` (\`device_key\`),
          UNIQUE KEY \`access_devices_serial_number\` (\`serial_number\`),
          KEY \`access_devices_tenant_branch\` (\`tenant_id\`, \`branch_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      // Unknown serials and keys (spec §4.2 rule 1), so support can help a host who mistyped.
      // One row per (serial, host, key, ip), written at most every 10 s, capped, 7-day expiry.
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`unclaimed_device_contacts\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`contact_hash\` CHAR(64) NOT NULL,
          \`serial_number\` VARCHAR(64) NULL,
          \`host\` VARCHAR(255) NULL,
          \`path_key\` VARCHAR(32) NULL,
          \`ip\` VARCHAR(45) NULL,
          \`reason\` VARCHAR(32) NOT NULL,
          \`first_seen_at\` DATETIME NOT NULL,
          \`last_seen_at\` DATETIME NOT NULL,
          \`hits\` INT UNSIGNED NOT NULL DEFAULT 1,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`unclaimed_device_contacts_contact_hash\` (\`contact_hash\`),
          KEY \`unclaimed_device_contacts_last_seen_at\` (\`last_seen_at\`),
          KEY \`unclaimed_device_contacts_serial_number\` (\`serial_number\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      return null;
    },
  },
  {
    version: 30,
    name: 'p030_access_devices_att',
    description:
      'ZKTeco Phase 5 (docs/ZKTECO_PUSH_DEVICE_SYNC.md §15 Phase 5): access_devices.device_type (acc | att, read before the tenant is known: an att device stays in token log mode) and cookie_seen_at (the last time the device sent a Cookie token; the enforce script refuses a device that never did). Columns only, nullable. Safe to re-run.',
    // ROLLBACK (deploy the previous API build FIRST: it never reads these columns):
    //   ALTER TABLE `access_devices` DROP COLUMN `device_type`, DROP COLUMN `cookie_seen_at`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 30;
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      const has = async (column) =>
        (await sequelize.query(
          'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'access_devices\' AND COLUMN_NAME = ?',
          { replacements: [column], type: QueryTypes.SELECT }
        )).length > 0;
      if (!(await has('device_type'))) await sequelize.query('ALTER TABLE `access_devices` ADD COLUMN `device_type` VARCHAR(8) NULL');
      if (!(await has('cookie_seen_at'))) await sequelize.query('ALTER TABLE `access_devices` ADD COLUMN `cookie_seen_at` DATETIME NULL');
      return null;
    },
  },
  {
    version: 31,
    name: 'p031_content_moderation',
    description:
      'NEW-256 (App Store 1.2, Google Play UGC): content_reports (a person reports a review or a chat message; platform admins act on it in the CMS), user_blocks (a traveller blocks a gym, or a gym blocks a traveller: messages refused both ways, the conversation hidden for the side that blocked), moderation_words (the word list checked on chat messages and reviews, editable in the CMS) with a short starter list. New tables and their seed rows only; nothing existing changes. Safe to re-run.',
    // PREVIEW: node src/scripts/run-platform-migrations.js --dry-run (lists p031, writes nothing).
    // BACKUP: none needed (new tables only; no existing row is read or changed).
    // ROLLBACK (deploy the previous API build FIRST: it never reads these tables):
    //   DROP TABLE `content_reports`; DROP TABLE `user_blocks`; DROP TABLE `moderation_words`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 31;
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`content_reports\` (
          \`id\` CHAR(36) BINARY NOT NULL,
          \`reporter_user_id\` CHAR(36) BINARY NOT NULL,
          \`target_type\` VARCHAR(16) NOT NULL,
          \`target_id\` CHAR(36) BINARY NOT NULL,
          \`target_user_id\` CHAR(36) BINARY NULL,
          \`conversation_id\` CHAR(36) BINARY NULL,
          \`tenant_id\` CHAR(36) BINARY NULL,
          \`reason\` VARCHAR(32) NOT NULL,
          \`note\` VARCHAR(500) NULL,
          \`snapshot_text\` TEXT NULL,
          \`status\` VARCHAR(16) NOT NULL DEFAULT 'OPEN',
          \`action\` VARCHAR(32) NULL,
          \`admin_note\` VARCHAR(500) NULL,
          \`handled_by_user_id\` CHAR(36) BINARY NULL,
          \`handled_at\` DATETIME NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`content_reports_reporter_target\` (\`reporter_user_id\`, \`target_type\`, \`target_id\`),
          KEY \`content_reports_status_created_at\` (\`status\`, \`created_at\`),
          KEY \`content_reports_target\` (\`target_type\`, \`target_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`user_blocks\` (
          \`id\` CHAR(36) BINARY NOT NULL,
          \`user_id\` CHAR(36) BINARY NOT NULL,
          \`tenant_id\` CHAR(36) BINARY NOT NULL,
          \`blocked_by\` VARCHAR(8) NOT NULL,
          \`created_by_user_id\` CHAR(36) BINARY NOT NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`user_blocks_pair_side\` (\`user_id\`, \`tenant_id\`, \`blocked_by\`),
          KEY \`user_blocks_tenant_id\` (\`tenant_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`moderation_words\` (
          \`id\` CHAR(36) BINARY NOT NULL,
          \`word\` VARCHAR(50) NOT NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`moderation_words_word\` (\`word\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      // Starter list (owner edits it in the CMS: Moderation › Word list). INSERT IGNORE keeps
      // whatever an admin already has; a re-run adds nothing twice.
      const { STARTER_WORDS } = require('../constants/moderation');
      const { v4: uuidv4 } = require('uuid');
      for (const word of STARTER_WORDS) {
        await sequelize.query(
          'INSERT IGNORE INTO `moderation_words` (`id`, `word`, `created_at`, `updated_at`) VALUES (?, ?, NOW(), NOW())',
          { replacements: [uuidv4(), word] }
        );
      }
      return null;
    },
  },
  {
    version: 32,
    name: 'p032_area_requests',
    description:
      'NEW-265 Part A (R-108, R-109): area_requests (a typed area or a Google road / landmark waiting for a platform admin), area_request_links (which tenant, draft first branch, listing or branch waits on it; one request per location), area_aliases (other spellings of an area, per city); areas.latitude / longitude / radius_m (set by an admin on approval); tenants and gym_listings area_status / area_request_id (the gym\'s own marker while an area is pending or rejected). New tables and nullable columns only; nothing existing is changed or back-filled. Safe to re-run.',
    // PREVIEW: node src/scripts/run-platform-migrations.js --dry-run (lists p032, writes nothing).
    // BACKUP: none needed (new tables and nullable columns only; no existing row is read or changed).
    //   All-or-nothing: every new column is checked first; one that someone added by hand with another
    //   type (or NOT NULL) skips the whole migration (not recorded, reported) and nothing is written.
    // DEPLOY: run it BEFORE the API build that reads these columns (the models select them).
    // ROLLBACK (deploy the previous API build FIRST: it never reads these tables or columns):
    //   DROP TABLE `area_aliases`; DROP TABLE `area_request_links`; DROP TABLE `area_requests`;
    //   ALTER TABLE `areas` DROP COLUMN `latitude`, DROP COLUMN `longitude`, DROP COLUMN `radius_m`;
    //   ALTER TABLE `tenants` DROP COLUMN `area_status`, DROP COLUMN `area_request_id`;
    //   ALTER TABLE `gym_listings` DROP COLUMN `area_status`, DROP COLUMN `area_request_id`;
    //   DELETE FROM `schema_migrations` WHERE `version` = 32;
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      const columns = [
        { table: 'areas', column: 'latitude', type: 'DECIMAL(10,8)', accept: ['decimal(10,8)'] },
        { table: 'areas', column: 'longitude', type: 'DECIMAL(11,8)', accept: ['decimal(11,8)'] },
        { table: 'areas', column: 'radius_m', type: 'INT', accept: ['int', 'int(11)'] },
        { table: 'organizations', column: 'area_status', type: 'VARCHAR(20)', accept: ['varchar(20)'] },
        { table: 'organizations', column: 'area_request_id', type: 'INT', accept: ['int', 'int(11)'] },
        // R-120: `gym_listings` until p033 renamed it; a database before p033 still has the old name.
        { table: 'business_listings', legacyTable: 'gym_listings', column: 'area_status', type: 'VARCHAR(20)', accept: ['varchar(20)'] },
        { table: 'business_listings', legacyTable: 'gym_listings', column: 'area_request_id', type: 'INT', accept: ['int', 'int(11)'] },
      ];
      const toAdd = [];
      for (const c of columns) {
        // A table this database does not have is left alone (same rule as the older migrations).
        let table = null;
        for (const name of [c.table, c.legacyTable].filter(Boolean)) {
          [table] = await sequelize.query(
            'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
            { replacements: [name], type: QueryTypes.SELECT }
          );
          if (table) { c.table = name; break; }
        }
        if (!table) continue;
        const [col] = await sequelize.query(
          'SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
          { replacements: [c.table, c.column], type: QueryTypes.SELECT }
        );
        if (!col) {
          toAdd.push(c);
        } else if (!c.accept.includes(String(col.type).toLowerCase()) || col.nullable !== 'YES') {
          console.warn(
            `[PlatformMigration] SKIPPING p032_area_requests: ${c.table}.${c.column} already exists as ${col.type} ` +
              `(nullable: ${col.nullable}); expected ${c.type} NULL. Resolve it by hand, then re-run.`
          );
          return { skipped: true, reason: 'column_exists_with_other_type', table: c.table, column: c.column, type: col.type };
        }
      }

      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`area_requests\` (
          \`id\` INT NOT NULL AUTO_INCREMENT,
          \`city_id\` INT NOT NULL,
          \`name\` VARCHAR(60) NOT NULL,
          \`name_key\` VARCHAR(60) NOT NULL,
          \`source\` ENUM('typed','google_road','google_landmark') NOT NULL DEFAULT 'typed',
          \`google_place_id\` VARCHAR(255) NULL,
          \`status\` ENUM('pending_review','approved','merged','rejected') NOT NULL DEFAULT 'pending_review',
          \`open_key\` VARCHAR(120) NULL,
          \`resolved_area_id\` INT NULL,
          \`requested_by_user_id\` CHAR(36) BINARY NOT NULL,
          \`reject_reason\` VARCHAR(300) NULL,
          \`decided_by\` CHAR(36) BINARY NULL,
          \`decided_at\` DATETIME NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`area_requests_open_key\` (\`open_key\`),
          KEY \`area_requests_city_id_status\` (\`city_id\`, \`status\`),
          KEY \`area_requests_requested_by_user_id_created_at\` (\`requested_by_user_id\`, \`created_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`area_request_links\` (
          \`id\` INT NOT NULL AUTO_INCREMENT,
          \`area_request_id\` INT NOT NULL,
          \`tenant_id\` CHAR(36) BINARY NOT NULL,
          \`target\` ENUM('tenant','main_branch','listing','branch') NOT NULL,
          \`target_id\` VARCHAR(36) NOT NULL,
          \`propagated_at\` DATETIME NULL,
          \`propagation_error\` VARCHAR(300) NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`area_request_links_target\` (\`target\`, \`tenant_id\`, \`target_id\`),
          KEY \`area_request_links_area_request_id\` (\`area_request_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`area_aliases\` (
          \`id\` INT NOT NULL AUTO_INCREMENT,
          \`city_id\` INT NOT NULL,
          \`alias_key\` VARCHAR(60) NOT NULL,
          \`area_id\` INT NOT NULL,
          \`created_by\` CHAR(36) BINARY NULL,
          \`created_at\` DATETIME NOT NULL,
          \`updated_at\` DATETIME NOT NULL,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`area_aliases_city_alias\` (\`city_id\`, \`alias_key\`),
          KEY \`area_aliases_area_id\` (\`area_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      for (const c of toAdd) {
        await sequelize.query(`ALTER TABLE \`${c.table}\` ADD COLUMN \`${c.column}\` ${c.type} NULL`);
      }
      return null;
    },
  },
  {
    version: 33,
    name: 'p033_business_naming',
    description:
      'R-120 NEW-306 (docs/NAMING_AND_DATA_DICTIONARY.md §3.6): business tables and columns get their names. gym_listings → business_listings (title → name, branch_id → primary_branch_id, short_description → description); saved_gyms → saved_businesses, gym_reviews → business_reviews, user_gym_memberships → member_subscription_index (gym_listing_id → business_id, gym_name → business_name); payout_accounts.organization_id, access_devices.organization_id, capacity_events.listing_id → business_id; platform_packages.max_organizations → max_businesses; capacity_events.action ORG_DELETED / ORG_BRANCHES_MOVED → BUSINESS_DELETED / BUSINESS_BRANCHES_MOVED. Indexes renamed; foreign keys follow. Metadata only except the two enum values. Safe to re-run.',
    // PREVIEW: node src/scripts/run-platform-migrations.js --dry-run (lists p033, writes nothing).
    // BACKUP: mysqldump of the platform database first (the enum step rewrites two values in capacity_events).
    // DEPLOY: run it BEFORE the API build that reads these names (the models select them).
    // CONFLICT: a table or column present under both names with data in both is reported (skipped, not
    //   recorded) and nothing more is changed for that step; every other step is idempotent, so re-run.
    // ROLLBACK (deploy the previous API build FIRST): the reverse RENAME TABLE / CHANGE COLUMN / RENAME INDEX
    //   of every step below, the enum values back, then DELETE FROM `schema_migrations` WHERE `version` = 33;
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      const r = require('./rename-helpers');
      const col = (table, from, to, comment) => [r.renameColumn, { table, from, to, comment }];
      // R-120 NEW-309: `organization_id` meant the business on these two tables until this step. A database built from the models
      // already has `organization_id` for the ORGANIZATION (renamed from tenant_id by p035), so the rename only runs on a table that
      // still has `tenant_id` (the old shape).
      const oldShape = (table, _t, from, to, comment) => [async (seq, args) => ((await r.columnInfo(seq, table, 'tenant_id')) ? r.renameColumn(seq, args) : { statements: [] }), { table, from, to, comment }];
      const idx = (table, from, to) => [r.renameIndex, { table, from, to }];
      const out = await r.applyAll(sequelize, [
        [r.renameTable, { from: 'gym_listings', to: 'business_listings', comment: 'One row per business: its public, traveller-facing half (name, photos, area, approval, reserved branch units). Same id as the tenant businesses row.' }],
        [r.renameTable, { from: 'saved_gyms', to: 'saved_businesses', comment: 'A business a traveller saved.' }],
        [r.renameTable, { from: 'gym_reviews', to: 'business_reviews', comment: 'A traveller review of a business (optionally one branch), moderated by platform admins.' }],
        [r.renameTable, { from: 'user_gym_memberships', to: 'member_subscription_index', comment: 'Index of a member\'s subscriptions across tenant databases; the real record is the tenant member_subscriptions row.' }],
        col('business_listings', 'title', 'name', 'Business name shown to travellers. Same value as businesses.name.'),
        col('business_listings', 'branch_id', 'primary_branch_id', 'Primary branch of the business (tenant branches.id), for the card and chat; NULL until a branch exists.'),
        col('business_listings', 'short_description', 'description', 'Business description shown to travellers.'),
        idx('business_listings', 'gym_listings_city_id_area_id_status', 'business_listings_city_id_area_id_status'),
        idx('business_listings', 'gym_listings_tenant_id', 'business_listings_tenant_id'),
        idx('business_listings', 'gym_listings_is_featured', 'business_listings_is_featured'),
        idx('business_listings', 'gym_listings_gender_type', 'business_listings_gender_type'),
        col('saved_businesses', 'gym_listing_id', 'business_id', 'The business saved.'),
        idx('saved_businesses', 'saved_gyms_user_id_gym_listing_id', 'saved_businesses_user_id_business_id'),
        idx('saved_businesses', 'saved_gyms_user_id', 'saved_businesses_user_id'),
        col('business_reviews', 'gym_listing_id', 'business_id', 'The business reviewed.'),
        idx('business_reviews', 'gym_reviews_gym_listing_id_status', 'business_reviews_business_id_status'),
        idx('business_reviews', 'gym_reviews_branch_id_status', 'business_reviews_branch_id_status'),
        idx('business_reviews', 'gym_reviews_user_id', 'business_reviews_user_id'),
        idx('business_reviews', 'gym_reviews_branch_user_unique', 'business_reviews_branch_user_unique'),
        col('member_subscription_index', 'gym_listing_id', 'business_id', 'The business, for display without opening the tenant database.'),
        col('member_subscription_index', 'gym_name', 'business_name', 'Business name at subscription time (copy).'),
        idx('member_subscription_index', 'user_gym_memberships_user_id_status', 'member_subscription_index_user_id_status'),
        idx('member_subscription_index', 'user_gym_memberships_tenant_id', 'member_subscription_index_tenant_id'),
        idx('member_subscription_index', 'user_gym_memberships_subscription_id', 'member_subscription_index_subscription_id'),
        idx('member_subscription_index', 'user_gym_memberships_gym_listing_id', 'member_subscription_index_business_id'),
        oldShape('payout_accounts', 'payout_accounts', 'organization_id', 'business_id', 'The business this account is for; NULL = organization-wide.'),
        idx('payout_accounts', 'payout_accounts_organization_id', 'payout_accounts_business_id'),
        oldShape('access_devices', 'access_devices', 'organization_id', 'business_id', 'The business of the device\'s branch.'),
        col('capacity_events', 'listing_id', 'business_id', 'The business whose reserved_slots changed; NULL for organization-wide events.'),
        idx('capacity_events', 'capacity_events_listing_id', 'capacity_events_business_id'),
        col('platform_packages', 'max_organizations', 'max_businesses', 'Businesses allowed on this legacy package.'),
        [r.renameEnumValues, {
          table: 'capacity_events',
          column: 'action',
          rename: { ORG_DELETED: 'BUSINESS_DELETED', ORG_BRANCHES_MOVED: 'BUSINESS_BRANCHES_MOVED' },
          values: [
            'BRANCH_DELETED', 'BRANCH_RESTORED', 'SLOT_TRANSFERRED', 'SLOT_TRIMMED_DOWNGRADE', 'SLOT_ATTRIBUTED_UPGRADE',
            'SLOT_CONSUMED_BUILD', 'BUSINESS_DELETED', 'BUSINESS_BRANCHES_MOVED', 'BRANCH_BILLING_LOCKED', 'BRANCH_BILLING_UNLOCKED',
          ],
        }],
      ]);
      if (out.skipped.length) {
        console.warn(`[PlatformMigration] SKIPPING p033_business_naming (not recorded): ${JSON.stringify(out.skipped)}. Resolve by hand, then re-run.`);
        return { skipped: true, reason: 'rename_conflict', conflicts: out.skipped };
      }
      return null;
    },
  },
  {
    version: 34,
    name: 'p034_organization_naming',
    description:
      'R-120 NEW-307 (docs/NAMING_AND_DATA_DICTIONARY.md §3.6): organization tables and columns get their names. tenants → organizations (tenant_code → organization_code, business_name → organization_name, gym_name → first_business_name, gym_description → first_business_description, main_branch_data_json → first_branch_draft_json); tenant_subscriptions → organization_subscriptions; tenant_invitations → organization_invitations (business_name → organization_name); user_org_index → user_organization_index; plan_payment_requests / platform_invoices tenant_subscription_id → organization_subscription_id; area_request_links.target tenant / main_branch / listing → organization / first_branch_draft / business; user_blocks.blocked_by TENANT → ORGANIZATION (column widened to 16, F6); payout_accounts.scope_key TENANT → ORGANIZATION. Indexes renamed; foreign keys follow. tenant_id columns are renamed by p035 (NEW-311). Safe to re-run.',
    // PREVIEW: node src/scripts/run-platform-migrations.js --dry-run (lists p034, writes nothing).
    // BACKUP: mysqldump of the platform database first (three value renames: area_request_links.target, user_blocks.blocked_by, payout_accounts.scope_key).
    // DEPLOY: after p033, BEFORE the API build that reads these names. The launch-wipe tools read either name.
    // CONFLICT: a table or column present under both names with data in both is reported (skipped, not recorded); re-run after fixing.
    // ROLLBACK (deploy the previous API build FIRST): the reverse RENAME TABLE / CHANGE COLUMN / RENAME INDEX of every
    //   step below, the three value renames back, then DELETE FROM `schema_migrations` WHERE `version` = 34;
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      const r = require('./rename-helpers');
      const col = (table, from, to, comment) => [r.renameColumn, { table, from, to, comment }];
      const idx = (table, from, to) => [r.renameIndex, { table, from, to }];
      const out = await r.applyAll(sequelize, [
        [r.renameTable, { from: 'tenants', to: 'organizations', comment: 'One row per organization: the host company that owns businesses and pays the plan; also the Become a Host draft and the name of its tenant database.' }],
        [r.renameTable, { from: 'tenant_subscriptions', to: 'organization_subscriptions', comment: 'The organization\'s GymsEra plans (store, Stripe or manual); at most one entitling row (ACTIVE or GRACE); branch_count is the capacity.' }],
        [r.renameTable, { from: 'tenant_invitations', to: 'organization_invitations', comment: 'An invitation from a platform admin to a new host to create an organization.' }],
        [r.renameTable, { from: 'user_org_index', to: 'user_organization_index', comment: 'Routing index: which organizations a user holds a role in; never an authorization source.' }],
        col('organizations', 'tenant_code', 'organization_code', 'Short human code of the organization (ORG-xxxxxxxx), unique.'),
        col('organizations', 'business_name', 'organization_name', 'The organization\'s own name; private (host Profile and CMS only).'),
        col('organizations', 'gym_name', 'first_business_name', 'Become a Host draft: name of the first business; copied at provisioning.'),
        col('organizations', 'gym_description', 'first_business_description', 'Become a Host draft: description of the first business; copied at provisioning.'),
        col('organizations', 'main_branch_data_json', 'first_branch_draft_json', 'Become a Host draft of the first branch; built at provisioning.'),
        idx('organizations', 'tenants_tenant_code_unique', 'organizations_organization_code_unique'),
        idx('organizations', 'tenants_owner_user_id', 'organizations_owner_user_id'),
        idx('organizations', 'tenants_status', 'organizations_status'),
        idx('organizations', 'tenants_city_id', 'organizations_city_id'),
        col('organization_invitations', 'business_name', 'organization_name', 'Organization name proposed in the invitation.'),
        idx('organization_invitations', 'tenant_invitations_token_hash', 'organization_invitations_token_hash'),
        idx('organization_invitations', 'tenant_invitations_owner_email', 'organization_invitations_owner_email'),
        idx('organization_invitations', 'tenant_invitations_status', 'organization_invitations_status'),
        idx('organization_invitations', 'idx_tenant_invitations_token_hash', 'organization_invitations_token_hash'),
        idx('organization_invitations', 'idx_tenant_invitations_owner_email', 'organization_invitations_owner_email'),
        idx('organization_invitations', 'idx_tenant_invitations_status', 'organization_invitations_status'),
        idx('organization_subscriptions', 'tenant_subscriptions_tenant_id', 'organization_subscriptions_tenant_id'),
        idx('organization_subscriptions', 'tenant_subscriptions_status', 'organization_subscriptions_status'),
        idx('organization_subscriptions', 'tenant_subscriptions_end_date', 'organization_subscriptions_end_date'),
        idx('organization_subscriptions', 'tenant_subscriptions_external_original_transaction_id', 'organization_subscriptions_external_original_transaction_id'),
        idx('organization_subscriptions', 'tenant_subscriptions_platform_external_unique', 'organization_subscriptions_platform_external_unique'),
        col('plan_payment_requests', 'tenant_subscription_id', 'organization_subscription_id', 'Subscription created when the request was approved.'),
        col('platform_invoices', 'tenant_subscription_id', 'organization_subscription_id', 'The plan this invoice is for.'),
        idx('platform_invoices', 'platform_invoices_tenant_subscription_id', 'platform_invoices_organization_subscription_id'),
        idx('user_organization_index', 'user_org_index_user_id_status', 'user_organization_index_user_id_status'),
        idx('user_organization_index', 'user_org_index_tenant_id_status', 'user_organization_index_tenant_id_status'),
        [r.renameEnumValues, {
          table: 'area_request_links',
          column: 'target',
          rename: { tenant: 'organization', main_branch: 'first_branch_draft', listing: 'business' },
          values: ['organization', 'first_branch_draft', 'business', 'branch'],
        }],
        [r.widenVarchar, { table: 'user_blocks', column: 'blocked_by', length: 16 }],
        [r.renameStringValues, { table: 'user_blocks', column: 'blocked_by', rename: { TENANT: 'ORGANIZATION' } }],
        [r.renameStringValues, { table: 'payout_accounts', column: 'scope_key', rename: { TENANT: 'ORGANIZATION' } }],
      ]);
      if (out.skipped.length) {
        console.warn(`[PlatformMigration] SKIPPING p034_organization_naming (not recorded): ${JSON.stringify(out.skipped)}. Resolve by hand, then re-run.`);
        return { skipped: true, reason: 'rename_conflict', conflicts: out.skipped };
      }
      return null;
    },
  },
  {
    version: 35,
    name: 'p035_organization_id_columns',
    description:
      'R-120 NEW-309 (docs/NAMING_AND_DATA_DICTIONARY.md B2): tenant_id is organization_id in every platform table that holds the organization foreign key; the indexes that carried tenant in their name follow. Metadata-only CHANGE COLUMN / RENAME INDEX, the definition is kept.',
    // PREVIEW: node src/scripts/run-platform-migrations.js --dry-run. BACKUP: mysqldump of the platform database first.
    // DEPLOY: after p034, BEFORE the API build that reads organization_id.
    // ROLLBACK (previous API build FIRST): the reverse CHANGE COLUMN / RENAME INDEX of every step, then DELETE FROM `schema_migrations` WHERE `version` = 35.
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      const r = require('./rename-helpers');
      const tables = [
        'area_request_links', 'audit_logs', 'billing_events', 'capacity_events', 'content_reports', 'conversations',
        'devices', 'device_members', 'business_listings', 'business_reviews', 'payout_accounts', 'plan_payment_requests',
        'platform_invoices', 'organization_invitations', 'organization_subscriptions', 'user_blocks',
        'member_subscription_index', 'user_organization_index', 'access_devices',
      ];
      const steps = tables.map((table) => [r.renameColumn, { table, from: 'tenant_id', to: 'organization_id', comment: 'The organization (organizations.id).' }]);
      const idx = (table, from, to) => [r.renameIndex, { table, from, to }];
      steps.push(
        idx('organization_subscriptions', 'organization_subscriptions_tenant_id', 'organization_subscriptions_organization_id'),
        idx('platform_invoices', 'platform_invoices_tenant_id', 'platform_invoices_organization_id'),
        idx('business_listings', 'business_listings_tenant_id', 'business_listings_organization_id'),
        idx('member_subscription_index', 'member_subscription_index_tenant_id', 'member_subscription_index_organization_id'),
        idx('devices', 'devices_tenant_id', 'devices_organization_id'),
        idx('device_members', 'device_members_tenant_id', 'device_members_organization_id'),
        idx('conversations', 'conversations_tenant_id', 'conversations_organization_id'),
        idx('user_organization_index', 'user_organization_index_tenant_id_status', 'user_organization_index_organization_id_status'),
        idx('capacity_events', 'capacity_events_tenant_id', 'capacity_events_organization_id'),
        idx('billing_events', 'billing_events_tenant_status', 'billing_events_organization_status'),
        idx('audit_logs', 'audit_logs_tenant_id', 'audit_logs_organization_id'),
        idx('payout_accounts', 'payout_accounts_tenant_scope_provider', 'payout_accounts_organization_scope_provider'),
        idx('plan_payment_requests', 'plan_payment_requests_tenant_id_status', 'plan_payment_requests_organization_id_status'),
        idx('user_blocks', 'user_blocks_tenant_id', 'user_blocks_organization_id'),
      );
      const out = await r.applyAll(sequelize, steps);
      if (out.skipped.length) {
        console.warn(`[PlatformMigration] SKIPPING p035_organization_id_columns (not recorded): ${JSON.stringify(out.skipped)}. Resolve by hand, then re-run.`);
        return { skipped: true, reason: 'rename_conflict', conflicts: out.skipped };
      }
      return null;
    },
  },
  {
    version: 36,
    name: 'p036_member_index_branch_id',
    description:
      'R-120 NEW-309 (API contract v2 A3 J3): member_subscription_index.branch_id, the branch of the subscription, written with the row. No backfill (R-120): rows made before it keep NULL.',
    // ROLLBACK: ALTER TABLE `member_subscription_index` DROP COLUMN `branch_id`; DELETE FROM `schema_migrations` WHERE `version` = 36.
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      const r = require('./rename-helpers');
      if (!(await r.tableExists(sequelize, 'member_subscription_index'))) return null;
      if (!(await r.columnInfo(sequelize, 'member_subscription_index', 'branch_id'))) {
        await sequelize.query('ALTER TABLE `member_subscription_index` ADD COLUMN `branch_id` CHAR(36) BINARY NULL COMMENT \'The branch of the subscription.\', ALGORITHM=INPLACE, LOCK=NONE');
      }
      return null;
    },
  },
  {
    version: 37,
    name: 'p037_held_first_branch',
    description: 'NEW-303 M1: hold the submitted first branch on a business until approval.',
    // ROLLBACK: after reverting the API, ALTER TABLE `business_listings` DROP COLUMN `first_branch_draft_json`;
    // DELETE FROM `schema_migrations` WHERE `version` = 37.
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      const r = require('./rename-helpers');
      if (!(await r.tableExists(sequelize, 'business_listings'))) return null;
      if (!(await r.columnInfo(sequelize, 'business_listings', 'first_branch_draft_json'))) {
        await sequelize.query('ALTER TABLE `business_listings` ADD COLUMN `first_branch_draft_json` JSON NULL COMMENT \'Submitted first branch, built only after business approval.\', ALGORITHM=INPLACE, LOCK=NONE');
      }
      return null;
    },
  },
  {
    version: 38,
    name: 'p038_business_kyc_verification',
    description: 'NEW-303 M2: business KYC, approval and verified-badge columns on business_listings. No backfill (R-120).',
    // ROLLBACK: after reverting the API, drop the seven columns below and delete schema_migrations version 38.
    up: async (sequelize, context = {}) => {
      if (context?.dryRun === true) return null;
      const r = require('./rename-helpers');
      if (!(await r.tableExists(sequelize, 'business_listings'))) return null;
      const columns = [
        ['kyc_status', "ENUM('NOT_SUBMITTED','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'NOT_SUBMITTED'"],
        ['kyc_documents_json', 'JSON NULL'],
        ['kyc_submitted_at', 'DATETIME NULL'],
        ['approved_at', 'DATETIME NULL'],
        ['approved_by', 'CHAR(36) BINARY NULL'],
        ['verified_at', 'DATETIME NULL'],
        ['verified_by', 'CHAR(36) BINARY NULL'],
      ];
      for (const [column, definition] of columns) {
        if (!(await r.columnInfo(sequelize, 'business_listings', column))) {
          await sequelize.query(`ALTER TABLE \`business_listings\` ADD COLUMN \`${column}\` ${definition}, ALGORITHM=INPLACE, LOCK=NONE`);
        }
      }
      return null;
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
    organizationId: 'platform',
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
