/**
 * ZKTeco Phase 2: tenant migration 023_device_sync_tables (spec §6.2, §6.3).
 * Dry-run lists it and writes nothing; apply creates the tables (canonical collation, keys) and the
 * additive columns (device_commands.batch_id, access_device_details sweep / offline columns,
 * gym_staff.device_access default 0); the PIN sequence starts at 1001; a re-run is a no-op; the
 * documented rollback works; the baseline probe follows. Scratch database (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { MIGRATIONS, runTenantMigrations } = require('../../src/database/tenant-migration-runner');
const { PROBES, readSnapshot } = require('../../src/database/tenant-schema-baseline');

const TENANT_DB = 'gymsera_test_tenant_mig_023';
const NEW_TABLES = [
  'device_pin_sequence', 'member_device_identity', 'member_biometrics', 'member_biometric_photos', 'member_biometric_consents',
  'device_member_sync', 'device_access_events', 'device_state', 'device_error_logs', 'device_unlinked_users', 'device_audits', 'device_audit_pins',
];

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
  // An existing table 023 changes, with a row, as on a live tenant.
  await tenant.query('CREATE TABLE gym_staff (id CHAR(36) NOT NULL PRIMARY KEY, branch_id CHAR(36) NOT NULL, user_id CHAR(36) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
  await tenant.query('INSERT INTO gym_staff (id, branch_id, user_id) VALUES (\'s1\', \'b1\', \'u1\')');
  await runTenantMigrations(tenant, { targetVersion: 22 });
});

afterAll(async () => {
  if (tenant) await tenant.close().catch(() => {});
  const conn = await getAdminConnection();
  await conn.query(`DROP DATABASE IF EXISTS \`${TENANT_DB}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('tenant 023_device_sync_tables', () => {
  test('exists, documents its rollback, has a baseline probe', () => {
    const mig = MIGRATIONS.find((m) => m.version === 23);
    expect(mig.name).toBe('023_device_sync_tables');
    expect(typeof PROBES[23]).toBe('function');
    const src = require('fs').readFileSync(require.resolve('../../src/database/tenant-migration-runner.js'), 'utf8');
    expect(src).toMatch(/ROLLBACK \(previous build first\): DROP TABLE `device_audit_pins`/);
  });

  test('dry-run lists it and writes nothing; the probe says missing', async () => {
    const res = await runTenantMigrations(tenant, { targetVersion: 23, dryRun: true });
    expect(res.wouldRun).toEqual(['023_device_sync_tables']);
    const t = await tablesOf(tenant);
    for (const name of NEW_TABLES) expect(t[name]).toBeUndefined();
    expect((await columnsOf(tenant, 'gym_staff')).device_access).toBeUndefined();
    expect((await PROBES[23](await readSnapshot(tenant), tenant)).state).toBe('missing');
  });

  test('apply: tables in the canonical collation, keys, additive columns; existing rows untouched; probe present', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 23 })).applied).toEqual(['023_device_sync_tables']);
    const t = await tablesOf(tenant);
    for (const name of NEW_TABLES) expect(t[name]).toBe('utf8mb4_unicode_ci');
    expect((await keysOf(tenant, 'member_device_identity')).member_device_identity_pin).toEqual({ unique: true, cols: ['pin'] });
    expect((await keysOf(tenant, 'member_biometrics')).member_biometrics_slot).toEqual({ unique: true, cols: ['member_id', 'bio_type', 'bio_no', 'bio_index'] });
    expect((await keysOf(tenant, 'device_member_sync')).PRIMARY.cols).toEqual(['device_id', 'member_id']);
    expect((await keysOf(tenant, 'device_access_events')).device_access_events_record).toEqual({ unique: true, cols: ['device_id', 'device_record_index', 'device_time'] });
    expect((await keysOf(tenant, 'device_commands')).device_commands_member.cols).toEqual(['device_id', 'member_id', 'status']);
    expect(Object.keys(await columnsOf(tenant, 'device_commands'))).toContain('batch_id');
    expect(Object.keys(await columnsOf(tenant, 'access_device_details'))).toEqual(expect.arrayContaining(['last_sweep_at', 'offline_since', 'offline_notified_at']));
    const staffCol = (await columnsOf(tenant, 'gym_staff')).device_access;
    expect(staffCol).toMatchObject({ d: '0', n: 'NO' });
    const [row] = await tenant.query('SELECT id, device_access FROM gym_staff', { type: QueryTypes.SELECT });
    expect(row).toEqual({ id: 's1', device_access: 0 });
    const [seq] = await tenant.query('SELECT next_pin FROM device_pin_sequence WHERE id = 1', { type: QueryTypes.SELECT });
    expect(Number(seq.next_pin)).toBe(1001);
    // Templates are only ever stored encrypted: a binary column, no plain-text template column.
    const bio = await columnsOf(tenant, 'member_biometrics');
    expect(Object.keys(bio)).toEqual(expect.arrayContaining(['template_enc', 'key_version', 'template_sha256']));
    expect(Object.keys(bio).some((c) => /^(tmp|template)$/.test(c))).toBe(false);
    expect((await PROBES[23](await readSnapshot(tenant), tenant)).state).toBe('present');
  });

  test('a re-run is a no-op; the documented rollback works', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 23 })).applied).toEqual([]);
    for (const name of NEW_TABLES) await tenant.query(`DROP TABLE \`${name}\``);
    await tenant.query('ALTER TABLE `device_commands` DROP INDEX `device_commands_member`, DROP INDEX `device_commands_batch`, DROP COLUMN `batch_id`');
    await tenant.query('ALTER TABLE `access_device_details` DROP COLUMN `last_sweep_at`, DROP COLUMN `offline_since`, DROP COLUMN `offline_notified_at`');
    await tenant.query('ALTER TABLE `gym_staff` DROP COLUMN `device_access`');
    await tenant.query('DELETE FROM `schema_migrations` WHERE `version` = 23');
    expect((await PROBES[23](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 23 })).applied).toEqual(['023_device_sync_tables']);
  });
});
