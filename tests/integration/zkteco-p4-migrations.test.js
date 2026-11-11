/**
 * ZKTeco Phase 4: tenant migration 025_device_import_and_cutover (spec §15 Phase 4).
 * Dry-run lists it and writes nothing; apply creates device_imports, device_import_users,
 * device_import_templates, device_import_packs and the additive columns
 * (access_device_details import_hold / import_hold_since / live_at / gbs_stopped_at,
 * member_biometrics import_id / import_hold); a re-run is a no-op; the documented rollback works;
 * the baseline probe follows. Existing templates are untouched and stay usable (import_hold 0).
 * Scratch database (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { MIGRATIONS, runTenantMigrations } = require('../../src/database/tenant-migration-runner');
const { PROBES, readSnapshot } = require('../../src/database/tenant-schema-baseline');

const TENANT_DB = 'gymsera_test_tenant_mig_025';
const NEW_TABLES = ['device_imports', 'device_import_users', 'device_import_templates', 'device_import_packs'];

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
  (await seq.query('SELECT COLUMN_NAME AS c, COLUMN_DEFAULT AS d, IS_NULLABLE AS n, DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', { replacements: [table], type: QueryTypes.SELECT }))
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
  await runTenantMigrations(tenant, { targetVersion: 24 });
  // A live tenant has a device and a stored template when 025 arrives.
  await tenant.query(`INSERT INTO access_device_details (id, branch_id, name, direction, enabled, created_at, updated_at)
    VALUES ('00000000-0000-4000-8000-000000000001', 'b1', 'Door', 'in', 1, NOW(), NOW())`);
  await tenant.query(`INSERT INTO member_biometrics (id, member_id, bio_type, bio_no, bio_index, major_ver, minor_ver, format, duress, valid, template_enc, key_version,
      template_sha256, template_size, consent_pending, enrolled_at, created_at, updated_at)
    VALUES ('00000000-0000-4000-8000-0000000000b1', 'm1', 9, 0, 0, '40', '1', 0, 0, 1, x'00', 1, REPEAT('a', 64), 10, 0, NOW(), NOW(), NOW())`);
});

afterAll(async () => {
  if (tenant) await tenant.close().catch(() => {});
  const conn = await getAdminConnection();
  await conn.query(`DROP DATABASE IF EXISTS \`${TENANT_DB}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('tenant 025_device_import_and_cutover', () => {
  test('exists, documents its rollback, has a baseline probe', () => {
    const mig = MIGRATIONS.find((m) => m.version === 25);
    expect(mig.name).toBe('025_device_import_and_cutover');
    expect(typeof PROBES[25]).toBe('function');
    const src = require('fs').readFileSync(require.resolve('../../src/database/tenant-migration-runner.js'), 'utf8');
    expect(src).toMatch(/ROLLBACK \(previous build first\): DROP TABLE `device_import_packs`, `device_import_templates`, `device_import_users`, `device_imports`/);
  });

  test('dry-run lists it and writes nothing; the probe says missing', async () => {
    const res = await runTenantMigrations(tenant, { targetVersion: 25, dryRun: true });
    expect(res.wouldRun).toEqual(['025_device_import_and_cutover']);
    const t = await tablesOf(tenant);
    for (const name of NEW_TABLES) expect(t[name]).toBeUndefined();
    expect((await columnsOf(tenant, 'access_device_details')).import_hold).toBeUndefined();
    expect((await columnsOf(tenant, 'member_biometrics')).import_hold).toBeUndefined();
    expect((await PROBES[25](await readSnapshot(tenant), tenant)).state).toBe('missing');
  });

  test('apply: tables in the canonical collation, keys, additive columns; existing rows untouched and usable; probe present', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 25 })).applied).toEqual(['025_device_import_and_cutover']);
    const t = await tablesOf(tenant);
    for (const name of NEW_TABLES) expect(t[name]).toBe('utf8mb4_unicode_ci');
    expect((await keysOf(tenant, 'device_import_users')).PRIMARY.cols).toEqual(['import_id', 'pin']);
    expect((await keysOf(tenant, 'device_import_templates')).device_import_templates_slot).toEqual({ unique: true, cols: ['import_id', 'pin', 'bio_type', 'bio_no', 'bio_index'] });
    expect((await keysOf(tenant, 'device_import_packs')).PRIMARY.cols).toEqual(['import_id', 'cmd_id', 'pack_idx']);
    expect((await keysOf(tenant, 'device_imports')).device_imports_device.cols).toEqual(['device_id', 'started_at']);
    // Staging templates are encrypted like member_biometrics: a blob and its key version, nothing in clear.
    const tpl = await columnsOf(tenant, 'device_import_templates');
    expect(tpl.template_enc.t).toBe('mediumblob');
    expect(tpl.template_enc.n).toBe('YES'); // emptied once applied, rolled back or cancelled
    expect(Object.keys(tpl).some((c) => /^(tmp|template)$/.test(c))).toBe(false);
    const det = await columnsOf(tenant, 'access_device_details');
    expect(det.import_hold).toMatchObject({ d: '0', n: 'NO' });
    expect(Object.keys(det)).toEqual(expect.arrayContaining(['import_hold_since', 'live_at', 'gbs_stopped_at']));
    const bio = await columnsOf(tenant, 'member_biometrics');
    expect(bio.import_hold).toMatchObject({ d: '0', n: 'NO' });
    expect(bio.import_id.n).toBe('YES');
    const [row] = await tenant.query('SELECT import_hold, import_id FROM member_biometrics', { type: QueryTypes.SELECT });
    expect(row).toEqual({ import_hold: 0, import_id: null });
    const [dev] = await tenant.query('SELECT import_hold FROM access_device_details', { type: QueryTypes.SELECT });
    expect(dev.import_hold).toBe(0);
    expect((await PROBES[25](await readSnapshot(tenant), tenant)).state).toBe('present');
  });

  test('a re-run is a no-op; the documented rollback works', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 25 })).applied).toEqual([]);
    await tenant.query('DROP TABLE `device_import_packs`, `device_import_templates`, `device_import_users`, `device_imports`');
    await tenant.query('ALTER TABLE `access_device_details` DROP COLUMN `import_hold`, DROP COLUMN `import_hold_since`, DROP COLUMN `live_at`, DROP COLUMN `gbs_stopped_at`');
    await tenant.query('ALTER TABLE `member_biometrics` DROP INDEX `member_biometrics_import`, DROP COLUMN `import_id`, DROP COLUMN `import_hold`');
    await tenant.query('DELETE FROM `schema_migrations` WHERE `version` = 25');
    expect((await PROBES[25](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 25 })).applied).toEqual(['025_device_import_and_cutover']);
  });
});
