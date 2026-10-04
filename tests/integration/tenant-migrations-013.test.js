const { QueryTypes } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
} = require('../harness');
const {
  runTenantMigrations,
} = require('../../src/database/tenant-migration-runner');

describe('Tenant Migration 013 (add role_assignment version) Integration Tests (Rule 5)', () => {
  let dbHarness;
  let tenantSeq;
  const M013 = '013_add_role_assignment_version';

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenantSeq = dbHarness.tenant2.sequelize;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('--dry-run preview writes nothing to tenant database', async () => {
    // Reset tenant2 to version 12
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version >= 13').catch(() => {});
    await tenantSeq.query('ALTER TABLE `role_assignments` DROP COLUMN `version`').catch(() => {});

    const qi = tenantSeq.getQueryInterface();
    const colsBefore = await qi.describeTable('role_assignments');
    expect(colsBefore.version).toBeUndefined();

    const res = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      dryRun: true,
      targetVersion: 13,
    });

    expect(res.dryRun).toBe(true);
    expect(res.wouldRun).toContain(M013);

    // Verify column was NOT added during dry-run
    const colsAfter = await qi.describeTable('role_assignments');
    expect(colsAfter.version).toBeUndefined();

    // Verify schema_migrations does not have version 13
    const [row] = await tenantSeq.query(
      'SELECT version FROM schema_migrations WHERE version = 13',
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(row).toBeUndefined();
  });

  test('013 skips cleanly when role_assignments.version exists with incompatible type (conflicting-data skip test)', async () => {
    // Drop version if it exists, and recreate as incompatible VARCHAR
    await tenantSeq.query('ALTER TABLE `role_assignments` DROP COLUMN `version`').catch(() => {});
    await tenantSeq.query('ALTER TABLE `role_assignments` ADD COLUMN `version` VARCHAR(100) NULL');
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version = 13').catch(() => {});

    const res = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 13,
    });

    expect(res.applied).not.toContain(M013);

    const [row] = await tenantSeq.query(
      'SELECT version FROM schema_migrations WHERE version = 13',
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(row).toBeUndefined();

    // Clean up incompatible column for next test
    await tenantSeq.query('ALTER TABLE `role_assignments` DROP COLUMN `version`').catch(() => {});
  });

  test('013 applies successfully and is idempotent', async () => {
    await tenantSeq.query('ALTER TABLE `role_assignments` DROP COLUMN `version`').catch(() => {});
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version = 13').catch(() => {});

    const res = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 13,
    });

    expect(res.finalVersion).toBe(13);
    expect(res.applied).toContain(M013);

    const qi = tenantSeq.getQueryInterface();
    const cols = await qi.describeTable('role_assignments');
    expect(cols.version).toBeDefined();

    // Re-run should be idempotent
    const rerun = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 13,
    });
    expect(rerun.applied).toHaveLength(0);
    expect(rerun.finalVersion).toBe(13);
  });
});
