/**
 * Platform migration p032 (NEW-265 Part A, R-108, R-109): area_requests, area_request_links, area_aliases;
 * areas.latitude / longitude / radius_m; tenants and gym_listings area_status / area_request_id.
 * Proof: additive only (new tables and nullable columns; nothing existing is altered, updated, back-filled
 * or deleted); the runner's dry-run writes nothing; apply creates the tables with their keys and the
 * columns with their types; existing rows keep their values; a re-run is a no-op; a column someone added
 * by hand with another type is reported and the migration is not recorded; the documented rollback works.
 *
 * Scratch database: `gymsera_test_platform_mig_p032` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, PLATFORM_TARGET_VERSION, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p032';
const P032 = 'p032_area_requests';
const TABLES = ['area_aliases', 'area_request_links', 'area_requests'];
const NEW_COLUMNS = {
  areas: ['latitude', 'longitude', 'radius_m'],
  tenants: ['area_status', 'area_request_id'],
  gym_listings: ['area_status', 'area_request_id'],
};

describe('Platform migration p032 (area requests)', () => {
  let seq;
  const hasTable = async (name) =>
    (await seq.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', {
      replacements: [name],
      type: QueryTypes.SELECT,
    })).length > 0;
  const columnType = async (table, column) => {
    const [row] = await seq.query(
      'SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      { replacements: [table, column], type: QueryTypes.SELECT }
    );
    return row ? `${String(row.type).toLowerCase().replace(/^int\(11\)$/, 'int')} ${row.nullable === 'YES' ? 'NULL' : 'NOT NULL'}` : null;
  };
  const keysOf = async (table) =>
    [...new Set((await seq.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name <> 'PRIMARY'`, { type: QueryTypes.SELECT }))
      .map((k) => `${k.Key_name}${k.Non_unique ? '' : ' (unique)'}`))].sort();
  const recorded = async () =>
    (await seq.query('SELECT version FROM schema_migrations WHERE version = 32', { type: QueryTypes.SELECT })).length > 0;

  const createExistingTables = async () => {
    // The three existing tables p032 adds columns to, with a row each that must keep its values.
    await seq.query('CREATE TABLE areas (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, city_id INT NOT NULL, name VARCHAR(100) NOT NULL, google_place_id VARCHAR(255) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await seq.query('CREATE TABLE tenants (id CHAR(36) BINARY NOT NULL PRIMARY KEY, city_id INT NULL, area_id INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await seq.query('CREATE TABLE gym_listings (id CHAR(36) BINARY NOT NULL PRIMARY KEY, city_id INT NULL, area_id INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await seq.query('INSERT INTO areas (id, city_id, name, google_place_id) VALUES (7, 3, \'Hayatabad\', \'pl-h\')');
    await seq.query('INSERT INTO tenants (id, city_id, area_id) VALUES (\'t-1\', 3, 7)');
    await seq.query('INSERT INTO gym_listings (id, city_id, area_id) VALUES (\'l-1\', 3, 7)');
  };

  beforeAll(async () => {
    assertTestEnvironmentSafety({ databases: [SCRATCH_DB] });
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await conn.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    seq = new Sequelize(SCRATCH_DB, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
      host: process.env.PLATFORM_TEST_DB_HOST || process.env.PLATFORM_DB_HOST || 'localhost',
      port: Number(process.env.PLATFORM_DB_PORT),
      dialect: 'mysql',
      logging: false,
    });
    await seq.query(
      'CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 31)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', { replacements: [mig.version, mig.name] });
    }
    await createExistingTables();
  });

  afterAll(async () => {
    if (seq) await seq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``).catch(() => {});
    await teardownTestDatabases();
  });

  test('p032 is version 32, additive only, and documents preview, backup and rollback', () => {
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 32);
    expect(mig).toBeDefined();
    expect(mig.name).toBe(P032);
    expect(PLATFORM_TARGET_VERSION).toBeGreaterThanOrEqual(32);
    const body = String(mig.up);
    // New tables and ADD COLUMN only: nothing existing is dropped, rewritten, back-filled or deleted.
    expect(body).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|UPDATE|MODIFY|CHANGE|RENAME)\s/i);
    for (const m of body.matchAll(/ALTER TABLE[^;`]*`?\w+`?\s+(\w+)/gi)) expect(m[1].toUpperCase()).toBe('ADD');
    const source = require('fs').readFileSync(require.resolve('../../src/database/platform-migrations'), 'utf8');
    const block = source.slice(source.indexOf(P032));
    expect(block).toMatch(/PREVIEW/);
    expect(block).toMatch(/BACKUP/);
    expect(block).toMatch(/ROLLBACK/);
    for (const t of TABLES) expect(block).toContain(`DROP TABLE \`${t}\``);
  });

  test('dry-run lists p032 and writes nothing', async () => {
    const res = await runPlatformMigrations(seq, { targetVersion: 32, dryRun: true });
    expect(res.wouldRun).toEqual([P032]);
    for (const t of TABLES) expect(await hasTable(t)).toBe(false);
    for (const [table, cols] of Object.entries(NEW_COLUMNS)) {
      for (const c of cols) expect(await columnType(table, c)).toBeNull();
    }
    expect(await recorded()).toBe(false);
  });

  test('apply creates the three tables with their keys and the nullable columns; existing rows keep their values', async () => {
    const res = await runPlatformMigrations(seq, { targetVersion: 32 });
    expect(res.applied).toEqual([P032]);
    for (const t of TABLES) expect(await hasTable(t)).toBe(true);

    expect(await keysOf('area_requests')).toEqual([
      'area_requests_city_id_status',
      'area_requests_open_key (unique)',
      'area_requests_requested_by_user_id_created_at',
    ]);
    expect(await keysOf('area_request_links')).toEqual([
      'area_request_links_area_request_id',
      'area_request_links_target (unique)',
    ]);
    expect(await keysOf('area_aliases')).toEqual(['area_aliases_area_id', 'area_aliases_city_alias (unique)']);

    expect(await columnType('area_requests', 'name')).toBe('varchar(60) NOT NULL');
    expect(await columnType('area_requests', 'name_key')).toBe('varchar(60) NOT NULL');
    expect(await columnType('area_requests', 'source')).toBe('enum(\'typed\',\'google_road\',\'google_landmark\') NOT NULL');
    expect(await columnType('area_requests', 'status')).toBe('enum(\'pending_review\',\'approved\',\'merged\',\'rejected\') NOT NULL');
    expect(await columnType('area_requests', 'open_key')).toBe('varchar(120) NULL');
    expect(await columnType('area_requests', 'reject_reason')).toBe('varchar(300) NULL');
    expect(await columnType('area_request_links', 'target')).toBe('enum(\'tenant\',\'main_branch\',\'listing\',\'branch\') NOT NULL');
    expect(await columnType('area_request_links', 'propagation_error')).toBe('varchar(300) NULL');

    expect(await columnType('areas', 'latitude')).toBe('decimal(10,8) NULL');
    expect(await columnType('areas', 'longitude')).toBe('decimal(11,8) NULL');
    expect(await columnType('areas', 'radius_m')).toBe('int NULL');
    for (const table of ['tenants', 'gym_listings']) {
      expect(await columnType(table, 'area_status')).toBe('varchar(20) NULL');
      expect(await columnType(table, 'area_request_id')).toBe('int NULL');
    }

    // Nothing back-filled: the existing rows are exactly as they were, new columns NULL.
    const [area] = await seq.query('SELECT * FROM areas WHERE id = 7', { type: QueryTypes.SELECT });
    expect(area).toMatchObject({ city_id: 3, name: 'Hayatabad', google_place_id: 'pl-h', latitude: null, longitude: null, radius_m: null });
    const [tenant] = await seq.query('SELECT * FROM tenants WHERE id = \'t-1\'', { type: QueryTypes.SELECT });
    expect(tenant).toMatchObject({ city_id: 3, area_id: 7, area_status: null, area_request_id: null });
    const [listing] = await seq.query('SELECT * FROM gym_listings WHERE id = \'l-1\'', { type: QueryTypes.SELECT });
    expect(listing).toMatchObject({ city_id: 3, area_id: 7, area_status: null, area_request_id: null });
  });

  test('one open request per person, city and spelling; one request per location', async () => {
    const insert = (openKey) => seq.query(
      'INSERT INTO area_requests (city_id, name, name_key, source, status, open_key, requested_by_user_id, created_at, updated_at) VALUES (3, \'Shinwari Town\', \'shinwaritown\', \'typed\', \'pending_review\', ?, \'u-1\', NOW(), NOW())',
      { replacements: [openKey] }
    );
    await insert('u-1:3:shinwaritown');
    await expect(insert('u-1:3:shinwaritown')).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
    await insert(null);
    await insert(null); // decided requests (open_key NULL) never collide
    const link = () => seq.query('INSERT INTO area_request_links (area_request_id, tenant_id, target, target_id, created_at, updated_at) VALUES (1, \'t-1\', \'branch\', \'b-1\', NOW(), NOW())');
    await link();
    await expect(link()).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
  });

  test('a re-run is a no-op; running the body again changes nothing', async () => {
    const again = await runPlatformMigrations(seq, { targetVersion: 32 });
    expect(again.applied).toEqual([]);
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 32);
    await expect(mig.up(seq)).resolves.toBeNull();
    const [{ n }] = await seq.query('SELECT COUNT(*) AS n FROM area_requests', { type: QueryTypes.SELECT });
    expect(Number(n)).toBe(3);
  });

  test('the documented rollback works, and the migration applies again after it', async () => {
    for (const t of TABLES) await seq.query(`DROP TABLE \`${t}\``);
    await seq.query('ALTER TABLE `areas` DROP COLUMN `latitude`, DROP COLUMN `longitude`, DROP COLUMN `radius_m`');
    await seq.query('ALTER TABLE `tenants` DROP COLUMN `area_status`, DROP COLUMN `area_request_id`');
    await seq.query('ALTER TABLE `gym_listings` DROP COLUMN `area_status`, DROP COLUMN `area_request_id`');
    await seq.query('DELETE FROM `schema_migrations` WHERE `version` = 32');
    for (const t of TABLES) expect(await hasTable(t)).toBe(false);
    expect(await columnType('tenants', 'area_status')).toBeNull();

    const res = await runPlatformMigrations(seq, { targetVersion: 32 });
    expect(res.applied).toEqual([P032]);
    for (const t of TABLES) expect(await hasTable(t)).toBe(true);
    expect(await columnType('gym_listings', 'area_request_id')).toBe('int NULL');
  });

  test('a database without one of the three tables: the other objects are created, nothing fails (older migration tests build such databases)', async () => {
    const conn = await getAdminConnection();
    const db = `${SCRATCH_DB}_min`;
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await conn.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const small = new Sequelize(db, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
      host: process.env.PLATFORM_TEST_DB_HOST || process.env.PLATFORM_DB_HOST || 'localhost',
      port: Number(process.env.PLATFORM_DB_PORT),
      dialect: 'mysql',
      logging: false,
    });
    try {
      await small.query('CREATE TABLE tenants (id CHAR(36) BINARY NOT NULL PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 32);
      await expect(mig.up(small)).resolves.toBeNull();
      const cols = await small.query('SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'tenants\' ORDER BY c', { type: QueryTypes.SELECT });
      expect(cols.map((r) => r.c)).toEqual(['area_request_id', 'area_status', 'id']);
      const tables = await small.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY t', { type: QueryTypes.SELECT });
      expect(tables.map((r) => r.t).sort()).toEqual(['area_aliases', 'area_request_links', 'area_requests', 'tenants']);
    } finally {
      await small.close().catch(() => {});
      await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
    }
  });

  test('a column someone added by hand with another type is reported, left alone, and p032 is not recorded', async () => {
    await seq.query('ALTER TABLE `gym_listings` DROP COLUMN `area_status`');
    await seq.query('ALTER TABLE `gym_listings` ADD COLUMN `area_status` INT NULL');
    await seq.query('DELETE FROM `schema_migrations` WHERE `version` = 32');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await runPlatformMigrations(seq, { targetVersion: 32 });
    warn.mockRestore();
    expect(await recorded()).toBe(false);
    expect(await columnType('gym_listings', 'area_status')).toBe('int NULL');
  });
});
