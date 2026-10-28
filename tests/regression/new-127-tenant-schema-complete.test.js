/**
 * NEW-127 (P0) — production tenant GYM-4814C134 is live with no `schema_migrations` and no
 * `branches.currency` (tenant migration 019), while the other 30 tenants have both; its approved
 * host's Gyms tab answers `database_error`.
 *
 * Provisioning (approve from the CMS = POST /admin/tenants/:id/approve → approveTenant →
 * processTenantProvisioning) runs every migration in step 6 on today's code, so a fresh approval
 * cannot produce that database. What can leave a tenant live below target:
 *   1. step 6 set ACTIVE even when a migration was skipped ("resolve it by hand"), so
 *      provisioning could finish with a migration missing;
 *   2. the deploy runner (`run-tenant-migrations.js`) visited ACTIVE tenants only. A tenant that
 *      was SUSPENDED (subscription expiry) or PENDING_DELETION during a run was skipped, and both
 *      ways back to ACTIVE (assignTenantSubscription, cancelling the deletion) run no migration;
 *   3. a database with tables but no `schema_migrations` (made before the runner, 2026-09-26) was
 *      handed to the runner, which replayed every migration from 001 (backfills and collation
 *      conversion included) instead of refusing.
 *
 * Real provisioning into `gymsera_test_n127_*` databases on the local test MySQL (R-19).
 */
const request = require('supertest');
const { Sequelize } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases, getAdminConnection, factories } = require('../harness');
const { installMailFake } = require('../harness/mail-fake');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { encrypt } = require('../../src/utils/crypto.utils');
const { City } = require('../../src/models/platform');
const registerTenantModels = require('../../src/models/tenant');
const runner = require('../../src/database/tenant-migration-runner');

const { MIGRATIONS, TARGET_SCHEMA_VERSION } = runner;
const ALL_VERSIONS = MIGRATIONS.map((m) => m.version);

const createdDbs = [];
let seq = 0;
let app;
let adminToken;

beforeAll(async () => {
  await setupTestDatabases();
  installMailFake();
  app = await startTestServer();
  await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
  const admin = await factories.createUser({ email: 'admin-n127@gymsera.test', role: 'PLATFORM_ADMIN' });
  adminToken = signToken({ sub: admin.id, id: admin.id, role: 'PLATFORM_ADMIN', isVerified: true });
});

afterEach(() => {
  jest.restoreAllMocks();
  installMailFake();
});

afterAll(async () => {
  const conn = await getAdminConnection();
  for (const db of createdDbs) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await teardownTestDatabases();
});

const nextCode = () => {
  seq += 1;
  const tenantCode = `test_n127_${Date.now().toString(36)}_${seq}`;
  createdDbs.push(`gymsera_${tenantCode}`);
  return tenantCode;
};

const pendingTenant = () => factories.createTenant({
  tenantCode: nextCode(),
  status: 'PENDING_REVIEW',
  connectionStringEncrypted: null,
  paymentMethod: 'BANK_TRANSFER',
  mainBranchDataJson: { name: 'Main', plans: [{ name: 'Monthly', price: 3000 }] },
});

const tenantUrl = (dbName) => {
  const host = process.env.TENANT_DB_HOST || 'localhost';
  const port = process.env.TENANT_DB_PORT || '3306';
  const user = process.env.TENANT_DB_USER || 'root';
  const pass = process.env.TENANT_DB_PASS !== undefined ? process.env.TENANT_DB_PASS : '';
  return `mysql://${user}:${pass}@${host}:${port}/${dbName}`;
};

const recordedVersions = async (dbName) => {
  const conn = await getAdminConnection();
  const [tables] = await conn.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = \'schema_migrations\'', [dbName]
  );
  if (!tables.length) return null;
  const [rows] = await conn.query(`SELECT version FROM \`${dbName}\`.schema_migrations ORDER BY version`);
  return rows.map((r) => Number(r.version));
};

const hasColumn = async (dbName, table, column) => {
  const conn = await getAdminConnection();
  const [rows] = await conn.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [dbName, table, column]
  );
  return rows.length === 1;
};

/**
 * A provisioned tenant database (models synced, every migration applied), then turned into
 * the requested shape: `v18` = migration 019 never applied; `legacy` = like GYM-4814C134,
 * no schema_migrations at all and no branches.currency.
 */
const tenantWithDb = async ({ status, shape }) => {
  const tenantCode = nextCode();
  const dbName = `gymsera_${tenantCode}`;
  const conn = await getAdminConnection();
  await conn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const url = tenantUrl(dbName);
  const s = new Sequelize(url, { dialect: 'mysql', logging: false });
  try {
    const models = registerTenantModels(s);
    await s.sync();
    await runner.runTenantMigrations(s, { tenantId: tenantCode });
    const gym = await models.Gym.create({ name: 'N127 Gym', gymListingId: 'listing-n127' });
    await models.Branch.create({ gymId: gym.id, branchName: 'Main', gymListingId: 'listing-n127' });
    if (shape === 'v18') await s.query('DELETE FROM schema_migrations WHERE version >= 19');
    if (shape === 'legacy') await s.query('DROP TABLE schema_migrations');
    if (shape === 'v18' || shape === 'legacy') await s.query('ALTER TABLE branches DROP COLUMN currency');
  } finally {
    await s.close();
  }
  const tenant = await factories.createTenant({ tenantCode, status, connectionStringEncrypted: encrypt(url) });
  await tenant.update({ dbName });
  return { tenant, dbName };
};

