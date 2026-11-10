/**
 * ZKTeco Phase 3: tenant migration 024_device_push_and_settings (spec §9, §10, D-6).
 * Dry-run lists it and writes nothing; apply creates device_push_requests, device_capture_photos,
 * device_branch_settings and the additive columns (device_commands.merged_into, device_unlinked_users
 * dismissed / linked, access_device_details.alerts_json); a re-run is a no-op; the documented
 * rollback works; the baseline probe follows. Scratch database (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { MIGRATIONS, runTenantMigrations } = require('../../src/database/tenant-migration-runner');
const { PROBES, readSnapshot } = require('../../src/database/tenant-schema-baseline');

const TENANT_DB = 'gymsera_test_tenant_mig_024';
const NEW_TABLES = ['device_push_requests', 'device_capture_photos', 'device_branch_settings'];

const connect = (db) =>
  new Sequelize(db, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
    host: process.env.PLATFORM_DB_HOST || 'localhost',
    port: Number(process.env.PLATFORM_DB_PORT),
    dialect: 'mysql',
    logging: false,
  });

const tablesOf = async (seq) =>
  (await seq.query('SELECT TABLE_NAME AS t, TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()', { type: QueryTypes.SELECT }))
    .reduce((acc, r) => ({ ...acc, [r.t]: r.c }), {});
const columnsOf = async (seq, table) =>
  (await seq.query('SELECT COLUMN_NAME AS c, COLUMN_DEFAULT AS d, IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', { replacements: [table], type: QueryTypes.SELECT }))
    .reduce((acc, r) => ({ ...acc, [r.c]: r }), {});
const keysOf = async (seq, table) => {
  const out = {};
  for (const r of await seq.query(`SHOW INDEX FROM \`${table}\``, { type: QueryTypes.SELECT })) {
    out[r.Key_name] = out[r.Key_name] || { unique: r.Non_unique === 0, cols: [] };
    out[r.Key_name].cols.push(r.Column_name);
  }
  return out;
};

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
  await runTenantMigrations(tenant, { targetVersion: 23 });
  // A live tenant has queued commands and unlinked users when 024 arrives.
  await tenant.query('INSERT INTO device_unlinked_users (device_id, pin, source, first_seen_at, last_seen_at) VALUES (\'d1\', \'5\', \'scan\', NOW(), NOW())');
});

afterAll(async () => {
  if (tenant) await tenant.close().catch(() => {});
  const conn = await getAdminConnection();
  await conn.query(`DROP DATABASE IF EXISTS \`${TENANT_DB}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('tenant 024_device_push_and_settings', () => {
  test('exists, documents its rollback, has a baseline probe', () => {
    const mig = MIGRATIONS.find((m) => m.version === 24);
    expect(mig.name).toBe('024_device_push_and_settings');
    expect(typeof PROBES[24]).toBe('function');
    const src = require('fs').readFileSync(require.resolve('../../src/database/tenant-migration-runner.js'), 'utf8');
    expect(src).toMatch(/ROLLBACK \(previous build first\): DROP TABLE `device_branch_settings`/);
  });

  test('dry-run lists it and writes nothing; the probe says missing', async () => {
    const res = await runTenantMigrations(tenant, { targetVersion: 24, dryRun: true });
    expect(res.wouldRun).toEqual(['024_device_push_and_settings']);
    const t = await tablesOf(tenant);
    for (const name of NEW_TABLES) expect(t[name]).toBeUndefined();
    expect((await columnsOf(tenant, 'device_commands')).merged_into).toBeUndefined();
    expect((await PROBES[24](await readSnapshot(tenant), tenant)).state).toBe('missing');
  });

  test('apply: tables in the canonical collation, keys, additive columns; existing rows untouched; probe present', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 24 })).applied).toEqual(['024_device_push_and_settings']);
    const t = await tablesOf(tenant);
    for (const name of NEW_TABLES) expect(t[name]).toBe('utf8mb4_unicode_ci');
    expect((await keysOf(tenant, 'device_push_requests')).device_push_requests_dedupe).toEqual({ unique: true, cols: ['dedupe_key'] });
    expect((await keysOf(tenant, 'device_capture_photos')).device_capture_photos_branch_time.cols).toEqual(['branch_id', 'created_at']);
    expect((await keysOf(tenant, 'device_branch_settings')).PRIMARY.cols).toEqual(['branch_id']);
    // D-6: off unless the branch opts in; alerts on.
    const settings = await columnsOf(tenant, 'device_branch_settings');
    expect(settings.capture_photos).toMatchObject({ d: '0', n: 'NO' });
    expect(settings.alerts_enabled).toMatchObject({ d: '1', n: 'NO' });
    expect(Object.keys(await columnsOf(tenant, 'device_commands'))).toContain('merged_into');
    expect(Object.keys(await columnsOf(tenant, 'device_unlinked_users'))).toEqual(expect.arrayContaining(['dismissed_at', 'linked_member_id', 'linked_at']));
    expect(Object.keys(await columnsOf(tenant, 'access_device_details'))).toContain('alerts_json');
    const [row] = await tenant.query('SELECT pin, dismissed_at FROM device_unlinked_users', { type: QueryTypes.SELECT });
    expect(row).toEqual({ pin: '5', dismissed_at: null });
    // A capture photo is stored encrypted in the private store: a key, never the image.
    const photo = await columnsOf(tenant, 'device_capture_photos');
    expect(Object.keys(photo)).toEqual(expect.arrayContaining(['storage_key', 'key_version', 'sha256', 'event_id']));
    expect(Object.keys(photo).some((c) => /^(photo|content|image)$/.test(c))).toBe(false);
    expect((await PROBES[24](await readSnapshot(tenant), tenant)).state).toBe('present');
  });

  test('a re-run is a no-op; the documented rollback works', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 24 })).applied).toEqual([]);
    for (const name of NEW_TABLES) await tenant.query(`DROP TABLE \`${name}\``);
    await tenant.query('ALTER TABLE `device_commands` DROP INDEX `device_commands_merged`, DROP COLUMN `merged_into`');
    await tenant.query('ALTER TABLE `device_unlinked_users` DROP COLUMN `dismissed_at`, DROP COLUMN `linked_member_id`, DROP COLUMN `linked_at`');
    await tenant.query('ALTER TABLE `access_device_details` DROP COLUMN `alerts_json`');
    await tenant.query('DELETE FROM `schema_migrations` WHERE `version` = 24');
    expect((await PROBES[24](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 24 })).applied).toEqual(['024_device_push_and_settings']);
  });
});
