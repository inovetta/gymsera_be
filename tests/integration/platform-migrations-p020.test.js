/**
 * Platform migration p020: adds nullable app_version / locale / timezone to `device_tokens` (RT-01).
 * Proof: dry-run writes nothing; existing rows survive untouched (no backfill); a re-run is a no-op.
 *
 * Scratch database: `gymsera_test_platform_mig_p020` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p020';
const P020 = 'p020_add_device_token_context';

describe('Platform migration p020 (device_tokens context columns)', () => {
  let seq;

  const columns = async () =>
    (
      await seq.query(
        "SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_tokens' ORDER BY ORDINAL_POSITION",
        { type: QueryTypes.SELECT }
      )
    ).map((c) => `${c.COLUMN_NAME}:${c.IS_NULLABLE}`);

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
    await seq.query(
      'CREATE TABLE device_tokens (id CHAR(36) NOT NULL PRIMARY KEY, user_id CHAR(36) NOT NULL, token VARCHAR(500) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    await seq.query("INSERT INTO device_tokens (id, user_id, token) VALUES ('t1', 'u1', 'old-token')");
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 19)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', {
        replacements: [mig.version, mig.name],
      });
    }
  });

  afterAll(async () => {
    if (seq) await seq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``).catch(() => {});
    await teardownTestDatabases();
  });

  test('p020 exists at version 20', () => {
    expect(PLATFORM_MIGRATIONS.find((m) => m.version === 20).name).toBe(P020);
  });

  test('dry-run changes nothing; apply adds nullable columns and keeps rows; re-run is a no-op', async () => {
    const before = await columns();

    await runPlatformMigrations(seq, { targetVersion: 20, dryRun: true });
    expect(await columns()).toEqual(before);

    const res = await runPlatformMigrations(seq, { targetVersion: 20 });
    expect(res.applied).toEqual([P020]);
    expect(await columns()).toEqual(
      expect.arrayContaining(['app_version:YES', 'locale:YES', 'timezone:YES'])
    );
    const [row] = await seq.query("SELECT token, app_version, locale, timezone FROM device_tokens WHERE id = 't1'", {
      type: QueryTypes.SELECT,
    });
    expect(row).toEqual({ token: 'old-token', app_version: null, locale: null, timezone: null });

    const again = await runPlatformMigrations(seq, { targetVersion: 20 });
    expect(again.applied).toEqual([]);
  });
});
