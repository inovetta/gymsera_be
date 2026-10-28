/**
 * NEW-127 (P0), production evidence 2026-10-27: GYM-4814C134 was approved 2026-10-24 10:43:44 and
 * its 24 tables were made within 2 seconds of it. The tenant was left ACTIVE, provisioning_state
 * NULL, no `schema_migrations` and no `branches.currency`. No build of main since 2026-09-26 can do
 * that: since d7d4179 (2026-09-26) provisioning runs every tenant migration, and since d326909
 * (FLOW-02, 2026-10-01) approval records provisioning_state before any step. The build before
 * d7d4179 (f083c0f) matches all of it: it ran `sync({ alter: true })` (exactly these 24 tables),
 * ran no migration, and set ACTIVE with no provisioning_state.
 *
 * What a fresh approval must leave behind, checked on the database itself. This file uses only
 * what that build already had (harness setupTestDatabases / getAdminConnection / factories,
 * admin.service#approveTenant), so it also runs on f083c0f, where it fails. The production check
 * after a deploy is the same list: docs/sql/new-127-fresh-approval-check.sql.
 *
 * Real provisioning into `gymsera_test_n127f_*` databases on the local test MySQL (R-19).
 */
const { setupTestDatabases, teardownTestDatabases, getAdminConnection, factories } = require('../harness');
const { City } = require('../../src/models/platform');
const adminService = require('../../src/services/admin.service');
const registerTenantModels = require('../../src/models/tenant');

let tenant;
let dbName;

const tables = async () => {
  const conn = await getAdminConnection();
  const [rows] = await conn.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [dbName]);
  return rows.map((r) => r.t);
};

beforeAll(async () => {
  await setupTestDatabases();
  await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
  const admin = await factories.createUser({ email: 'admin-n127f@gymsera.test', role: 'PLATFORM_ADMIN' });
  const tenantCode = `test_n127f_${Date.now().toString(36)}`;
  dbName = `gymsera_${tenantCode}`;
  tenant = await factories.createTenant({
    tenantCode,
    status: 'PENDING_REVIEW',
    connectionStringEncrypted: null,
    paymentMethod: 'BANK_TRANSFER',
    mainBranchDataJson: { name: 'Main', plans: [{ name: 'Monthly', price: 3000 }] },
  });
  await adminService.approveTenant(tenant.id, admin.id);
  await tenant.reload();
});

afterAll(async () => {
  const conn = await getAdminConnection();
  await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('NEW-127: a fresh approval leaves a complete tenant database', () => {
  test('the tenant is ACTIVE on its own database', async () => {
    expect(tenant.status).toBe('ACTIVE');
    expect(await tables()).toContain('branches');
  });

  test('schema_migrations exists (the 2026-09-26 build made none)', async () => {
    expect(await tables()).toContain('schema_migrations');
  });

  test('every tenant migration is recorded, up to the target version', async () => {
    const { MIGRATIONS, TARGET_SCHEMA_VERSION } = require('../../src/database/tenant-migration-runner');
    const conn = await getAdminConnection();
    const [rows] = await conn.query(`SELECT version FROM \`${dbName}\`.schema_migrations ORDER BY version`);
    expect(rows.map((r) => Number(r.version))).toEqual(MIGRATIONS.map((m) => m.version));
    expect(Math.max(...rows.map((r) => Number(r.version)))).toBe(TARGET_SCHEMA_VERSION);
  });

  test('branches.currency exists (tenant migration 019)', async () => {
    const conn = await getAdminConnection();
    const [rows] = await conn.query(
      'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = \'branches\' AND COLUMN_NAME = \'currency\'', [dbName]
    );
    expect(rows).toHaveLength(1);
  });

  test('provisioning recorded its last step: provisioning_state = ACTIVE (NULL on the 2026-09-26 build)', async () => {
    const conn = await getAdminConnection();
    const platformDb = tenant.sequelize.config.database;
    const [[row]] = await conn.query(`SELECT provisioning_state AS state FROM \`${platformDb}\`.tenants WHERE id = ?`, [tenant.id]);
    expect(row.state).toBe('ACTIVE');
  });

  test('every table the current tenant models define exists (the 2026-09-26 build made 24 of them)', async () => {
    const { Sequelize } = require('sequelize');
    const offline = new Sequelize('offline', 'x', 'x', { dialect: 'mysql', logging: false });
    const expected = Object.values(registerTenantModels(offline)).map((m) => m.getTableName()).map(String);
    const present = await tables();
    expect(expected.filter((t) => !present.includes(t))).toEqual([]);
    await offline.close();
  });
});

describe('NEW-127: the production check after a deploy (docs/sql/new-127-fresh-approval-check.sql)', () => {
  const path = require('path');
  const { spawnSync } = require('child_process');
  const cli = () => {
    const r = spawnSync(process.execPath, [
      path.join(__dirname, '..', '..', 'src', 'scripts', 'run-sql-check.js'),
      path.join(__dirname, '..', '..', 'docs', 'sql', 'new-127-fresh-approval-check.sql'),
    ], { env: process.env, encoding: 'utf8', timeout: 120000 });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };

  test('on the gym just approved: PASS, 29 tables, and every migration recorded from 1 to the target', () => {
    const { TARGET_SCHEMA_VERSION } = require('../../src/database/tenant-migration-runner');
    const { status, out } = cli();
    const grid1 = out.slice(out.indexOf('Grid 1'), out.indexOf('Grid 2'));
    expect(grid1).toMatch(new RegExp(`\\|\\s*${tenant.tenantCode}\\s*\\|`));
    expect(grid1).toMatch(/\|\s*ACTIVE\s*\|\s*ACTIVE\s*\|\s*NULL\s*\|\s*29\s*\|\s*1\s*\|\s*1\s*\|\s*4\s*\|\s*PASS\s*\|/);
    const t = TARGET_SCHEMA_VERSION;
    expect(out.slice(out.indexOf('Grid 2'))).toMatch(new RegExp(`\\|\\s*${t}\\s*\\|\\s*1\\s*\\|\\s*${t}\\s*\\|`));
    expect(out).toMatch(/^Done: 2 grids\./m);
    expect(status).toBe(0);
  });

  test('on a gym in the GYM-4814C134 state (no schema_migrations, no currency): FAIL, and the run ends with an error, exit 1', async () => {
    const conn = await getAdminConnection();
    await conn.query(`DROP TABLE \`${dbName}\`.schema_migrations`);
    await conn.query(`ALTER TABLE \`${dbName}\`.branches DROP COLUMN currency`);
    const { status, out } = cli();
    expect(out.slice(out.indexOf('Grid 1'))).toMatch(/\|\s*0\s*\|\s*0\s*\|\s*4\s*\|\s*FAIL\s*\|/);
    expect(out).toMatch(/schema_migrations' doesn't exist/);
    expect(out).not.toMatch(/^Done:/m);
    expect(status).toBe(1);
  });
});
