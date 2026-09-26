/**
 * Integration Test: Tenant Provisioning Migration Safety (Step 2.6)
 *
 * Verifies that:
 * 1. Newly provisioned tenants run migrations up to TARGET_SCHEMA_VERSION as part
 *    of setup before status becomes ACTIVE.
 * 2. Newly provisioned database contains schema_migrations at the latest version.
 * 3. Newly provisioned database contains role_assignments, approval_requests,
 *    and ledger_days tables.
 */
const { QueryTypes } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
  getAdminConnection,
} = require('../harness');
const {
  createUser,
  createTenant,
} = require('../harness/factories');
const { TARGET_SCHEMA_VERSION } = require('../../src/database/tenant-migration-runner');
const adminService = require('../../src/services/admin.service');
const TenantDbManager = require('../../src/database/TenantDbManager');

describe('Tenant Provisioning Migrations (Step 2.6)', () => {
  let dbHarness;
  let adminUser;
  let hostUser;
  const testTenantCode = 'test_safe_prov';
  const expectedDbName = `gymsera_${testTenantCode}`;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();

    adminUser = await createUser({
      email: 'admin-prov@gymsera.test',
      fullName: 'Platform Admin',
      role: 'PLATFORM_ADMIN',
    });

    hostUser = await createUser({
      email: 'host-prov@gymsera.test',
      fullName: 'Gym Host Owner',
      role: 'GYM_HOST',
    });
  });

  afterAll(async () => {
    // Clean up created tenant database safely
    try {
      const conn = await getAdminConnection();
      await conn.query(`DROP DATABASE IF EXISTS \`${expectedDbName}\`;`);
    } catch (_) {}
    await teardownTestDatabases();
  });

  test('approveTenant runs migrations to latest version before activating tenant', async () => {
    // 1. Create a tenant pending review
    const pendingTenant = await createTenant({
      id: '33333333-3333-4333-8333-333333333333',
      tenantCode: testTenantCode,
      gymName: 'Safe Migrations Gym',
      ownerUserId: hostUser.id,
      status: 'PENDING_REVIEW',
      connectionStringEncrypted: null,
    });

    // 2. Approve tenant (triggers processTenantProvisioning)
    const result = await adminService.approveTenant(pendingTenant.id, adminUser.id);
    expect(result.tenant.status).toBe('ACTIVE');

    // 3. Reload tenant from platform DB
    await pendingTenant.reload();
    expect(pendingTenant.status).toBe('ACTIVE');
    expect(pendingTenant.dbName).toBe(expectedDbName);
    expect(pendingTenant.connectionStringEncrypted).toBeTruthy();

    // 4. Connect to the provisioned tenant DB
    const { sequelize: tenantSequelize } = await TenantDbManager.getConnection(
      pendingTenant.id,
      pendingTenant.connectionStringEncrypted
    );

    // 5. Assert schema_migrations has reached latest version
    const migrations = await tenantSequelize.query(
      'SELECT version, name FROM schema_migrations ORDER BY version ASC',
      { type: QueryTypes.SELECT }
    );
    expect(migrations.length).toBeGreaterThanOrEqual(TARGET_SCHEMA_VERSION);
    const maxVersion = Math.max(...migrations.map((m) => Number(m.version)));
    expect(maxVersion).toBe(TARGET_SCHEMA_VERSION);

    // 6. Assert role_assignments, approval_requests, and ledger_days tables exist
    const tables = await tenantSequelize.query(
      "SHOW TABLES WHERE `Tables_in_" + expectedDbName + "` IN ('role_assignments', 'approval_requests', 'ledger_days')",
      { type: QueryTypes.SELECT }
    );
    const tableNames = tables.map((t) => Object.values(t)[0]);
    expect(tableNames).toContain('role_assignments');
    expect(tableNames).toContain('approval_requests');
    expect(tableNames).toContain('ledger_days');

    // 7. Verify we can select from them without schema error
    await expect(tenantSequelize.query('SELECT COUNT(*) FROM role_assignments')).resolves.toBeDefined();
    await expect(tenantSequelize.query('SELECT COUNT(*) FROM approval_requests')).resolves.toBeDefined();
    await expect(tenantSequelize.query('SELECT COUNT(*) FROM ledger_days')).resolves.toBeDefined();
  });
});
