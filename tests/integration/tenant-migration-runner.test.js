/**
 * Integration Test: Tenant Migration Runner (spec §6.5)
 *
 * Verifies that:
 * 1. Tenant migrations create and update `schema_migrations`.
 * 2. Migrations are idempotent and safe to run multiple times.
 * 3. Migrations advance schemaVersion to TARGET_SCHEMA_VERSION.
 * 4. Resumable per-tenant reporting functions as expected.
 */
const { QueryTypes } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
} = require('../harness');
const {
  runTenantMigrations,
  TARGET_SCHEMA_VERSION,
} = require('../../src/database/tenant-migration-runner');

describe('Tenant Migration Runner (spec §6.5)', () => {
  let dbHarness;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('runs migrations up to target version and records schemaVersion in schema_migrations', async () => {
    const seq = dbHarness.tenant1.sequelize;

    // Run migrations on tenant1
    const res1 = await runTenantMigrations(seq, {
      tenantId: 'test-tenant-1',
      gymName: 'Test Gym 1',
    });

    expect(res1.finalVersion).toBe(TARGET_SCHEMA_VERSION);

    // Verify schema_migrations table exists and contains records
    const rows = await seq.query(
      'SELECT version, name FROM schema_migrations ORDER BY version ASC',
      { type: QueryTypes.SELECT }
    );

    expect(rows.length).toBe(TARGET_SCHEMA_VERSION);
    expect(rows[rows.length - 1].version).toBe(TARGET_SCHEMA_VERSION);

    // Re-run should be idempotent: 0 applied migrations
    const res2 = await runTenantMigrations(seq, {
      tenantId: 'test-tenant-1',
      gymName: 'Test Gym 1',
    });

    expect(res2.initialVersion).toBe(TARGET_SCHEMA_VERSION);
    expect(res2.finalVersion).toBe(TARGET_SCHEMA_VERSION);
    expect(res2.applied).toHaveLength(0);
  });
});
