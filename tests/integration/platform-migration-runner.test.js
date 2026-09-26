/**
 * Platform migrations (spec §6.5) — proves, before anyone trusts the flag,
 * that `--dry-run` writes nothing, and that applying is idempotent.
 *
 * Runs against a scratch database `gymsera_test_platform_mig` shaped like a
 * platform DB that predates these migrations — never the harness platform DB
 * and never a live one (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const {
  PLATFORM_MIGRATIONS,
  PLATFORM_TARGET_VERSION,
  runPlatformMigrations,
} = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig';

describe('Platform migration runner', () => {
  let seq;

  const snapshot = async () => {
    const tables = await seq.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      { type: QueryTypes.SELECT }
    );
    const out = {};
    for (const { TABLE_NAME } of tables) {
      const [[ddl]] = await seq.query(`SHOW CREATE TABLE \`${TABLE_NAME}\``);
      const rows = await seq.query(`SELECT * FROM \`${TABLE_NAME}\``, { type: QueryTypes.SELECT });
      out[TABLE_NAME] = { ddl: ddl['Create Table'], rows: JSON.parse(JSON.stringify(rows)) };
    }
    return out;
  };

  beforeAll(async () => {
    assertTestEnvironmentSafety({ databases: [SCRATCH_DB] });
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await conn.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    const host = process.env.PLATFORM_DB_HOST || 'localhost';
    seq = new Sequelize(SCRATCH_DB, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
      host,
      port: Number(process.env.PLATFORM_DB_PORT),
      dialect: 'mysql',
      logging: false,
    });

    // A pre-migration platform DB: the subscription table as production has it
    // today (no REVOKED status, non-unique external id), with one row.
    await seq.query(`
      CREATE TABLE tenant_subscriptions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        tenant_id CHAR(36) NOT NULL,
        platform ENUM('MANUAL','IOS','ANDROID','STRIPE') NOT NULL DEFAULT 'MANUAL',
        external_original_transaction_id VARCHAR(150) NULL,
        status ENUM('ACTIVE','EXPIRED','CANCELLED','PENDING_MIGRATION','PENDING_CANCEL','SCHEDULED') NOT NULL DEFAULT 'ACTIVE',
        INDEX tenant_subscriptions_external_original_transaction_id (external_original_transaction_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seq.query(
      "INSERT INTO tenant_subscriptions (id, tenant_id, platform, external_original_transaction_id, status) VALUES ('s1', 't1', 'IOS', 'orig-1', 'ACTIVE')"
    );
  });

  afterAll(async () => {
    await seq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await teardownTestDatabases();
  });

  test('--dry-run reports what would run and writes NOTHING (schema and rows byte-identical)', async () => {
    const before = await snapshot();

    const result = await runPlatformMigrations(seq, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.initialVersion).toBe(0);
    expect(result.finalVersion).toBe(0);
    expect(result.wouldRun).toEqual(PLATFORM_MIGRATIONS.map((m) => m.name));
    expect(await snapshot()).toEqual(before);
  });

  test('apply runs every migration once; a second run applies nothing and changes nothing', async () => {
    const first = await runPlatformMigrations(seq);
    expect(first.applied).toEqual(PLATFORM_MIGRATIONS.map((m) => m.name));
    expect(first.finalVersion).toBe(PLATFORM_TARGET_VERSION);

    const [billingEvents] = await seq.query("SHOW TABLES LIKE 'billing_events'");
    expect(billingEvents).toHaveLength(1);

    // p002: REVOKED added, the existing row untouched.
    const [[statusCol]] = await seq.query("SHOW COLUMNS FROM tenant_subscriptions LIKE 'status'");
    expect(statusCol.Type).toContain("'REVOKED'");
    const [[row]] = await seq.query("SELECT status FROM tenant_subscriptions WHERE id = 's1'");
    expect(row.status).toBe('ACTIVE');

    const afterFirst = await snapshot();
    const second = await runPlatformMigrations(seq);
    expect(second.applied).toEqual([]);
    expect(second.finalVersion).toBe(PLATFORM_TARGET_VERSION);
    expect(await snapshot()).toEqual(afterFirst);

    const dry = await runPlatformMigrations(seq, { dryRun: true });
    expect(dry.wouldRun).toEqual([]);
  });
});
