/**
 * Platform migration p023: `billing_plan_price_checks` (BILL-15). New table only.
 * Proof: dry-run writes nothing; apply creates the table with its unique key; a re-run is a no-op and keeps rows.
 *
 * Scratch database: `gymsera_test_platform_mig_p023` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p023';
const P023 = 'p023_billing_plan_price_checks';

describe('Platform migration p023 (billing_plan_price_checks)', () => {
  let seq;
  const tableExists = async () =>
    (await seq.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_plan_price_checks'", { type: QueryTypes.SELECT })).length === 1;

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
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 22)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', { replacements: [mig.version, mig.name] });
    }
  });

  afterAll(async () => {
    if (seq) await seq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``).catch(() => {});
    await teardownTestDatabases();
  });

  test('p023 exists at version 23 and documents backup and rollback', () => {
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 23);
    expect(mig.name).toBe(P023);
    const source = require('fs').readFileSync(require.resolve('../../src/database/platform-migrations'), 'utf8');
    const block = source.slice(source.indexOf(P023));
    expect(block).toMatch(/BACKUP/);
    expect(block).toMatch(/ROLLBACK/);
  });

  test('dry-run changes nothing; apply creates the table and its unique key; a re-run keeps the rows', async () => {
    await runPlatformMigrations(seq, { targetVersion: 23, dryRun: true });
    expect(await tableExists()).toBe(false);

    const res = await runPlatformMigrations(seq, { targetVersion: 23 });
    expect(res.applied).toEqual([P023]);
    expect(await tableExists()).toBe(true);

    await seq.query("INSERT INTO billing_plan_price_checks (id, billing_plan_id, provider, status, mismatch_count, checked_at) VALUES ('c1', 'p1', 'GOOGLE', 'VERIFIED', 0, NOW())");
    await expect(
      seq.query("INSERT INTO billing_plan_price_checks (id, billing_plan_id, provider, status, mismatch_count, checked_at) VALUES ('c2', 'p1', 'GOOGLE', 'MISMATCH', 1, NOW())")
    ).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });

    await seq.query('DELETE FROM schema_migrations WHERE version = 23');
    const again = await runPlatformMigrations(seq, { targetVersion: 23 });
    expect(again.applied).toEqual([P023]);
    const [row] = await seq.query("SELECT status FROM billing_plan_price_checks WHERE id = 'c1'", { type: QueryTypes.SELECT });
    expect(row.status).toBe('VERIFIED');
  });
});
