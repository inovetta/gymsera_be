const { QueryTypes } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
} = require('../harness');
const {
  runTenantMigrations,
} = require('../../src/database/tenant-migration-runner');

describe('Tenant Migration 015 (add gym_staff invite token) Integration Tests (Rule 5)', () => {
  let dbHarness;
  let tenantSeq;
  const M015 = '015_add_gym_staff_invite_token';

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenantSeq = dbHarness.tenant2.sequelize;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('--dry-run preview writes nothing to tenant database', async () => {
    // Reset tenant2 to version 14
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version >= 15').catch(() => {});
    await tenantSeq.query('ALTER TABLE `gym_staff` DROP COLUMN `invite_token_hash`').catch(() => {});
    await tenantSeq.query('ALTER TABLE `gym_staff` DROP COLUMN `token_expires_at`').catch(() => {});

    const [colBefore] = await tenantSeq.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gym_staff' AND COLUMN_NAME = 'invite_token_hash'",
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(colBefore).toBeUndefined();

    const res = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      dryRun: true,
      targetVersion: 15,
    });

    expect(res.dryRun).toBe(true);
    expect(res.wouldRun).toContain(M015);

    // Verify columns were NOT created during dry-run
    const [colAfter] = await tenantSeq.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gym_staff' AND COLUMN_NAME = 'invite_token_hash'",
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(colAfter).toBeUndefined();

    // Verify schema_migrations does not have version 15
    const [row] = await tenantSeq.query(
      'SELECT version FROM schema_migrations WHERE version = 15',
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(row).toBeUndefined();
  });

  test('015 skips cleanly when gym_staff.invite_token_hash exists with conflicting schema (conflicting-data skip test)', async () => {
    // Ensure column exists as INT (conflicting type)
    await tenantSeq.query('ALTER TABLE `gym_staff` DROP COLUMN `invite_token_hash`').catch(() => {});
    await tenantSeq.query('ALTER TABLE `gym_staff` ADD COLUMN `invite_token_hash` INT NULL').catch(() => {});
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version = 15').catch(() => {});

    const res = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 15,
    });

    expect(res.applied).not.toContain(M015);

    const [row] = await tenantSeq.query(
      'SELECT version FROM schema_migrations WHERE version = 15',
      { type: QueryTypes.SELECT }
    ).catch(() => []);
    expect(row).toBeUndefined();

    // Clean up conflicting column
    await tenantSeq.query('ALTER TABLE `gym_staff` DROP COLUMN `invite_token_hash`').catch(() => {});
  });

  test('015 applies successfully and is idempotent', async () => {
    await tenantSeq.query('ALTER TABLE `gym_staff` DROP COLUMN `invite_token_hash`').catch(() => {});
    await tenantSeq.query('ALTER TABLE `gym_staff` DROP COLUMN `token_expires_at`').catch(() => {});
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version = 15').catch(() => {});

    const res1 = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 15,
    });
    expect(res1.applied).toContain(M015);

    const [col] = await tenantSeq.query(
      "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gym_staff' AND COLUMN_NAME = 'invite_token_hash'",
      { type: QueryTypes.SELECT }
    );
    expect(col).toBeDefined();
    expect(col.COLUMN_NAME).toBe('invite_token_hash');

    // Run again - idempotent
    const res2 = await runTenantMigrations(tenantSeq, {
      tenantId: 'test-tenant-2',
      targetVersion: 15,
    });
    expect(res2.applied).not.toContain(M015);
  });
});
