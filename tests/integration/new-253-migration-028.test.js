/**
 * NEW-253 (R-103): tenant migration 028_refund_policy_and_requests adds gyms.refunds_allowed (default 0, so no
 * behaviour change) and gyms.refund_window_days (NULL), and creates refund_requests (one per subscription).
 * Dry-run writes nothing; apply adds them and keeps existing gyms rows; a re-run is a no-op; the documented
 * rollback works; the baseline probe follows. Scratch database (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { MIGRATIONS, runTenantMigrations } = require('../../src/database/tenant-migration-runner');
const { PROBES, readSnapshot } = require('../../src/database/tenant-schema-baseline');

const TENANT_DB = 'gymsera_test_tenant_mig_028';

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
  await tenant.query("INSERT INTO gyms (id, name) VALUES ('00000000-0000-4000-8000-000000000028', 'Existing Gym')");
  await runTenantMigrations(tenant, { targetVersion: 27 });
});

afterAll(async () => {
  if (tenant) await tenant.close().catch(() => {});
  const conn = await getAdminConnection();
  await conn.query(`DROP DATABASE IF EXISTS \`${TENANT_DB}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('tenant 028_refund_policy_and_requests', () => {
  test('exists, documents its rollback, has a probe', () => {
    expect(MIGRATIONS.find((m) => m.version === 28).name).toBe('028_refund_policy_and_requests');
    expect(typeof PROBES[28]).toBe('function');
    const src = require('fs').readFileSync(require.resolve('../../src/database/tenant-migration-runner.js'), 'utf8');
    expect(src).toMatch(/DROP TABLE `refund_requests`/);
    expect(src).toMatch(/ALTER TABLE `gyms` DROP COLUMN `refund_window_days`, DROP COLUMN `refunds_allowed`/);
    expect(src).toMatch(/DELETE FROM `schema_migrations` WHERE `version` = 28/);
  });

  test('dry-run writes nothing; apply adds the columns (existing gym: refunds off, no window) and the table', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 28, dryRun: true })).wouldRun).toEqual(['028_refund_policy_and_requests']);
    expect((await columnsOf(tenant, 'gyms')).refunds_allowed).toBeUndefined();
    expect((await PROBES[28](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 28 })).applied).toEqual(['028_refund_policy_and_requests']);
    const gyms = await columnsOf(tenant, 'gyms');
    expect(gyms.refunds_allowed).toMatchObject({ n: 'NO', t: 'tinyint' });
    expect(gyms.refund_window_days).toMatchObject({ n: 'YES', t: 'smallint' });
    const [row] = await tenant.query('SELECT name, refunds_allowed, refund_window_days FROM gyms', { type: QueryTypes.SELECT });
    expect(row).toEqual({ name: 'Existing Gym', refunds_allowed: 0, refund_window_days: null });
    const cols = await columnsOf(tenant, 'refund_requests');
    expect(Object.keys(cols).sort()).toEqual([
      'approved_amount', 'branch_id', 'created_at', 'currency', 'decided_at', 'decided_by', 'decision_reason', 'id',
      'ledger_adjustment_id', 'payment_id', 'reason', 'status', 'subscription_id', 'suggested_amount', 'updated_at', 'user_id',
    ]);
    expect(cols.subscription_id).toMatchObject({ n: 'NO', k: 'UNI' });
    expect((await PROBES[28](await readSnapshot(tenant), tenant)).state).toBe('present');
  });

  test('one request per subscription is enforced by the database', async () => {
    const insert = (id) => tenant.query(
      "INSERT INTO refund_requests (id, subscription_id, payment_id, user_id, branch_id, currency, suggested_amount, created_at, updated_at) VALUES (?, 'sub-1', 'pay-1', 'usr-1', 'br-1', 'PKR', 10.00, NOW(), NOW())",
      { replacements: [id] }
    );
    await insert('r-1');
    await expect(insert('r-2')).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
    await tenant.query('DELETE FROM refund_requests');
  });

  test('a re-run is a no-op; the documented rollback works', async () => {
    expect((await runTenantMigrations(tenant, { targetVersion: 28 })).applied).toEqual([]);
    await tenant.query('DROP TABLE `refund_requests`');
    await tenant.query('ALTER TABLE `gyms` DROP COLUMN `refund_window_days`, DROP COLUMN `refunds_allowed`');
    await tenant.query('DELETE FROM `schema_migrations` WHERE `version` = 28');
    expect((await PROBES[28](await readSnapshot(tenant), tenant)).state).toBe('missing');
    expect((await runTenantMigrations(tenant, { targetVersion: 28 })).applied).toEqual(['028_refund_policy_and_requests']);
  });
});
