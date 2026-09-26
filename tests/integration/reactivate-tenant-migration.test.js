/**
 * Integration Test: reactivateTenant Migration Enforcement (Step 2.10)
 *
 * Verifies that:
 * 1. When a suspended tenant is reactivated via adminService.reactivateTenant,
 *    the tenant migration runner is automatically executed to TARGET_SCHEMA_VERSION (v7)
 *    before the tenant's status transitions to ACTIVE.
 * 2. schema_migrations in the tenant's database is updated to the latest version.
 */
const { QueryTypes } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
  createMixedCollationTenantDb,
} = require('../harness');
const {
  createUser,
  createTenant,
} = require('../harness/factories');
const { TARGET_SCHEMA_VERSION } = require('../../src/database/tenant-migration-runner');
const adminService = require('../../src/services/admin.service');
const TenantDbManager = require('../../src/database/TenantDbManager');

describe('reactivateTenant Migration Enforcement (Step 2.10)', () => {
  let dbHarness;
  let adminUser;
  let hostUser;
  let fixture;
  const testDbName = 'gymsera_test_reactivate_mig';

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();

    adminUser = await createUser({
      email: 'admin-reactivate@gymsera.test',
      fullName: 'Platform Admin',
      role: 'PLATFORM_ADMIN',
    });

    hostUser = await createUser({
      email: 'host-reactivate@gymsera.test',
      fullName: 'Host Owner',
      role: 'GYM_HOST',
    });
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.cleanup();
    }
    await teardownTestDatabases();
  });

  test('reactivateTenant runs migrations to latest version before activating tenant', async () => {
    // 1. Create a fixture tenant DB initialized only up to v3 (behind latest)
    fixture = await createMixedCollationTenantDb(testDbName);

    // Verify initial version is 3
    const [initialRows] = await fixture.sequelize.query(
      'SELECT MAX(version) AS max_version FROM schema_migrations',
      { type: QueryTypes.SELECT }
    );
    expect(Number(initialRows.max_version)).toBe(3);

    // 2. Create a SUSPENDED tenant in platform DB pointing to this fixture DB
    const tenant = await createTenant({
      id: '44444444-4444-4444-8444-444444444444',
      tenantCode: 'REACTIVATE_TEST',
      gymName: 'Reactivation Gym',
      ownerUserId: hostUser.id,
      status: 'SUSPENDED',
      dbName: testDbName,
      connectionStringEncrypted: fixture.encryptedConnStr,
    });

    expect(tenant.status).toBe('SUSPENDED');

    // 3. Reactivate tenant
    const result = await adminService.reactivateTenant(tenant.id, adminUser.id);
    expect(result.tenant.status).toBe('ACTIVE');

    // 4. Reload from DB and verify status is ACTIVE
    await tenant.reload();
    expect(tenant.status).toBe('ACTIVE');

    // 5. Connect and verify migrations were applied up to TARGET_SCHEMA_VERSION (v7)
    const { sequelize: tenantSequelize } = await TenantDbManager.getConnection(
      tenant.id,
      tenant.connectionStringEncrypted
    );

    const [finalRows] = await tenantSequelize.query(
      'SELECT MAX(version) AS max_version FROM schema_migrations',
      { type: QueryTypes.SELECT }
    );
    expect(Number(finalRows.max_version)).toBe(TARGET_SCHEMA_VERSION);

    // 6. Verify payments table has no NULL business_date rows (004 applied)
    const [nullPayments] = await tenantSequelize.query(
      'SELECT COUNT(*) AS null_count FROM payments WHERE business_date IS NULL',
      { type: QueryTypes.SELECT }
    );
    expect(Number(nullPayments.null_count)).toBe(0);

    // 7. Verify collations are aligned to utf8mb4_unicode_ci (007 applied)
    const differingCols = await tenantSequelize.query(`
      SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND COLLATION_NAME IS NOT NULL 
        AND COLLATION_NAME != 'utf8mb4_unicode_ci'
    `, { type: QueryTypes.SELECT });
    expect(differingCols.length).toBe(0);
  });
});
