/**
 * Platform migration p021: nullable `messages.client_message_id` + UNIQUE
 * (conversation_id, sender_id, client_message_id) (RT-05).
 * Proof: dry-run writes nothing; existing rows survive (no backfill, all NULL);
 * a re-run is a no-op; an unrelated pre-existing column of the same name with
 * another shape is skipped, not overwritten.
 *
 * Scratch database: `gymsera_test_platform_mig_p021` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_p021';
const P021 = 'p021_add_message_client_message_id';

describe('Platform migration p021 (messages.client_message_id)', () => {
  let seq;

  const q = (sql, replacements) => seq.query(sql, { type: QueryTypes.SELECT, replacements });
  const shape = async () => ({
    cols: (await q("SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' ORDER BY ORDINAL_POSITION")).map((c) => `${c.COLUMN_NAME}:${c.IS_NULLABLE}`),
    idx: (await q("SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' ORDER BY INDEX_NAME")).map((i) => i.INDEX_NAME),
  });

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
    await seq.query('CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await seq.query('CREATE TABLE messages (id CHAR(36) NOT NULL PRIMARY KEY, conversation_id CHAR(36) NOT NULL, sender_id CHAR(36) NULL, text TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await seq.query("INSERT INTO messages (id, conversation_id, sender_id, text) VALUES ('m1','c1','u1','old'), ('m2','c1','u1','old2')");
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 20)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', { replacements: [mig.version, mig.name] });
    }
  });

  afterAll(async () => {
    if (seq) await seq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``).catch(() => {});
    await teardownTestDatabases();
  });

  test('p021 exists at version 21', () => {
    expect(PLATFORM_MIGRATIONS.find((m) => m.version === 21).name).toBe(P021);
  });

  test('dry-run changes nothing; apply adds nullable column + unique key and keeps rows; re-run is a no-op', async () => {
    const before = await shape();

    await runPlatformMigrations(seq, { targetVersion: 21, dryRun: true });
    expect(await shape()).toEqual(before);

    const res = await runPlatformMigrations(seq, { targetVersion: 21 });
    expect(res.applied).toEqual([P021]);
    const after = await shape();
    expect(after.cols).toContain('client_message_id:YES');
    expect(after.idx).toContain('messages_conversation_sender_client_msg');

    const rows = await q('SELECT id, client_message_id FROM messages ORDER BY id');
    expect(rows).toEqual([{ id: 'm1', client_message_id: null }, { id: 'm2', client_message_id: null }]);

    const again = await runPlatformMigrations(seq, { targetVersion: 21 });
    expect(again.applied).toEqual([]);
  });

  test('NULL keys never collide, equal keys do', async () => {
    await seq.query("INSERT INTO messages (id, conversation_id, sender_id, text) VALUES ('m3','c1','u1','x'), ('m4','c1','u1','y')");
    await seq.query("INSERT INTO messages (id, conversation_id, sender_id, text, client_message_id) VALUES ('m5','c1','u1','z','k')");
    await expect(
      seq.query("INSERT INTO messages (id, conversation_id, sender_id, text, client_message_id) VALUES ('m6','c1','u1','z','k')")
    ).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
  });
});
