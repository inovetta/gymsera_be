/**
 * Platform migration p031 (NEW-256): content_reports, user_blocks, moderation_words (+ starter list).
 * Proof: new tables and their seed rows only (nothing existing is altered or deleted); the runner's
 * dry-run writes nothing; apply creates the three tables with their keys and seeds the starter
 * words; a re-run is a no-op and keeps an admin's edits; the documented rollback works.
 *
 * Scratch database: `gymsera_test_platform_mig_p031` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, PLATFORM_TARGET_VERSION, runPlatformMigrations } = require('../../src/database/platform-migrations');
const { STARTER_WORDS } = require('../../src/constants/moderation');

const SCRATCH_DB = 'gymsera_test_platform_mig_p031';
const P031 = 'p031_content_moderation';
const TABLES = ['content_reports', 'moderation_words', 'user_blocks'];

describe('Platform migration p031 (content moderation)', () => {
  let seq;
  const hasTable = async (name) =>
    (await seq.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', {
      replacements: [name],
      type: QueryTypes.SELECT,
    })).length > 0;
  const keysOf = async (table) =>
    [...new Set((await seq.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name <> 'PRIMARY'`, { type: QueryTypes.SELECT }))
      .map((k) => `${k.Key_name}${k.Non_unique ? '' : ' (unique)'}`))].sort();
  const words = async () =>
    (await seq.query('SELECT word FROM moderation_words ORDER BY word', { type: QueryTypes.SELECT })).map((r) => r.word);

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
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 30)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', { replacements: [mig.version, mig.name] });
    }
  });

  afterAll(async () => {
    if (seq) await seq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``).catch(() => {});
    await teardownTestDatabases();
  });

  test('p031 is version 31, additive only, and documents preview, backup and rollback', () => {
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 31);
    expect(mig.name).toBe(P031);
    expect(PLATFORM_TARGET_VERSION).toBeGreaterThanOrEqual(31);
    // New tables and INSERT IGNORE seed rows only: nothing existing is altered, updated or deleted.
    expect(String(mig.up)).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|UPDATE|ALTER)\s/i);
    const source = require('fs').readFileSync(require.resolve('../../src/database/platform-migrations'), 'utf8');
    const block = source.slice(source.indexOf(P031));
    expect(block).toMatch(/PREVIEW/);
    expect(block).toMatch(/BACKUP/);
    expect(block).toMatch(/ROLLBACK/);
  });

  test('dry-run lists p031 and writes nothing', async () => {
    const res = await runPlatformMigrations(seq, { targetVersion: 31, dryRun: true });
    expect(res.wouldRun).toEqual([P031]);
    for (const t of TABLES) expect(await hasTable(t)).toBe(false);
    const recorded = await seq.query('SELECT version FROM schema_migrations WHERE version = 31', { type: QueryTypes.SELECT });
    expect(recorded).toEqual([]);
  });

  test('apply creates the three tables with their keys and seeds the starter words', async () => {
    const res = await runPlatformMigrations(seq, { targetVersion: 31 });
    expect(res.applied).toEqual([P031]);
    for (const t of TABLES) expect(await hasTable(t)).toBe(true);
    expect(await keysOf('content_reports')).toEqual([
      'content_reports_reporter_target (unique)',
      'content_reports_status_created_at',
      'content_reports_target',
    ]);
    expect(await keysOf('user_blocks')).toEqual(['user_blocks_pair_side (unique)', 'user_blocks_tenant_id']);
    expect(await keysOf('moderation_words')).toEqual(['moderation_words_word (unique)']);
    expect(await words()).toEqual([...STARTER_WORDS].sort());
  });

  test('a re-run is a no-op and keeps an admin\'s edits to the word list', async () => {
    await seq.query('DELETE FROM moderation_words WHERE word = ?', { replacements: [STARTER_WORDS[0]] });
    await seq.query('INSERT INTO moderation_words (id, word, created_at, updated_at) VALUES (UUID(), ?, NOW(), NOW())', { replacements: ['scam'] });
    const again = await runPlatformMigrations(seq, { targetVersion: 31 });
    expect(again.applied).toEqual([]);
    const list = await words();
    expect(list).toContain('scam');
    expect(list).not.toContain(STARTER_WORDS[0]);
  });

  test('running the migration body twice (no tracking row) adds no duplicate words', async () => {
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 31);
    const before = await words();
    await mig.up(seq);
    const after = await words();
    expect(after.length).toBe(new Set(after).size);
    expect(after).toEqual([...new Set([...before, ...STARTER_WORDS])].sort());
  });

  test('the documented rollback works', async () => {
    for (const t of TABLES) await seq.query(`DROP TABLE \`${t}\``);
    await seq.query('DELETE FROM `schema_migrations` WHERE `version` = 31');
    for (const t of TABLES) expect(await hasTable(t)).toBe(false);
    const res = await runPlatformMigrations(seq, { targetVersion: 31 });
    expect(res.applied).toEqual([P031]);
    expect(await words()).toEqual([...STARTER_WORDS].sort());
  });
});
