/**
 * Platform migration p026: `tenant_subscriptions.entitlement_ended_at` (P7c, R-82, NEW-170), when a plan
 * stopped entitling, so a lapsed plan locks branches after the 7-day grace. Proof: dry-run writes nothing;
 * existing rows keep NULL (no backfill: the first capacity pass sets it); a re-run is a no-op; a missing
 * table is skipped.
 *
 * Scratch database: `gymsera_test_platform_mig_p026` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p026';
const P026 = 'p026_tenant_subscriptions_entitlement_ended_at';

describe('Platform migration p026 (tenant_subscriptions.entitlement_ended_at)', () => {
  let seq;

  const columns = async (table) =>
    Object.fromEntries(
      (
        await seq.query(
          'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
          { replacements: [table], type: QueryTypes.SELECT }
        )
      ).map((c) => [c.name, `${c.type} ${c.nullable}`])
    );

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
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 25)) {
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

  test('p026 exists at version 26 and documents backup and rollback', () => {
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 26);
    expect(mig.name).toBe(P026);
    const source = require('fs').readFileSync(require.resolve('../../src/database/platform-migrations'), 'utf8');
    const block = source.slice(source.indexOf(P026));
    expect(block).toMatch(/BACKUP/);
    expect(block).toMatch(/ROLLBACK/);
  });

  test('a database without a tenant_subscriptions table is skipped and recorded', async () => {
    await seq.query('DROP TABLE IF EXISTS tenant_subscriptions');
    const res = await runPlatformMigrations(seq, { targetVersion: 26 });
    expect(res.applied).toEqual([P026]);
    await seq.query('DELETE FROM schema_migrations WHERE version = 26');
  });

  test('dry-run changes nothing; apply adds a nullable entitlement_ended_at and keeps rows (no backfill); re-run is a no-op', async () => {
    await seq.query(
      "CREATE TABLE tenant_subscriptions (id CHAR(36) PRIMARY KEY, status ENUM('ACTIVE','EXPIRED') NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
    );
    await seq.query("INSERT INTO tenant_subscriptions VALUES ('00000000-0000-0000-0000-000000000001', 'EXPIRED', NOW(), NOW())");

    await runPlatformMigrations(seq, { targetVersion: 26, dryRun: true });
    expect((await columns('tenant_subscriptions')).entitlement_ended_at).toBeUndefined();

    const res = await runPlatformMigrations(seq, { targetVersion: 26 });
    expect(res.applied).toEqual([P026]);
    expect((await columns('tenant_subscriptions')).entitlement_ended_at).toBe('datetime YES');
    const rows = await seq.query('SELECT status, entitlement_ended_at AS endedAt FROM tenant_subscriptions', { type: QueryTypes.SELECT });
    expect(rows).toEqual([{ status: 'EXPIRED', endedAt: null }]);

    const again = await runPlatformMigrations(seq, { targetVersion: 26 });
    expect(again.applied).toEqual([]);
  });
});
