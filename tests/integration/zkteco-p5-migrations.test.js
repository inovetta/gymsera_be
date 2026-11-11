/**
 * ZKTeco Phase 5 migrations (spec §15 Phase 5, T&A PUSH devices):
 *  - platform p030_access_devices_att: access_devices.device_type, cookie_seen_at (nullable);
 *  - tenant 026_device_att_options: access_device_details per-device att options, poll delay, stamps, INFO,
 *    poll timing; push_version widened to 40.
 * Dry-run writes nothing; apply adds the columns; existing rows keep NULL (= the default for the type, so an
 * acc device behaves as before); a re-run is a no-op; the documented rollback works; the baseline probe follows.
 * Scratch databases (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { MIGRATIONS, runTenantMigrations } = require('../../src/database/tenant-migration-runner');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');
const { PROBES, readSnapshot } = require('../../src/database/tenant-schema-baseline');

const PLATFORM_DB = 'gymsera_test_platform_mig_p030';
const TENANT_DB = 'gymsera_test_tenant_mig_026';
const NEW_COLS = ['send_userauthorize', 'validity_mode', 'poll_delay_seconds', 'att_stamps_json', 'info_json', 'last_poll_at', 'poll_gap_seconds', 'user_command_form'];

const connect = (db) =>
  new Sequelize(db, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
    host: process.env.PLATFORM_DB_HOST || 'localhost',
    port: Number(process.env.PLATFORM_DB_PORT),
    dialect: 'mysql',
    logging: false,
  });
const columnsOf = async (seq, table) =>
  (await seq.query('SELECT COLUMN_NAME AS c, IS_NULLABLE AS n, DATA_TYPE AS t, CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', { replacements: [table], type: QueryTypes.SELECT }))
    .reduce((acc, r) => ({ ...acc, [r.c]: r }), {});
const seedVersions = async (seq, list, upTo) => {
  await seq.query('CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(191) NOT NULL, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  for (const mig of list.filter((m) => m.version <= upTo)) {
    await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', { replacements: [mig.version, mig.name] });
  }
};

let platform;
let tenant;

beforeAll(async () => {
  assertTestEnvironmentSafety({ databases: [PLATFORM_DB, TENANT_DB] });
  const conn = await getAdminConnection();
  for (const db of [PLATFORM_DB, TENANT_DB]) {
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await conn.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }
  platform = connect(PLATFORM_DB);
  tenant = connect(TENANT_DB);
  await seedVersions(platform, PLATFORM_MIGRATIONS, 28);
  await runPlatformMigrations(platform, { targetVersion: 29 });
  await seedVersions(tenant, MIGRATIONS, 21);
  await tenant.query('CREATE TABLE gym_staff (id CHAR(36) NOT NULL PRIMARY KEY, branch_id CHAR(36) NOT NULL, user_id CHAR(36) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  await runTenantMigrations(tenant, { targetVersion: 25 });
  await tenant.query(`INSERT INTO access_device_details (id, branch_id, name, direction, enabled, push_version, created_at, updated_at)
    VALUES ('00000000-0000-4000-8000-000000000001', 'b1', 'Door', 'in', 1, '3.1.2', NOW(), NOW())`);
});

afterAll(async () => {
  for (const s of [platform, tenant]) if (s) await s.close().catch(() => {});
  const conn = await getAdminConnection();
  for (const db of [PLATFORM_DB, TENANT_DB]) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('platform p030_access_devices_att', () => {
  test('dry-run writes nothing; apply adds nullable columns; re-run no-op; rollback works', async () => {
    expect(PLATFORM_MIGRATIONS.find((m) => m.version === 30).name).toBe('p030_access_devices_att');
    expect((await runPlatformMigrations(platform, { targetVersion: 30, dryRun: true })).wouldRun).toEqual(['p030_access_devices_att']);
    expect((await columnsOf(platform, 'access_devices')).device_type).toBeUndefined();
    expect((await runPlatformMigrations(platform, { targetVersion: 30 })).applied).toEqual(['p030_access_devices_att']);
    const cols = await columnsOf(platform, 'access_devices');
    expect(cols.device_type).toMatchObject({ n: 'YES', t: 'varchar' });
    expect(cols.cookie_seen_at).toMatchObject({ n: 'YES', t: 'datetime' });
    expect((await runPlatformMigrations(platform, { targetVersion: 30 })).applied).toEqual([]);
    await platform.query('ALTER TABLE `access_devices` DROP COLUMN `device_type`, DROP COLUMN `cookie_seen_at`');
    await platform.query('DELETE FROM `schema_migrations` WHERE `version` = 30');
    expect((await runPlatformMigrations(platform, { targetVersion: 30 })).applied).toEqual(['p030_access_devices_att']);
  });
});

describe('tenant 026_device_att_options', () => {
  test('exists, documents its rollback, has a probe', () => {
    expect(MIGRATIONS.find((m) => m.version === 26).name).toBe('026_device_att_options');
    expect(typeof PROBES[26]).toBe('function');
    const src = require('fs').readFileSync(require.resolve('../../src/database/tenant-migration-runner.js'), 'utf8');
    expect(src).toMatch(/DELETE FROM `schema_migrations` WHERE `version` = 26/);
  });

  test('dry-run writes nothing; apply adds the columns, NULL on existing rows; push_version 40; probe present', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 26, dryRun: true })).wouldRun).toEqual(['026_device_att_options']);
    expect((await columnsOf(tenant, 'access_device_details')).user_command_form).toBeUndefined();
    expect((await PROBES[26](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 26 })).applied).toEqual(['026_device_att_options']);
    const cols = await columnsOf(tenant, 'access_device_details');
    for (const c of NEW_COLS) expect(cols[c].n).toBe('YES');
    expect(Number(cols.push_version.len)).toBe(40);
    const [row] = await tenant.query(`SELECT ${NEW_COLS.join(', ')}, push_version FROM access_device_details`, { type: QueryTypes.SELECT });
    for (const c of NEW_COLS) expect(row[c]).toBeNull();
    expect(row.push_version).toBe('3.1.2');
    expect((await PROBES[26](await readSnapshot(tenant), tenant)).state).toBe('present');
  });

  test('a re-run is a no-op; the documented rollback works', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 26 })).applied).toEqual([]);
    await tenant.query(`ALTER TABLE \`access_device_details\` ${NEW_COLS.map((c) => `DROP COLUMN \`${c}\``).join(', ')}`);
    await tenant.query('DELETE FROM `schema_migrations` WHERE `version` = 26');
    expect((await PROBES[26](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 26 })).applied).toEqual(['026_device_att_options']);
  });
});
