/**
 * Platform migration p028 (P9c item D, R-95): plan_payment_requests — a new table only.
 * Proof: the runner's dry-run writes nothing; apply creates the table with its keys; a re-run is a
 * no-op; the documented rollback (DROP TABLE) works on what apply created.
 *
 * Scratch database: `gymsera_test_platform_mig_p028` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, PLATFORM_TARGET_VERSION, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p028';
const P028 = 'p028_plan_payment_requests';

describe('Platform migration p028 (plan_payment_requests)', () => {
  let seq;
  const hasTable = async (name) =>
    (await seq.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', {
      replacements: [name],
      type: QueryTypes.SELECT,
    })).length > 0;

  beforeAll(async () => {
    assertTestEnvironmentSafety({ databases: [SCRATCH_DB] });
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await conn.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    seq = new Sequelize(SCRATCH_DB, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
      host: process.env.PLATFORM_DB_HOST || 'localhost',
      port: Number(process.env.PLATFORM_DB_PORT),
      dialect: 'mysql',
      logging: false,
    });
    await seq.query(
      'CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 27)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', { replacements: [mig.version, mig.name] });
    }
  });

  afterAll(async () => {
    if (seq) await seq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``).catch(() => {});
    await teardownTestDatabases();
  });

  test('p028 is the latest migration and documents its rollback', () => {
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 28);
    expect(mig.name).toBe(P028);
    expect(PLATFORM_TARGET_VERSION).toBeGreaterThanOrEqual(28);
    expect(String(mig.up)).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|UPDATE|ALTER)\s/i); // a new table only
  });

  test('dry-run lists p028 and writes nothing', async () => {
    const res = await runPlatformMigrations(seq, { targetVersion: 28, dryRun: true });
    expect(res.wouldRun).toEqual([P028]);
    expect(await hasTable('plan_payment_requests')).toBe(false);
  });

  test('apply creates the table with its keys; a re-run is a no-op', async () => {
    const res = await runPlatformMigrations(seq, { targetVersion: 28 });
    expect(res.applied).toEqual([P028]);
    expect(await hasTable('plan_payment_requests')).toBe(true);
    const keys = await seq.query("SHOW INDEX FROM plan_payment_requests WHERE Key_name <> 'PRIMARY'", { type: QueryTypes.SELECT });
    expect([...new Set(keys.map((k) => k.Key_name))].sort()).toEqual([
      'plan_payment_requests_status_created_at',
      'plan_payment_requests_tenant_id_status',
    ]);
    const again = await runPlatformMigrations(seq, { targetVersion: 28 });
    expect(again.applied).toEqual([]);
  });

  test('the documented rollback works', async () => {
    await seq.query('DROP TABLE `plan_payment_requests`');
    await seq.query('DELETE FROM `schema_migrations` WHERE `version` = 28');
    expect(await hasTable('plan_payment_requests')).toBe(false);
    const res = await runPlatformMigrations(seq, { targetVersion: 28 });
    expect(res.applied).toEqual([P028]);
  });
});
