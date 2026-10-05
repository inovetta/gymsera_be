const { QueryTypes } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
} = require('../harness');
const {
  runTenantMigrations,
} = require('../../src/database/tenant-migration-runner');

describe('Tenant Migration 016 (add payment shift and ledger closed collectors) Integration Tests (Rule 5)', () => {
  let dbHarness;
  let tenantSeq;
  const M016 = '016_add_payment_shift_and_ledger_closed_collectors';

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenantSeq = dbHarness.tenant2.sequelize;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('--dry-run preview writes nothing to tenant database', async () => {
    // Reset tenant2 to version 15
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version >= 16').catch(() => {});
    await tenantSeq.query('ALTER TABLE `payments` DROP COLUMN `shift`').catch(() => {});
    await tenantSeq.query('ALTER TABLE `ledger_days` DROP COLUMN `closed_collectors_json`').catch(() => {});

    const [colBefore] = await tenantSeq.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'shift'",
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(colBefore).toBeUndefined();

    const res = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      dryRun: true,
      targetVersion: 16,
    });

    expect(res.dryRun).toBe(true);
    expect(res.wouldRun).toContain(M016);

    // Verify columns were NOT created during dry-run
    const [colAfter] = await tenantSeq.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'shift'",
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(colAfter).toBeUndefined();

    // Verify schema_migrations does not have version 16
    const [row] = await tenantSeq.query(
      'SELECT version FROM schema_migrations WHERE version = 16',
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(row).toBeUndefined();
  });

  test('016 skips cleanly when payments.shift exists with conflicting schema (conflicting-data skip test)', async () => {
    // Ensure column exists as INT (conflicting type)
    await tenantSeq.query('ALTER TABLE `payments` DROP COLUMN `shift`').catch(() => {});
    await tenantSeq.query('ALTER TABLE `payments` ADD COLUMN `shift` INT NULL').catch(() => {});
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version = 16').catch(() => {});

    const res = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 16,
    });

    expect(res.applied).not.toContain(M016);

    const [row] = await tenantSeq.query(
      'SELECT version FROM schema_migrations WHERE version = 16',
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(row).toBeUndefined();

    // Clean up conflicting column
    await tenantSeq.query('ALTER TABLE `payments` DROP COLUMN `shift`').catch(() => {});
  });

  test('016 applies successfully and is idempotent', async () => {
    await tenantSeq.query('ALTER TABLE `payments` DROP COLUMN `shift`').catch(() => {});
    await tenantSeq.query('ALTER TABLE `ledger_days` DROP COLUMN `closed_collectors_json`').catch(() => {});
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version = 16').catch(() => {});

    const res1 = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 16,
    });
    expect(res1.applied).toContain(M016);

    const [shiftCol] = await tenantSeq.query(
      "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'shift'",
      { type: QueryTypes.SELECT }
    );
    expect(shiftCol).toBeDefined();
    expect(shiftCol.COLUMN_NAME).toBe('shift');

    const [closedCol] = await tenantSeq.query(
      "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ledger_days' AND COLUMN_NAME = 'closed_collectors_json'",
      { type: QueryTypes.SELECT }
    );
    expect(closedCol).toBeDefined();
    expect(closedCol.COLUMN_NAME).toBe('closed_collectors_json');

    // Run again - idempotent
    const res2 = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 16,
    });
    expect(res2.applied).not.toContain(M016);
  });
});
