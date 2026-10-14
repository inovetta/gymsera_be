/**
 * Platform migration p019: creates `billing_plan_prices` (per-currency catalog prices, BILL-11).
 * Same proof as p018: dry-run writes nothing; a conflicting table is skipped (not recorded); apply creates the
 * table and a re-run is a no-op; a matching existing table is recorded without error.
 *
 * Scratch database: `gymsera_test_platform_mig_p019` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, PLATFORM_TARGET_VERSION, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p019';
const P019 = 'p019_create_billing_plan_prices';

describe('Platform migration p019 (create billing_plan_prices)', () => {
  let seq;

  const snapshot = async () => {
    const tables = await seq.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      { type: QueryTypes.SELECT }
    );
    const out = {};
    for (const { TABLE_NAME } of tables) {
      const [[ddl]] = await seq.query(`SHOW CREATE TABLE \`${TABLE_NAME}\``);
      out[TABLE_NAME] = ddl['Create Table'];
    }
    return out;
  };

  const createPlatformDbBefore19 = async () => {
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await conn.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    if (seq) await seq.close().catch(() => {});
    seq = new Sequelize(SCRATCH_DB, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
      host: process.env.PLATFORM_DB_HOST || 'localhost',
      port: Number(process.env.PLATFORM_DB_PORT),
      dialect: 'mysql',
      logging: false,
    });
    await seq.query(`
      CREATE TABLE schema_migrations (
        version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seq.query('CREATE TABLE billing_plans (id CHAR(36) NOT NULL PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 18)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', {
        replacements: [mig.version, mig.name],
      });
    }
  };

  beforeAll(() => {
    assertTestEnvironmentSafety({ databases: [SCRATCH_DB] });
  });

  afterAll(async () => {
    if (seq) await seq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``).catch(() => {});
    await teardownTestDatabases();
  });

  test('p019 exists at version 19', () => {
    expect(PLATFORM_TARGET_VERSION).toBeGreaterThanOrEqual(19);
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 19);
    expect(mig).toBeDefined();
    expect(mig.name).toBe(P019);
  });

  test('--dry-run reports p019 and writes NOTHING', async () => {
    await createPlatformDbBefore19();
    const before = await snapshot();
    const res = await runPlatformMigrations(seq, { dryRun: true, targetVersion: 19 });
    expect(res.dryRun).toBe(true);
    expect(res.wouldRun).toEqual([P019]);
    expect(await snapshot()).toEqual(before);
  });

  test('a conflicting billing_plan_prices table → skipped, not recorded, table unchanged', async () => {
    await createPlatformDbBefore19();
    await seq.query('CREATE TABLE billing_plan_prices (id CHAR(36) NOT NULL PRIMARY KEY, other VARCHAR(10) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    const before = await snapshot();
    const res = await runPlatformMigrations(seq, { targetVersion: 19 });
    expect(res.applied).toEqual([]);
    expect(await snapshot()).toEqual(before);
    const [row] = await seq.query('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 19', { type: QueryTypes.SELECT });
    expect(Number(row.n)).toBe(0);
  });

  test('apply creates the table with a unique (plan, currency) key; re-run is a no-op', async () => {
    await createPlatformDbBefore19();
    const res = await runPlatformMigrations(seq, { targetVersion: 19 });
    expect(res.applied).toEqual([P019]);

    const cols = await seq.query(
      "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_plan_prices'",
      { type: QueryTypes.SELECT }
    );
    const map = Object.fromEntries(cols.map((c) => [c.COLUMN_NAME, c.DATA_TYPE]));
    expect(map.monthly_minor).toBe('bigint');
    expect(map.annual_minor).toBe('bigint');
    expect(map.currency).toBe('varchar');
    expect(map.stripe_monthly_price_id).toBe('varchar');

    await seq.query("INSERT INTO billing_plan_prices (id, billing_plan_id, currency, monthly_minor, annual_minor, created_at, updated_at) VALUES ('a', 'p1', 'USD', 999, 9999, NOW(), NOW())");
    await expect(
      seq.query("INSERT INTO billing_plan_prices (id, billing_plan_id, currency, monthly_minor, annual_minor, created_at, updated_at) VALUES ('b', 'p1', 'USD', 1, 1, NOW(), NOW())")
    ).rejects.toThrow();

    const after = await snapshot();
    const again = await runPlatformMigrations(seq, { targetVersion: 19 });
    expect(again.applied).toEqual([]);
    expect(await snapshot()).toEqual(after);
  });

  test('a pre-existing table with the same shape is recorded without error', async () => {
    await createPlatformDbBefore19();
    await seq.query(`CREATE TABLE billing_plan_prices (
      id CHAR(36) NOT NULL PRIMARY KEY, billing_plan_id CHAR(36) NOT NULL, currency VARCHAR(3) NOT NULL,
      monthly_minor BIGINT NOT NULL, annual_minor BIGINT NOT NULL,
      stripe_monthly_price_id VARCHAR(150) NULL, stripe_annual_price_id VARCHAR(150) NULL,
      created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const res = await runPlatformMigrations(seq, { targetVersion: 19 });
    expect(res.applied).toEqual([P019]);
  });
});
