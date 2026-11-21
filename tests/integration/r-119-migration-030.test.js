/**
 * R-119 D12: tenant migration 030_branch_refund_policy adds branches.refunds_allowed (NOT NULL DEFAULT 0)
 * and branches.refund_window_days (NULL = no limit) and copies each business's gyms values to its branches;
 * a branch without a gym takes the oldest gym's. gyms columns stay. Dry-run writes nothing; a re-run never
 * overwrites a branch's own policy; the documented rollback works; the baseline probe follows.
 * Scratch database (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { MIGRATIONS, runTenantMigrations } = require('../../src/database/tenant-migration-runner');
const { PROBES, readSnapshot } = require('../../src/database/tenant-schema-baseline');

const TENANT_DB = 'gymsera_test_tenant_mig_030';
const G_OLD = '00000000-0000-4000-8000-0000000000a1';
const G_NEW = '00000000-0000-4000-8000-0000000000a2';
const B_OLD = '00000000-0000-4000-8000-0000000000b1';
const B_NEW = '00000000-0000-4000-8000-0000000000b2';
const B_ORPHAN = '00000000-0000-4000-8000-0000000000b3';

const connect = (db) =>
  new Sequelize(db, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
    host: process.env.PLATFORM_DB_HOST || 'localhost',
    port: Number(process.env.PLATFORM_DB_PORT),
    dialect: 'mysql',
    logging: false,
  });
const columnsOf = async (seq, table) =>
  (await seq.query('SELECT COLUMN_NAME AS c, IS_NULLABLE AS n, COLUMN_TYPE AS t, COLUMN_DEFAULT AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', { replacements: [table], type: QueryTypes.SELECT }))
    .reduce((acc, r) => ({ ...acc, [r.c]: r }), {});
const policies = async (seq) =>
  Object.fromEntries((await seq.query('SELECT id, refunds_allowed AS a, refund_window_days AS d FROM branches ORDER BY id', { type: QueryTypes.SELECT }))
    .map((r) => [r.id, [Number(r.a), r.d == null ? null : Number(r.d)]]));

let tenant;

beforeAll(async () => {
  assertTestEnvironmentSafety({ databases: [TENANT_DB] });
  const conn = await getAdminConnection();
  await conn.query(`DROP DATABASE IF EXISTS \`${TENANT_DB}\``);
  await conn.query(`CREATE DATABASE \`${TENANT_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  tenant = connect(TENANT_DB);
  await tenant.query('CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(191) NOT NULL, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  for (const mig of MIGRATIONS.filter((m) => m.version <= 29)) {
    await tenant.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', { replacements: [mig.version, mig.name] });
  }
  await tenant.query('CREATE TABLE gyms (id CHAR(36) NOT NULL PRIMARY KEY, name VARCHAR(200) NOT NULL, refunds_allowed TINYINT(1) NOT NULL DEFAULT 0, refund_window_days SMALLINT UNSIGNED NULL, created_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  await tenant.query(`INSERT INTO gyms VALUES ('${G_OLD}', 'Iron house', 1, 14, '2026-01-01 00:00:00'), ('${G_NEW}', 'Worldgym', 1, NULL, '2026-06-01 00:00:00')`);
  await tenant.query('CREATE TABLE branches (id CHAR(36) NOT NULL PRIMARY KEY, gym_id CHAR(36) NULL, branch_name VARCHAR(200) NOT NULL, hours_json JSON NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  await tenant.query(`INSERT INTO branches (id, gym_id, branch_name) VALUES ('${B_OLD}', '${G_OLD}', 'Iron house Main'), ('${B_NEW}', '${G_NEW}', 'Worldgym Main'), ('${B_ORPHAN}', NULL, 'Legacy branch')`);
});

afterAll(async () => {
  if (tenant) await tenant.close().catch(() => {});
  const conn = await getAdminConnection();
  await conn.query(`DROP DATABASE IF EXISTS \`${TENANT_DB}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('tenant 030_branch_refund_policy', () => {
  test('exists, documents its rollback, has a probe, drops nothing', () => {
    const mig = MIGRATIONS.find((m) => m.version === 30);
    expect(mig.name).toBe('030_branch_refund_policy');
    expect(typeof PROBES[30]).toBe('function');
    expect(String(mig.up)).not.toMatch(/\bDROP\b/);
    const src = require('fs').readFileSync(require.resolve('../../src/database/tenant-migration-runner.js'), 'utf8');
    expect(src).toMatch(/ALTER TABLE `branches` DROP COLUMN `refunds_allowed`, DROP COLUMN `refund_window_days`/);
    expect(src).toMatch(/DELETE FROM `schema_migrations` WHERE `version` = 30/);
  });

  test('dry-run writes nothing', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 30, dryRun: true })).wouldRun).toEqual(['030_branch_refund_policy']);
    expect((await columnsOf(tenant, 'branches')).refunds_allowed).toBeUndefined();
    expect((await PROBES[30](await readSnapshot(tenant), tenant)).state).toBe('missing');
  });

  test('apply adds the columns and copies each gym\'s policy to its branches; orphan takes the oldest gym\'s', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 30 })).applied).toEqual(['030_branch_refund_policy']);
    const cols = await columnsOf(tenant, 'branches');
    expect(cols.refunds_allowed).toMatchObject({ n: 'NO', t: 'tinyint(1)', d: '0' });
    expect(cols.refund_window_days).toMatchObject({ n: 'YES', t: 'smallint(5) unsigned' });
    expect(await policies(tenant)).toEqual({ [B_OLD]: [1, 14], [B_NEW]: [1, null], [B_ORPHAN]: [1, 14] });
    // gyms columns stay as they were.
    expect(Object.keys(await columnsOf(tenant, 'gyms'))).toEqual(expect.arrayContaining(['refunds_allowed', 'refund_window_days']));
    expect((await PROBES[30](await readSnapshot(tenant), tenant)).state).toBe('present');
  });

  test('a new branch starts with refunds off', async () => {
    await tenant.query(`INSERT INTO branches (id, gym_id, branch_name) VALUES ('00000000-0000-4000-8000-0000000000b4', '${G_OLD}', 'New branch')`);
    expect((await policies(tenant))['00000000-0000-4000-8000-0000000000b4']).toEqual([0, null]);
  });

  test('a re-run is a no-op and keeps a branch\'s own policy; the documented rollback works', async () => {
    await tenant.query(`UPDATE branches SET refunds_allowed = 0, refund_window_days = 3 WHERE id = '${B_OLD}'`);
    expect((await runTenantMigrations(tenant, { targetVersion: 30 })).applied).toEqual([]);
    // Even the body itself, run again with the columns present, does not copy over the branch's value.
    await MIGRATIONS.find((m) => m.version === 30).up(tenant, {});
    expect((await policies(tenant))[B_OLD]).toEqual([0, 3]);
    await tenant.query('ALTER TABLE `branches` DROP COLUMN `refunds_allowed`, DROP COLUMN `refund_window_days`');
    await tenant.query('DELETE FROM `schema_migrations` WHERE `version` = 30');
    expect((await PROBES[30](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 30 })).applied).toEqual(['030_branch_refund_policy']);
  });
});