describe('NEW-127: provisioning ends with every tenant migration recorded', () => {
  test('approve from the CMS (POST /admin/tenants/:id/approve): ACTIVE, schema_migrations present, every version 1..target recorded, branches.currency present', async () => {
    const tenant = await pendingTenant();
    const res = await request(app)
      .post(`/api/v1/admin/tenants/${tenant.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);

    await tenant.reload();
    expect(tenant.status).toBe('ACTIVE');
    expect(await recordedVersions(tenant.dbName)).toEqual(ALL_VERSIONS);
    expect(ALL_VERSIONS[ALL_VERSIONS.length - 1]).toBe(TARGET_SCHEMA_VERSION);
    expect(await hasColumn(tenant.dbName, 'branches', 'currency')).toBe(true);
  });

  test('a migration that skips ("resolve it by hand") stops provisioning before ACTIVE; Resume finishes once it is resolved', async () => {
    const tenant = await pendingTenant();
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    const realUp = last.up;
    jest.spyOn(last, 'up').mockImplementation(async () => ({ skipped: true, reason: 'column_exists_with_other_type' }));

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${tenant.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(502);

    await tenant.reload();
    expect(tenant.status).toBe('APPROVED');
    expect(tenant.provisioningState).toBe('SUBSCRIPTION_LINKED');
    expect(tenant.provisioningError).toMatch(new RegExp(last.name));
    expect(tenant.connectionStringEncrypted).toBeNull();

    // Resolved by hand → the admin's Resume finishes it.
    last.up.mockImplementation(realUp);
    const resumed = await request(app)
      .post(`/api/v1/admin/tenants/${tenant.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(resumed.status).toBe(200);
    await tenant.reload();
    expect(tenant.status).toBe('ACTIVE');
    expect(await recordedVersions(tenant.dbName)).toEqual(ALL_VERSIONS);
  });
});

describe('NEW-127: the deploy runner reaches every tenant that can come back to ACTIVE', () => {
  test.each(['SUSPENDED', 'PENDING_DELETION'])('a %s tenant at v18 is migrated to target', async (status) => {
    const { tenant, dbName } = await tenantWithDb({ status, shape: 'v18' });

    const summary = await runner.runAllTenantMigrations();
    const report = summary.reports.find((r) => r.tenantId === tenant.id);
    expect(report).toEqual(expect.objectContaining({ success: true, initialVersion: 18, finalVersion: TARGET_SCHEMA_VERSION }));
    expect(await recordedVersions(dbName)).toEqual(ALL_VERSIONS);
    expect(await hasColumn(dbName, 'branches', 'currency')).toBe(true);
  });

  test('a database with tables but no schema_migrations is refused (dry run and live), nothing is written, and the repair command is named', async () => {
    const { tenant, dbName } = await tenantWithDb({ status: 'ACTIVE', shape: 'legacy' });

    for (const dryRun of [true, false]) {
      const summary = await runner.runAllTenantMigrations({ dryRun });
      const report = summary.reports.find((r) => r.tenantId === tenant.id);
      expect(report.success).toBe(false);
      expect(report.error).toMatch(/no schema_migrations/);
      expect(report.error).toContain(`repair-tenant-schema.js --tenant ${tenant.tenantCode}`);
    }
    expect(await recordedVersions(dbName)).toBeNull();
    expect(await hasColumn(dbName, 'branches', 'currency')).toBe(false);
  });

  test('the startup check counts SUSPENDED tenants and names a legacy database apart from one that is behind', async () => {
    const behind = await tenantWithDb({ status: 'SUSPENDED', shape: 'v18' });
    const legacy = await tenantWithDb({ status: 'ACTIVE', shape: 'legacy' });

    const result = await runner.checkTenantSchemaVersions();
    const b = result.behind.find((x) => x.tenantId === behind.tenant.id);
    const l = result.behind.find((x) => x.tenantId === legacy.tenant.id);
    expect(b).toEqual(expect.objectContaining({ currentVersion: 18, targetVersion: TARGET_SCHEMA_VERSION, hasMigrationTable: true }));
    expect(l).toEqual(expect.objectContaining({ currentVersion: 0, hasMigrationTable: false, tenantCode: legacy.tenant.tenantCode }));
  });
});

describe('NEW-127: helpers', () => {
  test('missingTenantMigrations lists every version not recorded', async () => {
    const { dbName } = await tenantWithDb({ status: 'ACTIVE', shape: 'v18' });
    const s = new Sequelize(tenantUrl(dbName), { dialect: 'mysql', logging: false });
    try {
      expect(await runner.missingTenantMigrations(s)).toEqual(ALL_VERSIONS.filter((v) => v > 18));
      await s.query('DROP TABLE schema_migrations');
      expect(await runner.missingTenantMigrations(s)).toEqual(ALL_VERSIONS);
    } finally {
      await s.close();
    }
  });

});
