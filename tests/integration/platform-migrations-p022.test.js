/**
 * Platform migration p022: nullable `billing_events.tenant_id` + index (OBS-05).
 * Proof: dry-run writes nothing; existing rows survive and are NOT backfilled; a re-run is a
 * no-op; a column someone added by hand with another type is left alone, reported and not recorded.
 *
 * Scratch database: `gymsera_test_platform_mig_p022` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p022';
const P022 = 'p022_billing_events_tenant_id';

describe('Platform migration p022 (billing_events.tenant_id)', () => {
  let seq;

  const column = async () =>
    (
      await seq.query(
        "SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_events' AND COLUMN_NAME = 'tenant_id'",
        { type: QueryTypes.SELECT }
      )
    )[0];
  const indexNames = async () =>
    (
      await seq.query(
        "SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_events'",
        { type: QueryTypes.SELECT }
      )
    ).map((r) => r.name);

  const recreate = async () => {
    await seq.query('DROP TABLE IF EXISTS billing_events');
    await seq.query('DELETE FROM schema_migrations WHERE version >= 22');
    await seq.query(
      "CREATE TABLE billing_events (id CHAR(36) NOT NULL PRIMARY KEY, provider VARCHAR(20) NOT NULL, provider_event_id VARCHAR(191) NOT NULL, status VARCHAR(20) NOT NULL, received_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
    );
    await seq.query(
      "INSERT INTO billing_events (id, provider, provider_event_id, status, received_at) VALUES ('e1', 'APPLE', 'old-1', 'PROCESSED', NOW()), ('e2', 'STRIPE', 'old-2', 'FAILED', NOW())"
    );
  };

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
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 21)) {
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

  test('p022 exists at version 22 and documents backup and rollback', () => {
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 22);
    expect(mig.name).toBe(P022);
    const source = require('fs').readFileSync(require.resolve('../../src/database/platform-migrations'), 'utf8');
    const block = source.slice(source.indexOf(P022));
    expect(block).toMatch(/BACKUP/);
    expect(block).toMatch(/ROLLBACK/);
  });

  test('dry-run changes nothing; apply adds a nullable CHAR(36) and an index, keeps rows, no backfill; re-run is a no-op', async () => {
    await recreate();

    await runPlatformMigrations(seq, { targetVersion: 22, dryRun: true });
    expect(await column()).toBeUndefined();

    const res = await runPlatformMigrations(seq, { targetVersion: 22 });
    expect(res.applied).toEqual([P022]);
    expect(await column()).toEqual({ type: 'char(36)', nullable: 'YES' });
    expect(await indexNames()).toContain('billing_events_tenant_status');

    const rows = await seq.query('SELECT provider_event_id, tenant_id FROM billing_events ORDER BY id', { type: QueryTypes.SELECT });
    expect(rows).toEqual([
      { provider_event_id: 'old-1', tenant_id: null },
      { provider_event_id: 'old-2', tenant_id: null },
    ]);

    const again = await runPlatformMigrations(seq, { targetVersion: 22 });
    expect(again.applied).toEqual([]);
  });

  test('a tenant_id column of another type is left alone, reported, and the migration is not recorded', async () => {
    await recreate();
    await seq.query('ALTER TABLE billing_events ADD COLUMN tenant_id INT NULL');
    await seq.query("UPDATE billing_events SET tenant_id = 7 WHERE id = 'e1'");

    const res = await runPlatformMigrations(seq, { targetVersion: 22 });
    expect(res.applied).not.toContain(P022);
    expect((await column()).type).toMatch(/^int/);
    const [row] = await seq.query("SELECT tenant_id FROM billing_events WHERE id = 'e1'", { type: QueryTypes.SELECT });
    expect(row.tenant_id).toBe(7);
    const [recorded] = await seq.query('SELECT version FROM schema_migrations WHERE version = 22', { type: QueryTypes.SELECT });
    expect(recorded).toBeUndefined();
  });

  test('a database without billing_events is skipped quietly (like the other migrations)', async () => {
    await seq.query('DROP TABLE IF EXISTS billing_events');
    await seq.query('DELETE FROM schema_migrations WHERE version >= 22');
    const res = await runPlatformMigrations(seq, { targetVersion: 22 });
    expect(res.applied).toEqual([P022]);
  });
});
