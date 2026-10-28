/**
 * Platform migration p025: `cities.country_code` (P3 device follow-up), so Places autocomplete can stay in
 * the selected city's country. Proof: dry-run writes nothing; existing rows keep NULL (no backfill: NULL
 * means the default country); a re-run is a no-op; a missing cities table is skipped.
 *
 * Scratch database: `gymsera_test_platform_mig_p025` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p025';
const P025 = 'p025_city_country_code';

describe('Platform migration p025 (cities.country_code)', () => {
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
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 24)) {
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

  test('p025 exists at version 25 and documents backup and rollback', () => {
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 25);
    expect(mig.name).toBe(P025);
    const source = require('fs').readFileSync(require.resolve('../../src/database/platform-migrations'), 'utf8');
    const block = source.slice(source.indexOf(P025));
    expect(block).toMatch(/BACKUP/);
    expect(block).toMatch(/ROLLBACK/);
  });

  test('a database without a cities table is skipped and recorded', async () => {
    await seq.query('DROP TABLE IF EXISTS cities');
    const res = await runPlatformMigrations(seq, { targetVersion: 25 });
    expect(res.applied).toEqual([P025]);
    await seq.query('DELETE FROM schema_migrations WHERE version = 25');
  });

  test('dry-run changes nothing; apply adds a nullable country_code and keeps rows; re-run is a no-op', async () => {
    await seq.query(
      'CREATE TABLE cities (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    await seq.query("INSERT INTO cities (name, created_at, updated_at) VALUES ('Peshawar', NOW(), NOW())");

    await runPlatformMigrations(seq, { targetVersion: 25, dryRun: true });
    expect((await columns('cities')).country_code).toBeUndefined();

    const res = await runPlatformMigrations(seq, { targetVersion: 25 });
    expect(res.applied).toEqual([P025]);
    expect((await columns('cities')).country_code).toBe('varchar(2) YES');
    const rows = await seq.query('SELECT name, country_code AS countryCode FROM cities', { type: QueryTypes.SELECT });
    expect(rows).toEqual([{ name: 'Peshawar', countryCode: null }]);

    const again = await runPlatformMigrations(seq, { targetVersion: 25 });
    expect(again.applied).toEqual([]);
  });
});
