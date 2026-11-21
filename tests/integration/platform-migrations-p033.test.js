/**
 * Platform migration p033 (R-119): gym_listings business KYC and approval, the verified badge (D11) and the
 * held first branch (Q2). Proof: new columns only (nothing existing altered, updated or deleted); dry-run
 * writes nothing; apply adds the columns with their types and defaults; existing rows keep their values
 * and read NOT_SUBMITTED / NULL; a re-run is a no-op; a hand-made column of another type skips the
 * migration (not recorded); the documented rollback works.
 *
 * Scratch database: `gymsera_test_platform_mig_p033` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, PLATFORM_TARGET_VERSION, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p033';
const P033 = 'p033_business_kyc_and_approval';
const EXPECTED = {
  kyc_status: 'enum(\'not_submitted\',\'pending\',\'approved\',\'rejected\') NOT NULL',
  kyc_documents_json: 'json NULL',
  kyc_submitted_at: 'datetime NULL',
  approved_at: 'datetime NULL',
  approved_by: 'char(36) NULL',
  verified_at: 'datetime NULL',
  verified_by: 'char(36) NULL',
  first_branch_data_json: 'json NULL',
};

describe('Platform migration p033 (business KYC, approval, verified badge, held first branch)', () => {
  let seq;
  const columnType = async (column) => {
    const [row] = await seq.query(
      'SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'gym_listings\' AND COLUMN_NAME = ?',
      { replacements: [column], type: QueryTypes.SELECT }
    );
    return row ? `${String(row.type).toLowerCase()} ${row.nullable === 'YES' ? 'NULL' : 'NOT NULL'}` : null;
  };
  const recorded = async () =>
    (await seq.query('SELECT version FROM schema_migrations WHERE version = 33', { type: QueryTypes.SELECT })).length > 0;

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
    await seq.query('CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 32)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', { replacements: [mig.version, mig.name] });
    }
    await seq.query('CREATE TABLE gym_listings (id CHAR(36) BINARY NOT NULL PRIMARY KEY, title VARCHAR(200) NOT NULL, status VARCHAR(20) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await seq.query('INSERT INTO gym_listings (id, title, status) VALUES (\'l-1\', \'Iron house\', \'ACTIVE\')');
  });

  afterAll(async () => {
    if (seq) await seq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``).catch(() => {});
    await teardownTestDatabases();
  });

  test('p033 is version 33 and the target, additive only, and documents preview, backup and rollback', () => {
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 33);
    expect(mig.name).toBe(P033);
    expect(PLATFORM_TARGET_VERSION).toBeGreaterThanOrEqual(33);
    const body = String(mig.up);
    expect(body).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|UPDATE|MODIFY|CHANGE|RENAME)\s/i);
    const source = require('fs').readFileSync(require.resolve('../../src/database/platform-migrations'), 'utf8');
    const block = source.slice(source.indexOf(P033));
    expect(block).toMatch(/PREVIEW/);
    expect(block).toMatch(/BACKUP/);
    expect(block).toMatch(/ROLLBACK/);
    for (const c of Object.keys(EXPECTED)) expect(block).toContain(`DROP COLUMN \`${c}\``);
    expect(block).toContain('DELETE FROM `schema_migrations` WHERE `version` = 33');
  });

  test('a hand-made column of another type skips the migration; nothing written, not recorded', async () => {
    await seq.query('ALTER TABLE gym_listings ADD COLUMN verified_at VARCHAR(20) NULL');
    const res = await runPlatformMigrations(seq, { targetVersion: 33 });
    expect(res.applied || []).not.toContain(P033);
    expect(await recorded()).toBe(false);
    expect(await columnType('kyc_status')).toBeNull();
    await seq.query('ALTER TABLE gym_listings DROP COLUMN verified_at');
  });

  test('dry-run lists p033 and writes nothing', async () => {
    const res = await runPlatformMigrations(seq, { targetVersion: 33, dryRun: true });
    expect(res.wouldRun).toEqual([P033]);
    for (const c of Object.keys(EXPECTED)) expect(await columnType(c)).toBeNull();
    expect(await recorded()).toBe(false);
  });

  test('apply adds every column with its type; the existing row reads NOT_SUBMITTED and NULLs', async () => {
    const res = await runPlatformMigrations(seq, { targetVersion: 33 });
    expect(res.applied).toEqual([P033]);
    for (const [c, t] of Object.entries(EXPECTED)) expect([c, await columnType(c)]).toEqual([c, t]);
    const [row] = await seq.query('SELECT * FROM gym_listings WHERE id = \'l-1\'', { type: QueryTypes.SELECT });
    expect(row).toMatchObject({
      title: 'Iron house', status: 'ACTIVE', kyc_status: 'NOT_SUBMITTED', kyc_documents_json: null,
      approved_at: null, approved_by: null, verified_at: null, verified_by: null, first_branch_data_json: null,
    });
  });

  test('a re-run is a no-op; the documented rollback works and p033 applies again', async () => {
    expect((await runPlatformMigrations(seq, { targetVersion: 33 })).applied).toEqual([]);
    await seq.query(`ALTER TABLE \`gym_listings\` ${Object.keys(EXPECTED).map((c) => `DROP COLUMN \`${c}\``).join(', ')}`);
    await seq.query('DELETE FROM `schema_migrations` WHERE `version` = 33');
    expect((await runPlatformMigrations(seq, { targetVersion: 33 })).applied).toEqual([P033]);
  });
});
