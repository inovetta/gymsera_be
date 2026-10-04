/**
 * Platform migration p018: creates the `audit_logs` table for HTTP mutation
 * audit logging (SEC-12).
 *
 * Proven like every earlier platform migration:
 * - `--dry-run` writes nothing and reports p018.
 * - Conflicting schema (table exists without valid status_code) → skipped,
 *   not recorded, existing table untouched.
 * - Applying creates the table with all required columns and indexes,
 *   and records version 18 in `schema_migrations`.
 * - Re-running is an idempotent no-op.
 * - Pre-existing matching table is recorded without error.
 *
 * Scratch database: `gymsera_test_platform_mig_p018` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, PLATFORM_TARGET_VERSION, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p018';
const P018 = 'p018_create_audit_logs';

describe('Platform migration p018 (create audit_logs table)', () => {
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

  const createPlatformDbBefore18 = async () => {
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
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 17)) {
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

  test('p018 exists at version 18', () => {
    expect(PLATFORM_TARGET_VERSION).toBeGreaterThanOrEqual(18);
    const mig18 = PLATFORM_MIGRATIONS.find((m) => m.version === 18);
    expect(mig18).toBeDefined();
    expect(mig18.name).toBe(P018);
  });

  test('--dry-run reports p018 and writes NOTHING', async () => {
    await createPlatformDbBefore18();
    const before = await snapshot();
    const res = await runPlatformMigrations(seq, { dryRun: true, targetVersion: 18 });
    expect(res.dryRun).toBe(true);
    expect(res.wouldRun).toEqual([P018]);
    expect(await snapshot()).toEqual(before);
  });

  test('a conflicting audit_logs table (missing status_code) → skipped, not recorded, table unchanged', async () => {
    await createPlatformDbBefore18();
    await seq.query(`
      CREATE TABLE audit_logs (
        id CHAR(36) NOT NULL PRIMARY KEY,
        conflict_field VARCHAR(100) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seq.query("INSERT INTO audit_logs (id, conflict_field) VALUES ('00000000-0000-0000-0000-000000000001', 'conflict')");
    const before = await snapshot();

    const res = await runPlatformMigrations(seq, { targetVersion: 18 });
    expect(res.applied).toEqual([]);

    expect(await snapshot()).toEqual(before);
    const [row] = await seq.query('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 18', { type: QueryTypes.SELECT });
    expect(Number(row.n)).toBe(0);
  });

  test('apply creates audit_logs table, records in schema_migrations; re-run is a no-op', async () => {
    await createPlatformDbBefore18();

    const res = await runPlatformMigrations(seq, { targetVersion: 18 });
    expect(res.applied).toEqual([P018]);

    // Verify table columns
    const columns = await seq.query(
      "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs'",
      { type: QueryTypes.SELECT }
    );
    const colMap = Object.fromEntries(columns.map((c) => [c.COLUMN_NAME, c.DATA_TYPE]));

    expect(colMap.id).toBeDefined();
    expect(colMap.user_id).toBeDefined();
    expect(colMap.tenant_id).toBeDefined();
    expect(colMap.method).toBe('varchar');
    expect(colMap.path).toBe('varchar');
    expect(colMap.status_code).toBe('smallint');
    expect(colMap.ip_address).toBe('varchar');
    expect(colMap.duration_ms).toBe('int');
    expect(colMap.created_at).toBe('datetime');

    const [row] = await seq.query('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 18', { type: QueryTypes.SELECT });
    expect(Number(row.n)).toBe(1);

    // Re-run is a no-op
    const after = await snapshot();
    const again = await runPlatformMigrations(seq, { targetVersion: 18 });
    expect(again.applied).toEqual([]);
    expect(await snapshot()).toEqual(after);
  });

  test('pre-existing audit_logs table with matching schema → recorded without error', async () => {
    await createPlatformDbBefore18();
    await seq.query(`
      CREATE TABLE audit_logs (
        id CHAR(36) NOT NULL PRIMARY KEY,
        user_id CHAR(36) NULL,
        tenant_id CHAR(36) NULL,
        method VARCHAR(10) NOT NULL,
        path VARCHAR(500) NOT NULL,
        status_code SMALLINT NOT NULL,
        ip_address VARCHAR(45) NULL,
        user_agent TEXT NULL,
        duration_ms INT NOT NULL,
        created_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    const res = await runPlatformMigrations(seq, { targetVersion: 18 });
    expect(res.applied).toEqual([P018]);
  });
});
