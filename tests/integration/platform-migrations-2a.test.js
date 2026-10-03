/**
 * Platform migration added in Prompt 2A (BILL-09): p017 adds the
 * `duplicate_billing` column to `tenant_subscriptions`.
 *
 * Proven like every earlier migration:
 * `--dry-run` writes nothing, a conflicting column makes it skip (not recorded,
 * nothing changed), applying is idempotent and keeps every existing row as is.
 *
 * Scratch database: `gymsera_test_platform_mig_2a` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, PLATFORM_TARGET_VERSION, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_2a';
const P017 = 'p017_tenant_subscriptions_duplicate_billing';

describe('Prompt 2A migration p017 (tenant_subscriptions duplicate_billing)', () => {
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

  const duplicateBillingCol = async () =>
    (await seq.query(
      "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_subscriptions' AND COLUMN_NAME = 'duplicate_billing'",
      { type: QueryTypes.SELECT }
    ))[0];

  const createPlatformDbBefore2A = async () => {
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
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 16)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', {
        replacements: [mig.version, mig.name],
      });
    }
    await seq.query(`
      CREATE TABLE tenant_subscriptions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        tenant_id CHAR(36) NOT NULL,
        package_id CHAR(36) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
        platform VARCHAR(32) NOT NULL DEFAULT 'MANUAL',
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seq.query(`
      INSERT INTO tenant_subscriptions (id, tenant_id, package_id, status, platform, created_at, updated_at) VALUES
        ('11111111-0000-4000-8000-000000000001', 'ten-1', 'pkg-1', 'ACTIVE', 'GOOGLE_PLAY', NOW(), NOW()),
        ('11111111-0000-4000-8000-000000000002', 'ten-1', 'pkg-1', 'EXPIRED', 'APPLE_APP_STORE', NOW(), NOW())
    `);
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

  test('p017 exists at version 17', () => {
    expect(PLATFORM_TARGET_VERSION).toBeGreaterThanOrEqual(17);
    expect(PLATFORM_MIGRATIONS.find((m) => m.version === 17).name).toBe(P017);
  });

  test('--dry-run reports p017 and writes NOTHING', async () => {
    await createPlatformDbBefore2A();
    const before = await snapshot();
    const res = await runPlatformMigrations(seq, { dryRun: true, targetVersion: 17 });
    expect(res.dryRun).toBe(true);
    expect(res.wouldRun).toEqual([P017]);
    expect(await snapshot()).toEqual(before);
  });

  test('a conflicting column (other type) → skipped, not recorded, table unchanged', async () => {
    await createPlatformDbBefore2A();
    await seq.query('ALTER TABLE tenant_subscriptions ADD COLUMN duplicate_billing VARCHAR(20) NULL');
    await seq.query("UPDATE tenant_subscriptions SET duplicate_billing = 'CONFLICT' WHERE id = '11111111-0000-4000-8000-000000000001'");
    const before = await snapshot();

    await runPlatformMigrations(seq, { targetVersion: 17 });

    expect(await snapshot()).toEqual(before);
    const [row] = await seq.query('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 17', { type: QueryTypes.SELECT });
    expect(Number(row.n)).toBe(0);
  });

  test('apply adds duplicate_billing column, keeps existing rows, is recorded; re-run is a no-op', async () => {
    await createPlatformDbBefore2A();
    const rowsBefore = await seq.query('SELECT id, tenant_id, package_id, status, platform FROM tenant_subscriptions ORDER BY id', {
      type: QueryTypes.SELECT,
    });

    const res = await runPlatformMigrations(seq, { targetVersion: 17 });
    expect(res.applied).toEqual([P017]);
    const col = await duplicateBillingCol();
    expect(col.name).toBe('duplicate_billing');
    expect(col.type.toLowerCase()).toBe('tinyint(1)');

    expect(
      await seq.query('SELECT id, tenant_id, package_id, status, platform FROM tenant_subscriptions ORDER BY id', {
        type: QueryTypes.SELECT,
      })
    ).toEqual(rowsBefore);

    const afterApply = await snapshot();
    const again = await runPlatformMigrations(seq, { targetVersion: 17 });
    expect(again.applied).toEqual([]);
    expect(await snapshot()).toEqual(afterApply);
  });

  test('duplicate_billing column added by hand with correct type is recorded without error', async () => {
    await createPlatformDbBefore2A();
    await seq.query('ALTER TABLE tenant_subscriptions ADD COLUMN duplicate_billing TINYINT(1) NULL DEFAULT 0');
    const res = await runPlatformMigrations(seq, { targetVersion: 17 });
    expect(res.applied).toEqual([P017]);
  });
});
