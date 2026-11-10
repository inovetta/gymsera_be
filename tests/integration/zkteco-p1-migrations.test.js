/**
 * ZKTeco Phase 1 migrations (spec §6):
 *  - platform p029_access_devices: access_devices (routing, secrets, status) and unclaimed_device_contacts;
 *  - tenant 022_access_device_tables: access_device_details (name, direction, what the device reports;
 *    named so it never reads like the platform `devices` table of the old router) and device_commands
 *    (the queue, with claim_token).
 * Proof per migration: dry-run lists it and writes nothing; apply creates the tables and keys; a re-run
 * is a no-op; the documented rollback works. New tables only, nothing existing changes.
 *
 * Scratch databases `gymsera_test_platform_mig_p029`, `gymsera_test_tenant_mig_022` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');
const { MIGRATIONS, runTenantMigrations } = require('../../src/database/tenant-migration-runner');
const { PROBES, readSnapshot } = require('../../src/database/tenant-schema-baseline');

const PLATFORM_DB = 'gymsera_test_platform_mig_p029';
const TENANT_DB = 'gymsera_test_tenant_mig_022';

const connect = (db) =>
  new Sequelize(db, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
    host: process.env.PLATFORM_DB_HOST || 'localhost',
    port: Number(process.env.PLATFORM_DB_PORT),
    dialect: 'mysql',
    logging: false,
  });

const tablesOf = async (seq) =>
  (await seq.query('SELECT TABLE_NAME AS t, TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()', {
    type: QueryTypes.SELECT,
  })).reduce((acc, r) => ({ ...acc, [r.t]: r.c }), {});

const keysOf = async (seq, table) => {
  const rows = await seq.query(`SHOW INDEX FROM \`${table}\``, { type: QueryTypes.SELECT });
  const out = {};
  for (const r of rows) {
    out[r.Key_name] = out[r.Key_name] || { unique: r.Non_unique === 0, cols: [] };
    out[r.Key_name].cols.push(r.Column_name);
  }
  return out;
};

const seedVersions = async (seq, list, upTo) => {
  await seq.query(
    'CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(191) NOT NULL, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );
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
  await seedVersions(tenant, MIGRATIONS, 21);
});

afterAll(async () => {
  for (const s of [platform, tenant]) if (s) await s.close().catch(() => {});
  const conn = await getAdminConnection();
  for (const db of [PLATFORM_DB, TENANT_DB]) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('platform p029_access_devices', () => {
  const mig = () => PLATFORM_MIGRATIONS.find((m) => m.version === 29);

  test('exists, is new tables only, documents its rollback', () => {
    expect(mig().name).toBe('p029_access_devices');
    expect(String(mig().up)).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|UPDATE|ALTER)\s/i);
    expect(require('fs').readFileSync(require.resolve('../../src/database/platform-migrations'), 'utf8'))
      .toMatch(/ROLLBACK[^\n]*\n[^\n]*DROP TABLE `access_devices`/);
  });

  test('dry-run lists it and writes nothing', async () => {
    const res = await runPlatformMigrations(platform, { targetVersion: 29, dryRun: true });
    expect(res.wouldRun).toEqual(['p029_access_devices']);
    const t = await tablesOf(platform);
    expect(t.access_devices).toBeUndefined();
    expect(t.unclaimed_device_contacts).toBeUndefined();
  });

  test('apply creates both tables with their keys; a re-run is a no-op', async () => {
    expect((await runPlatformMigrations(platform, { targetVersion: 29 })).applied).toEqual(['p029_access_devices']);
    const keys = await keysOf(platform, 'access_devices');
    expect(keys.access_devices_device_key).toEqual({ unique: true, cols: ['device_key'] });
    expect(keys.access_devices_serial_number).toEqual({ unique: true, cols: ['serial_number'] });
    expect(keys.access_devices_tenant_branch).toEqual({ unique: false, cols: ['tenant_id', 'branch_id'] });
    const uk = await keysOf(platform, 'unclaimed_device_contacts');
    expect(uk.unclaimed_device_contacts_contact_hash).toEqual({ unique: true, cols: ['contact_hash'] });
    expect(uk.unclaimed_device_contacts_last_seen_at.cols).toEqual(['last_seen_at']);
    // The old router's tables are not touched.
    expect((await tablesOf(platform)).devices).toBeUndefined();
    expect((await runPlatformMigrations(platform, { targetVersion: 29 })).applied).toEqual([]);
  });

  test('a serial number can be bound to one device only; NULL many times', async () => {
    const row = (id, key, serial) => platform.query(
      `INSERT INTO access_devices (id, device_key, serial_number, tenant_id, branch_id, link_mode, registry_code, session_id, created_at, updated_at)
       VALUES (?, ?, ?, 't', 'b', 'host', 'r', 's', NOW(), NOW())`,
      { replacements: [id, key, serial] }
    );
    await row('1', 'AAAAAAAA', null);
    await row('2', 'BBBBBBBB', null);
    await row('3', 'CCCCCCCC', 'SN1');
    await expect(row('4', 'DDDDDDDD', 'SN1')).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
    await expect(row('5', 'AAAAAAAA', null)).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
    const [d] = await platform.query('SELECT status, token_mode FROM access_devices WHERE id = \'1\'', { type: QueryTypes.SELECT });
    expect(d).toEqual({ status: 'awaiting_connection', token_mode: 'log' });
  });

  test('the documented rollback works', async () => {
    await platform.query('DROP TABLE `unclaimed_device_contacts`');
    await platform.query('DROP TABLE `access_devices`');
    await platform.query('DELETE FROM `schema_migrations` WHERE `version` = 29');
    expect((await runPlatformMigrations(platform, { targetVersion: 29 })).applied).toEqual(['p029_access_devices']);
  });
});

describe('tenant 022_access_device_tables', () => {
  test('exists and has a baseline probe', () => {
    const mig = MIGRATIONS.find((m) => m.version === 22);
    expect(mig.name).toBe('022_access_device_tables');
    expect(typeof PROBES[22]).toBe('function');
  });

  test('dry-run lists it and writes nothing; the probe says missing', async () => {
    const res = await runTenantMigrations(tenant, { targetVersion: 22, dryRun: true });
    expect(res.wouldRun).toEqual(['022_access_device_tables']);
    const t = await tablesOf(tenant);
    expect(t.access_device_details).toBeUndefined();
    expect(t.device_commands).toBeUndefined();
    expect((await PROBES[22](await readSnapshot(tenant), tenant)).state).toBe('missing');
  });

  test('apply creates both tables in the canonical collation, with keys; the probe says present', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 22 })).applied).toEqual(['022_access_device_tables']);
    const t = await tablesOf(tenant);
    expect(t.access_device_details).toBe('utf8mb4_unicode_ci');
    expect(t.device_commands).toBe('utf8mb4_unicode_ci');
    expect(t.devices).toBeUndefined();
    const ck = await keysOf(tenant, 'device_commands');
    expect(ck.device_commands_poll).toEqual({ unique: false, cols: ['device_id', 'status', 'priority', 'id'] });
    expect(ck.device_commands_claim_token.cols).toEqual(['claim_token']);
    expect((await keysOf(tenant, 'access_device_details')).access_device_details_branch_id.cols).toEqual(['branch_id']);
    expect((await PROBES[22](await readSnapshot(tenant), tenant)).state).toBe('present');
  });

  test('command ids start at a random offset of at least 1,000,000 (a moved device never sees an id twice)', async () => {
    await tenant.query(
      'INSERT INTO device_commands (device_id, kind, created_at, updated_at) VALUES (\'d1\', \'info\', NOW(), NOW())'
    );
    const [row] = await tenant.query('SELECT id, status, priority, attempts, not_before FROM device_commands', { type: QueryTypes.SELECT });
    expect(Number(row.id)).toBeGreaterThanOrEqual(1000000);
    expect(row).toMatchObject({ status: 'queued', priority: 5, attempts: 0 });
    expect(row.not_before).toBeTruthy();
  });

  test('a re-run is a no-op; the documented rollback works', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 22 })).applied).toEqual([]);
    await tenant.query('DROP TABLE `device_commands`');
    await tenant.query('DROP TABLE `access_device_details`');
    await tenant.query('DELETE FROM `schema_migrations` WHERE `version` = 22');
    expect((await runTenantMigrations(tenant, { targetVersion: 22 })).applied).toEqual(['022_access_device_tables']);
  });
});
