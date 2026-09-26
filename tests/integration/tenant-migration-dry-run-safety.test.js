/**
 * Integration Test: Tenant Migration Dry-Run Safety & Migration 004 Audit
 *
 * Verifies:
 * 1. (Point 2) Zero-write dry-run:
 *    - Seeding a tenant DB at schema v0 with realistic data (branches, gyms, payments with wrong-but-non-null business_date).
 *    - Calling runTenantMigrations with dryRun: true.
 *    - Asserting:
 *      (a) schema_migrations has NO new rows / version is unchanged (0).
 *      (b) payment's business_date is byte-for-byte unchanged.
 *      (c) NO row in any table changed at all (full snapshot before vs after).
 *      (d) runner returns applied: [] and finalVersion: initialVersion.
 * 2. (Point 4) Migration 004 non-null business_date isolation:
 *    - Running live (non-dry-run) Migration 004 leaves existing non-null business_date completely untouched.
 *    - Only rows with business_date IS NULL are backfilled.
 */
const { Sequelize, QueryTypes } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
  createMixedCollationTenantDb,
} = require('../harness');
const {
  runTenantMigrations,
  TARGET_SCHEMA_VERSION,
  MIGRATIONS,
} = require('../../src/database/tenant-migration-runner');

describe('P0: Tenant Migration Dry-Run Safety & Migration 004 Isolation', () => {
  let dbHarness;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  /**
   * Helper to capture a full database snapshot (tables, counts, and row contents)
   */
  async function captureDbSnapshot(sequelize) {
    const [tables] = await sequelize.query(`
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME ASC
    `);

    const tableNames = tables.map((t) => t.TABLE_NAME);
    const snapshot = {
      tables: tableNames,
      tableCounts: {},
      tableData: {},
    };

    for (const tbl of tableNames) {
      const rows = await sequelize.query(`SELECT * FROM \`${tbl}\``, {
        type: QueryTypes.SELECT,
      });
      snapshot.tableCounts[tbl] = rows.length;
      snapshot.tableData[tbl] = JSON.parse(JSON.stringify(rows));
    }

    return snapshot;
  }

  test('Point 2: --dry-run on schema v0 performs ZERO writes, does not advance version, leaves payment untouched, and snapshot is identical', async () => {
    const fixture = await createMixedCollationTenantDb('gymsera_test_dryrun_v0');
    const seq = fixture.sequelize;

    // Reset database to schema v0 (no schema_migrations, base schema with branches, gyms, payments)
    await seq.query('SET FOREIGN_KEY_CHECKS = 0');
    await seq.query('DROP TABLE IF EXISTS schema_migrations');
    await seq.query('DROP TABLE IF EXISTS payments');
    await seq.query('DROP TABLE IF EXISTS branches');
    await seq.query('DROP TABLE IF EXISTS gyms');

    // Create v0 schema
    await seq.query(`
      CREATE TABLE \`branches\` (
        \`id\` VARCHAR(36) NOT NULL PRIMARY KEY,
        \`gym_id\` VARCHAR(36) NULL,
        \`branch_name\` VARCHAR(255) NOT NULL,
        \`timezone\` VARCHAR(50) NOT NULL DEFAULT 'Asia/Karachi',
        \`status\` VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
        \`created_at\` DATETIME NOT NULL DEFAULT '2025-12-01 10:00:00',
        \`updated_at\` DATETIME NOT NULL DEFAULT '2025-12-01 10:00:00'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await seq.query(`
      CREATE TABLE \`gyms\` (
        \`id\` VARCHAR(36) NOT NULL PRIMARY KEY,
        \`name\` VARCHAR(255) NOT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT '2025-12-01 10:00:00',
        \`updated_at\` DATETIME NOT NULL DEFAULT '2025-12-01 10:00:00'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await seq.query(`
      CREATE TABLE \`payments\` (
        \`id\` VARCHAR(36) NOT NULL PRIMARY KEY,
        \`branch_id\` VARCHAR(36) NULL,
        \`amount\` DECIMAL(10,2) NOT NULL DEFAULT 1000.00,
        \`currency\` VARCHAR(10) NOT NULL DEFAULT 'PKR',
        \`method\` VARCHAR(50) NOT NULL DEFAULT 'CASH',
        \`status\` VARCHAR(50) NOT NULL DEFAULT 'COMPLETED',
        \`business_date\` DATE NULL,
        \`collected_at\` DATETIME NULL,
        \`paid_at\` DATETIME NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT '2025-12-29 21:09:00',
        \`updated_at\` DATETIME NOT NULL DEFAULT '2025-12-29 21:09:00'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await seq.query('SET FOREIGN_KEY_CHECKS = 1');

    // Seed realistic data
    const branchId = '11111111-1111-1111-1111-111111111111';
    const gymId = '22222222-2222-2222-2222-222222222222';
    const paymentWrongDateId = '33333333-3333-3333-3333-333333333333';
    const paymentNullDateId = '44444444-4444-4444-4444-444444444444';

    await seq.query(`
      INSERT INTO gyms (id, name, created_at, updated_at)
      VALUES ('${gymId}', 'Alpha Fitness', '2025-12-01 10:00:00', '2025-12-01 10:00:00')
    `);

    await seq.query(`
      INSERT INTO branches (id, gym_id, branch_name, timezone, status, created_at, updated_at)
      VALUES ('${branchId}', '${gymId}', 'Main Branch', 'Asia/Karachi', 'ACTIVE', '2025-12-01 10:00:00', '2025-12-01 10:00:00')
    `);

    // Payment with WRONG-but-non-null business_date (e.g. 2025-12-29 instead of 2025-12-30)
    await seq.query(`
      INSERT INTO payments (id, branch_id, amount, currency, method, status, business_date, collected_at, paid_at, created_at, updated_at)
      VALUES ('${paymentWrongDateId}', '${branchId}', 2500.00, 'PKR', 'CASH', 'COMPLETED', '2025-12-29', NULL, '2025-12-29 21:09:00', '2026-05-25 20:10:00', '2026-05-25 20:10:00')
    `);

    // Payment with NULL business_date
    await seq.query(`
      INSERT INTO payments (id, branch_id, amount, currency, method, status, business_date, collected_at, paid_at, created_at, updated_at)
      VALUES ('${paymentNullDateId}', '${branchId}', 1500.00, 'PKR', 'CASH', 'COMPLETED', NULL, NULL, '2025-12-29 21:09:00', '2026-05-25 20:10:00', '2026-05-25 20:10:00')
    `);

    // Capture BEFORE snapshot
    const beforeSnapshot = await captureDbSnapshot(seq);

    // Call runner in DRY-RUN mode
    const dryRunResult = await runTenantMigrations(seq, {
      tenantId: 'dryrun-test-tenant',
      tenantCode: 'DRYRUN',
      gymName: 'Alpha Fitness',
      dryRun: true,
    });

    // Capture AFTER snapshot
    const afterSnapshot = await captureDbSnapshot(seq);

    // Assert runner result reporting
    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.initialVersion).toBe(0);
    expect(dryRunResult.finalVersion).toBe(0); // Version did NOT advance!
    expect(dryRunResult.applied).toEqual([]); // 0 migrations applied!
    expect(dryRunResult.wouldRun).toHaveLength(TARGET_SCHEMA_VERSION);

    // (a) schema_migrations has NO new row / version is unchanged
    const [migTables] = await seq.query("SHOW TABLES LIKE 'schema_migrations'");
    if (migTables && migTables.length > 0) {
      const rows = await seq.query('SELECT * FROM schema_migrations', { type: QueryTypes.SELECT });
      expect(rows).toHaveLength(0);
    } else {
      expect(migTables.length).toBe(0);
    }

    // (b) Payment's business_date is byte-for-byte unchanged ('2025-12-29')
    const [pWrongAfter] = await seq.query('SELECT * FROM payments WHERE id = ?', {
      replacements: [paymentWrongDateId],
      type: QueryTypes.SELECT,
    });
    expect(pWrongAfter.business_date).toBe('2025-12-29');

    // (c) NO row in any table changed at all (full snapshot before vs after comparison)
    expect(afterSnapshot.tables).toEqual(beforeSnapshot.tables);
    expect(afterSnapshot.tableCounts).toEqual(beforeSnapshot.tableCounts);
    expect(afterSnapshot.tableData).toEqual(beforeSnapshot.tableData);
  });

  test('Point 4: Live Migration 004 strictly filters to business_date IS NULL and NEVER overwrites non-null rows', async () => {
    const fixture = await createMixedCollationTenantDb('gymsera_test_mig004_isolation');
    const seq = fixture.sequelize;

    // Reset database up to schema v3
    await seq.query('SET FOREIGN_KEY_CHECKS = 0');
    await seq.query('DROP TABLE IF EXISTS schema_migrations');
    await seq.query('DROP TABLE IF EXISTS payments');
    await seq.query('DROP TABLE IF EXISTS branches');
    await seq.query('DROP TABLE IF EXISTS gyms');

    await seq.query(`
      CREATE TABLE \`branches\` (
        \`id\` VARCHAR(36) NOT NULL PRIMARY KEY,
        \`branch_name\` VARCHAR(255) NOT NULL,
        \`timezone\` VARCHAR(50) NOT NULL DEFAULT 'Asia/Karachi',
        \`status\` VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await seq.query(`
      CREATE TABLE \`payments\` (
        \`id\` VARCHAR(36) NOT NULL PRIMARY KEY,
        \`branch_id\` VARCHAR(36) NULL,
        \`amount\` DECIMAL(10,2) NOT NULL DEFAULT 1000.00,
        \`currency\` VARCHAR(10) NOT NULL DEFAULT 'PKR',
        \`method\` VARCHAR(50) NOT NULL DEFAULT 'CASH',
        \`status\` VARCHAR(50) NOT NULL DEFAULT 'COMPLETED',
        \`business_date\` DATE NULL,
        \`collected_at\` DATETIME NULL,
        \`paid_at\` DATETIME NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT '2025-12-29 21:09:00',
        \`updated_at\` DATETIME NOT NULL DEFAULT '2025-12-29 21:09:00'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Create schema_migrations table with versions 1, 2, 3
    await seq.query(`
      CREATE TABLE \`schema_migrations\` (
        \`version\` INT NOT NULL PRIMARY KEY,
        \`name\` VARCHAR(191) NOT NULL,
        \`applied_at\` DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    await seq.query("INSERT INTO schema_migrations VALUES (1, '001_ensure_rbac_tables', NOW())");
    await seq.query("INSERT INTO schema_migrations VALUES (2, '002_ensure_ledger_tables', NOW())");
    await seq.query("INSERT INTO schema_migrations VALUES (3, '003_audit_and_tracking_columns', NOW())");

    await seq.query('SET FOREIGN_KEY_CHECKS = 1');

    const branchId = 'branch-004-test';
    await seq.query(`
      INSERT INTO branches (id, branch_name, timezone, status)
      VALUES ('${branchId}', 'Isolation Branch', 'Asia/Karachi', 'ACTIVE')
    `);

    // 1. Payment with an EXISTING WRONG non-null business_date ('2025-12-29')
    const paymentWrongNonNullableId = 'pay-wrong-nonnull-1';
    await seq.query(`
      INSERT INTO payments (id, branch_id, amount, currency, method, status, business_date, collected_at, paid_at, created_at, updated_at)
      VALUES ('${paymentWrongNonNullableId}', '${branchId}', 2500.00, 'PKR', 'CASH', 'COMPLETED', '2025-12-29', NULL, '2025-12-29 21:09:00', '2026-05-25 20:10:00', '2026-05-25 20:10:00')
    `);

    // 2. Payment with an EXISTING CORRECT non-null business_date ('2026-01-15')
    const paymentCorrectNonNullableId = 'pay-correct-nonnull-2';
    await seq.query(`
      INSERT INTO payments (id, branch_id, amount, currency, method, status, business_date, collected_at, paid_at, created_at, updated_at)
      VALUES ('${paymentCorrectNonNullableId}', '${branchId}', 3000.00, 'PKR', 'BANK_TRANSFER', 'COMPLETED', '2026-01-15', NULL, '2026-01-15 10:00:00', '2026-01-15 10:00:00', '2026-01-15 10:00:00')
    `);

    // 3. Payment with NULL business_date (MUST be backfilled)
    const paymentNullId = 'pay-null-needs-backfill-3';
    await seq.query(`
      INSERT INTO payments (id, branch_id, amount, currency, method, status, business_date, collected_at, paid_at, created_at, updated_at)
      VALUES ('${paymentNullId}', '${branchId}', 1200.00, 'PKR', 'CASH', 'COMPLETED', NULL, NULL, '2025-12-29 21:09:00', '2026-05-25 20:10:00', '2026-05-25 20:10:00')
    `);

    // Run LIVE Migration up to v4 (non-dry-run)
    const runResult = await runTenantMigrations(seq, {
      tenantId: 'mig004-test-tenant',
      targetVersion: 4,
      dryRun: false,
    });

    expect(runResult.finalVersion).toBe(4);
    expect(runResult.applied).toContain('004_backfill_payments_business_date');

    // Assert: The wrong-but-non-null row is 100% UNTOUCHED
    const [pWrong] = await seq.query('SELECT * FROM payments WHERE id = ?', {
      replacements: [paymentWrongNonNullableId],
      type: QueryTypes.SELECT,
    });
    expect(pWrong.business_date).toBe('2025-12-29');

    // Assert: The correct non-null row is 100% UNTOUCHED
    const [pCorrect] = await seq.query('SELECT * FROM payments WHERE id = ?', {
      replacements: [paymentCorrectNonNullableId],
      type: QueryTypes.SELECT,
    });
    expect(pCorrect.business_date).toBe('2026-01-15');

    // Assert: ONLY the NULL row was backfilled to 2025-12-30 (Asia/Karachi date of 2025-12-29 21:09:00Z)
    const [pBackfilled] = await seq.query('SELECT * FROM payments WHERE id = ?', {
      replacements: [paymentNullId],
      type: QueryTypes.SELECT,
    });
    expect(pBackfilled.business_date).toBe('2025-12-30');
  });

  test('Defense-in-depth: individual migrations (001-007) check context.dryRun and perform zero writes when invoked directly', async () => {
    const fixture = await createMixedCollationTenantDb('gymsera_test_direct_dryrun');
    const seq = fixture.sequelize;

    // Reset database to empty
    await seq.query('SET FOREIGN_KEY_CHECKS = 0');
    await seq.query('DROP TABLE IF EXISTS schema_migrations');
    await seq.query('DROP TABLE IF EXISTS payments');
    await seq.query('DROP TABLE IF EXISTS branches');
    await seq.query('DROP TABLE IF EXISTS gyms');
    await seq.query('SET FOREIGN_KEY_CHECKS = 1');

    const beforeSnapshot = await captureDbSnapshot(seq);

    // Call each migration up() directly with context.dryRun = true
    for (const mig of MIGRATIONS) {
      await mig.up(seq, { tenantId: 'direct-dryrun-tenant', dryRun: true });
    }

    const afterSnapshot = await captureDbSnapshot(seq);

    // Database is completely unchanged
    expect(afterSnapshot.tables).toEqual(beforeSnapshot.tables);
    expect(afterSnapshot.tableCounts).toEqual(beforeSnapshot.tableCounts);
    expect(afterSnapshot.tableData).toEqual(beforeSnapshot.tableData);
  });
});

