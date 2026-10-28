/**
 * Platform migration p024: Google place ids on `cities` / `areas` and a city centre (Phase 7 P3, BUG-01).
 * Proof: dry-run writes nothing; existing rows survive with NULLs (no backfill); the place ids are unique;
 * a re-run is a no-op; a hand-made column of another type is left alone, reported and not recorded.
 *
 * Scratch database: `gymsera_test_platform_mig_p024` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p024';
const P024 = 'p024_city_area_google_place';

describe('Platform migration p024 (cities / areas Google place)', () => {
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
  const uniqueIndex = async (table) =>
    (
      await seq.query(
        'SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = \'google_place_id\'',
        { replacements: [table], type: QueryTypes.SELECT }
      )
    )[0];

  const recreate = async () => {
    await seq.query('DROP TABLE IF EXISTS areas');
    await seq.query('DROP TABLE IF EXISTS cities');
    await seq.query('DELETE FROM schema_migrations WHERE version >= 24');
    await seq.query(
      'CREATE TABLE cities (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, is_active TINYINT(1) DEFAULT 1, image_url VARCHAR(500) NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    await seq.query(
      'CREATE TABLE areas (id INT AUTO_INCREMENT PRIMARY KEY, city_id INT NOT NULL, name VARCHAR(100) NOT NULL, image_url VARCHAR(500) NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    await seq.query("INSERT INTO cities (name, created_at, updated_at) VALUES ('Lahore', NOW(), NOW()), ('Multan', NOW(), NOW())");
    await seq.query("INSERT INTO areas (city_id, name, created_at, updated_at) VALUES (1, 'Gulberg', NOW(), NOW())");
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
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 23)) {
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

  test('p024 exists at version 24 and documents backup and rollback', () => {
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 24);
    expect(mig.name).toBe(P024);
    const source = require('fs').readFileSync(require.resolve('../../src/database/platform-migrations'), 'utf8');
    const block = source.slice(source.indexOf(P024));
    expect(block).toMatch(/BACKUP/);
    expect(block).toMatch(/ROLLBACK/);
  });

  test('dry-run changes nothing; apply adds nullable columns and unique place-id keys, keeps rows; re-run is a no-op', async () => {
    await recreate();

    await runPlatformMigrations(seq, { targetVersion: 24, dryRun: true });
    expect((await columns('cities')).google_place_id).toBeUndefined();

    const res = await runPlatformMigrations(seq, { targetVersion: 24 });
    expect(res.applied).toEqual([P024]);
    expect(await columns('cities')).toMatchObject({
      google_place_id: 'varchar(255) YES',
      latitude: 'decimal(10,8) YES',
      longitude: 'decimal(11,8) YES',
    });
    expect((await columns('areas')).google_place_id).toBe('varchar(255) YES');
    expect(await uniqueIndex('cities')).toEqual({ name: 'cities_google_place_id', nonUnique: 0 });
    expect(await uniqueIndex('areas')).toEqual({ name: 'areas_google_place_id', nonUnique: 0 });

    const rows = await seq.query('SELECT name, google_place_id AS placeId, latitude FROM cities ORDER BY id', { type: QueryTypes.SELECT });
    expect(rows).toEqual([
      { name: 'Lahore', placeId: null, latitude: null },
      { name: 'Multan', placeId: null, latitude: null },
    ]);

    const again = await runPlatformMigrations(seq, { targetVersion: 24 });
    expect(again.applied).toEqual([]);
  });

  test('a hand-made cities.google_place_id of another type is left alone and p024 is not recorded', async () => {
    await recreate();
    await seq.query('ALTER TABLE cities ADD COLUMN google_place_id INT NULL');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runPlatformMigrations(seq, { targetVersion: 24 });
    } finally {
      warn.mockRestore();
    }
    expect((await columns('cities')).google_place_id).toBe('int(11) YES');
    const recorded = await seq.query('SELECT version FROM schema_migrations WHERE version = 24', { type: QueryTypes.SELECT });
    expect(recorded).toEqual([]);
  });
});
