/**
 * R-113 H1: tenant migration 029_branch_hours_json adds branches.hours_json (JSON, NULL): no backfill, no
 * column dropped (opening_time / closing_time stay for old clients). Dry-run writes nothing; apply adds it
 * and keeps existing rows and their pair; a re-run is a no-op; the documented rollback works; the baseline
 * probe follows. Scratch database (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { MIGRATIONS, runTenantMigrations } = require('../../src/database/tenant-migration-runner');
const { PROBES, readSnapshot } = require('../../src/database/tenant-schema-baseline');

const TENANT_DB = 'gymsera_test_tenant_mig_029';

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
  await tenant.query('CREATE TABLE gyms (id CHAR(36) NOT NULL PRIMARY KEY, name VARCHAR(200) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  await tenant.query('INSERT INTO gyms (id, name) VALUES (\'00000000-0000-4000-8000-000000000028\', \'Existing Gym\')');
  await tenant.query('CREATE TABLE branches (id CHAR(36) NOT NULL PRIMARY KEY, branch_name VARCHAR(200) NOT NULL, opening_time TIME NULL, closing_time TIME NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  await tenant.query('INSERT INTO branches (id, branch_name, opening_time, closing_time) VALUES (\'00000000-0000-4000-8000-000000000029\', \'Existing Branch\', \'06:00:00\', \'22:00:00\')');
  await runTenantMigrations(tenant, { targetVersion: 28 });
});

afterAll(async () => {
  if (tenant) await tenant.close().catch(() => {});
  const conn = await getAdminConnection();
  await conn.query(`DROP DATABASE IF EXISTS \`${TENANT_DB}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('tenant 029_branch_hours_json', () => {
  test('exists, documents its rollback, has a probe', () => {
    expect(MIGRATIONS.find((m) => m.version === 29).name).toBe('029_branch_hours_json');
    expect(typeof PROBES[29]).toBe('function');
    const src = require('fs').readFileSync(require.resolve('../../src/database/tenant-migration-runner.js'), 'utf8');
    expect(src).toMatch(/ALTER TABLE `branches` DROP COLUMN `hours_json`/);
    expect(src).toMatch(/DELETE FROM `schema_migrations` WHERE `version` = 29/);
  });

  test('dry-run writes nothing; apply adds hours_json (NULL) and keeps the existing pair', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 29, dryRun: true })).wouldRun).toEqual(['029_branch_hours_json']);
    expect((await columnsOf(tenant, 'branches')).hours_json).toBeUndefined();
    expect((await PROBES[29](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 29 })).applied).toEqual(['029_branch_hours_json']);
    expect((await columnsOf(tenant, 'branches')).hours_json).toMatchObject({ n: 'YES' });
    const [row] = await tenant.query('SELECT branch_name, opening_time, closing_time, hours_json FROM branches', { type: QueryTypes.SELECT });
    expect(row).toEqual({ branch_name: 'Existing Branch', opening_time: '06:00:00', closing_time: '22:00:00', hours_json: null });
    expect((await PROBES[29](await readSnapshot(tenant), tenant)).state).toBe('present');
  });

  test('a re-run is a no-op; the documented rollback works', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 29 })).applied).toEqual([]);
    await tenant.query('ALTER TABLE `branches` DROP COLUMN `hours_json`');
    await tenant.query('DELETE FROM `schema_migrations` WHERE `version` = 29');
    expect((await PROBES[29](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 29 })).applied).toEqual(['029_branch_hours_json']);
  });
});
