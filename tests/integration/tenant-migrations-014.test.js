const { QueryTypes } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
} = require('../harness');
const {
  runTenantMigrations,
} = require('../../src/database/tenant-migration-runner');

describe('Tenant Migration 014 (create invoice_sequences table) Integration Tests (Rule 5)', () => {
  let dbHarness;
  let tenantSeq;
  const M014 = '014_create_invoice_sequences_table';

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenantSeq = dbHarness.tenant2.sequelize;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('--dry-run preview writes nothing to tenant database', async () => {
    // Reset tenant2 to version 13
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version >= 14').catch(() => {});
    await tenantSeq.query('DROP TABLE IF EXISTS `invoice_sequences`').catch(() => {});

    const [tableBefore] = await tenantSeq.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      { replacements: ['invoice_sequences'], type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(tableBefore).toBeUndefined();

    const res = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      dryRun: true,
      targetVersion: 14,
    });

    expect(res.dryRun).toBe(true);
    expect(res.wouldRun).toContain(M014);

    // Verify table was NOT created during dry-run
    const [tableAfter] = await tenantSeq.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      { replacements: ['invoice_sequences'], type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(tableAfter).toBeUndefined();

    // Verify schema_migrations does not have version 14
    const [row] = await tenantSeq.query(
      'SELECT version FROM schema_migrations WHERE version = 14',
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(row).toBeUndefined();
  });

  test('014 skips cleanly when invoice_sequences table exists with conflicting schema (conflicting-data skip test)', async () => {
    // Drop invoice_sequences if it exists, and recreate without next_number column
    await tenantSeq.query('DROP TABLE IF EXISTS `invoice_sequences`').catch(() => {});
    await tenantSeq.query(`
      CREATE TABLE \`invoice_sequences\` (
        \`id\` VARCHAR(36) NOT NULL PRIMARY KEY,
        \`custom_code\` VARCHAR(50) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version = 14').catch(() => {});

    const res = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 14,
    });

    expect(res.applied).not.toContain(M014);

    const [row] = await tenantSeq.query(
      'SELECT version FROM schema_migrations WHERE version = 14',
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(row).toBeUndefined();

    // Clean up incompatible table for next test
    await tenantSeq.query('DROP TABLE IF EXISTS `invoice_sequences`').catch(() => {});
  });

  test('014 applies successfully and is idempotent', async () => {
    await tenantSeq.query('DROP TABLE IF EXISTS `invoice_sequences`').catch(() => {});
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version = 14').catch(() => {});

    const res1 = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 14,
    });
    expect(res1.applied).toContain(M014);

    const [tableRow] = await tenantSeq.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      { replacements: ['invoice_sequences'], type: QueryTypes.SELECT }
    );
    expect(tableRow).toBeDefined();

    // Verify default GLOBAL sequence was seeded
    const [globalRow] = await tenantSeq.query(
      'SELECT branch_id, prefix, next_number FROM invoice_sequences WHERE branch_id = ?',
      { replacements: ['GLOBAL'], type: QueryTypes.SELECT }
    );
    expect(globalRow).toBeDefined();
    expect(globalRow.prefix).toBe('INV-ORG');
    expect(globalRow.next_number).toBe(1);

    // Idempotent re-run
    const res2 = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 14,
    });
    expect(res2.applied).not.toContain(M014);
  });
});
