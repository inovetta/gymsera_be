/**
 * NEW-248d (R-101): tenant migration 027_device_admin_pins creates device_admin_pins (device_id, pin, privilege,
 * source, seen_at). Dry-run writes nothing; apply creates the table; a re-run is a no-op; the documented rollback
 * works; the baseline probe follows. Scratch database (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { MIGRATIONS, runTenantMigrations } = require('../../src/database/tenant-migration-runner');
const { PROBES, readSnapshot } = require('../../src/database/tenant-schema-baseline');

const TENANT_DB = 'gymsera_test_tenant_mig_027';

const connect = (db) =>
  new Sequelize(db, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
    host: process.env.PLATFORM_DB_HOST || 'localhost',
    port: Number(process.env.PLATFORM_DB_PORT),
    dialect: 'mysql',
    logging: false,
  });
const columnsOf = async (seq, table) =>
  (await seq.query('SELECT COLUMN_NAME AS c, IS_NULLABLE AS n, DATA_TYPE AS t, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', { replacements: [table], type: QueryTypes.SELECT }))
    .reduce((acc, r) => ({ ...acc, [r.c]: r }), {});

let tenant;

beforeAll(async () => {
  assertTestEnvironmentSafety({ databases: [TENANT_DB] });
  const conn = await getAdminConnection();
  await conn.query(`DROP DATABASE IF EXISTS \`${TENANT_DB}\``);
  await conn.query(`CREATE DATABASE \`${TENANT_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  tenant = connect(TENANT_DB);
  await tenant.query('CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(191) NOT NULL, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  for (const mig of MIGRATIONS.filter((m) => m.version <= 21)) {
    await tenant.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', { replacements: [mig.version, mig.name] });
  }
  await tenant.query('CREATE TABLE gym_staff (id CHAR(36) NOT NULL PRIMARY KEY, branch_id CHAR(36) NOT NULL, user_id CHAR(36) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  await runTenantMigrations(tenant, { targetVersion: 26 });
});

afterAll(async () => {
  if (tenant) await tenant.close().catch(() => {});
  const conn = await getAdminConnection();
  await conn.query(`DROP DATABASE IF EXISTS \`${TENANT_DB}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('tenant 027_device_admin_pins', () => {
  test('exists, documents its rollback, has a probe', () => {
    expect(MIGRATIONS.find((m) => m.version === 27).name).toBe('027_device_admin_pins');
    expect(typeof PROBES[27]).toBe('function');
    const src = require('fs').readFileSync(require.resolve('../../src/database/tenant-migration-runner.js'), 'utf8');
    expect(src).toMatch(/DROP TABLE `device_admin_pins`/);
    expect(src).toMatch(/DELETE FROM `schema_migrations` WHERE `version` = 27/);
  });

  test('dry-run writes nothing; apply creates the table; probe present', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 27, dryRun: true })).wouldRun).toEqual(['027_device_admin_pins']);
    expect(await columnsOf(tenant, 'device_admin_pins')).toEqual({});
    expect((await PROBES[27](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 27 })).applied).toEqual(['027_device_admin_pins']);
    const cols = await columnsOf(tenant, 'device_admin_pins');
    expect(Object.keys(cols).sort()).toEqual(['device_id', 'pin', 'privilege', 'seen_at', 'source']);
    expect(cols.device_id).toMatchObject({ n: 'NO', k: 'PRI' });
    expect(cols.pin).toMatchObject({ n: 'NO', k: 'PRI', t: 'varchar' });
    expect(cols.privilege).toMatchObject({ n: 'NO', t: 'tinyint' });
    expect((await PROBES[27](await readSnapshot(tenant), tenant)).state).toBe('present');
    // Existing device tables are untouched.
    expect((await columnsOf(tenant, 'device_member_sync')).pin).toBeDefined();
  });

  test('a re-run is a no-op; the documented rollback works', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 27 })).applied).toEqual([]);
    await tenant.query('DROP TABLE `device_admin_pins`');
    await tenant.query('DELETE FROM `schema_migrations` WHERE `version` = 27');
    expect((await PROBES[27](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 27 })).applied).toEqual(['027_device_admin_pins']);
  });
});
