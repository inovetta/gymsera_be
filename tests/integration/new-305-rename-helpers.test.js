/**
 * NEW-305 (R-120): rename helpers for the naming migrations (docs/NAMING_AND_DATA_DICTIONARY.md §3.4).
 * Proven on MySQL 5.7 against a scratch database (never the harness DBs, never a live one; R-19):
 * the four states, definitions restated exactly, foreign keys surviving, INPLACE, dry run, re-runs.
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const h = require('../../src/database/rename-helpers');

const SCRATCH_DB = 'gymsera_test_new305';

describe('NEW-305 rename helpers (MySQL 5.7)', () => {
  let seq;

  const fresh = async () => {
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
    await seq.query(`CREATE TABLE parents (
      id CHAR(36) BINARY NOT NULL PRIMARY KEY, title VARCHAR(200) NOT NULL DEFAULT 'x'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await seq.query(`CREATE TABLE children (
      id CHAR(36) BINARY NOT NULL PRIMARY KEY,
      gym_id CHAR(36) BINARY NOT NULL COMMENT 'old comment',
      n INT NOT NULL DEFAULT 0,
      flag TINYINT(1) NOT NULL DEFAULT 0,
      price DECIMAL(10,2) NULL,
      at DATETIME NULL,
      made DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      doc JSON NULL,
      note TEXT NULL,
      kind ENUM('ORG_DELETED','SLOT') NOT NULL DEFAULT 'SLOT',
      KEY children_gym_id (gym_id),
      CONSTRAINT children_ibfk_1 FOREIGN KEY (gym_id) REFERENCES parents (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await seq.query('INSERT INTO parents (id, title) VALUES (\'p1\', \'Iron House\')');
    await seq.query('INSERT INTO children (id, gym_id, n, kind) VALUES (\'c1\', \'p1\', 7, \'ORG_DELETED\')');
  };

  const ddl = async (table) => (await seq.query(`SHOW CREATE TABLE \`${table}\``, { type: QueryTypes.SELECT }))[0]['Create Table'];
  const colLine = async (table, col) => (await ddl(table)).split('\n').find((l) => l.trim().startsWith(`\`${col}\``)).trim();
  const fks = async (table) =>
    seq.query(
      'SELECT CONSTRAINT_NAME n, COLUMN_NAME c, REFERENCED_TABLE_NAME t FROM information_schema.KEY_COLUMN_USAGE ' +
        'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL',
      { replacements: [table], type: QueryTypes.SELECT }
    );

  beforeAll(() => {
    assertTestEnvironmentSafety({ databases: [SCRATCH_DB] });
  });

  afterAll(async () => {
    await seq?.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await teardownTestDatabases();
  });

  describe('renameColumn', () => {
    beforeEach(fresh);

    it('renames a CHAR(36) BINARY foreign-key column in place: data, collation, FK and index kept; comment set', async () => {
      const before = await colLine('children', 'gym_id');
      const r = await h.renameColumn(seq, { table: 'children', from: 'gym_id', to: 'business_id', comment: 'The business.' });
      expect(r.statements).toHaveLength(1);
      expect(r.statements[0]).toMatch(/ALGORITHM=INPLACE, LOCK=NONE$/);
      const after = await colLine('children', 'business_id');
      expect(after.replace('business_id', 'gym_id').replace('COMMENT \'The business.\'', 'COMMENT \'old comment\'')).toBe(before);
      expect(await fks('children')).toEqual([{ n: 'children_ibfk_1', c: 'business_id', t: 'parents' }]);
      expect(await ddl('children')).toMatch(/KEY `children_gym_id` \(`business_id`\)/);
      const [row] = await seq.query('SELECT business_id FROM children', { type: QueryTypes.SELECT });
      expect(row.business_id).toBe('p1');
      // The FK still enforces.
      await expect(seq.query('INSERT INTO children (id, business_id) VALUES (\'c2\', \'nope\')')).rejects.toThrow(/foreign key/i);
    });

    it('keeps every definition exactly (int default, bool, decimal, datetime, CURRENT_TIMESTAMP, json, text, enum)', async () => {
      for (const col of ['n', 'flag', 'price', 'at', 'made', 'doc', 'note', 'kind']) {
        const before = await colLine('children', col);
        await h.renameColumn(seq, { table: 'children', from: col, to: `${col}_new` });
        expect((await colLine('children', `${col}_new`)).replace(`${col}_new`, col)).toBe(before);
      }
    });

    it('is a no-op when only the new name exists, and on a re-run', async () => {
      await h.renameColumn(seq, { table: 'children', from: 'gym_id', to: 'business_id' });
      const again = await h.renameColumn(seq, { table: 'children', from: 'gym_id', to: 'business_id' });
      expect(again).toEqual({ statements: [] });
      expect(await h.renameColumn(seq, { table: 'missing_table', from: 'a', to: 'b' })).toEqual({ statements: [] });
    });

    it('drops an empty copy of the new column (sync booted first), then renames', async () => {
      await seq.query('ALTER TABLE children ADD COLUMN n_new INT NULL');
      const r = await h.renameColumn(seq, { table: 'children', from: 'n', to: 'n_new' });
      expect(r.statements[0]).toMatch(/DROP COLUMN `n_new`/);
      const [row] = await seq.query('SELECT n_new FROM children', { type: QueryTypes.SELECT });
      expect(row.n_new).toBe(7);
      expect(await h.columnInfo(seq, 'children', 'n')).toBeNull();
    });

    it('changes nothing when both columns hold data', async () => {
      await seq.query('ALTER TABLE children ADD COLUMN n_new INT NULL');
      await seq.query('UPDATE children SET n_new = 1');
      const before = await ddl('children');
      const r = await h.renameColumn(seq, { table: 'children', from: 'n', to: 'n_new' });
      expect(r.skipped).toEqual({ reason: 'both_columns_have_data', table: 'children', from: 'n', to: 'n_new' });
      expect(await ddl('children')).toBe(before);
    });

    it('dry run returns the statements and writes nothing', async () => {
      const before = await ddl('children');
      const r = await h.renameColumn(seq, { table: 'children', from: 'gym_id', to: 'business_id', dryRun: true });
      expect(r.statements).toHaveLength(1);
      expect(await ddl('children')).toBe(before);
    });
  });

  describe('renameTable, renameIndex, dropColumn', () => {
    beforeEach(fresh);

    it('renames a referenced table; the child FK follows; comment set; re-run is a no-op', async () => {
      const r = await h.renameTable(seq, { from: 'parents', to: 'businesses', comment: 'One row per business.' });
      expect(r.statements[0]).toBe('RENAME TABLE `parents` TO `businesses`');
      expect(await fks('children')).toEqual([{ n: 'children_ibfk_1', c: 'gym_id', t: 'businesses' }]);
      expect(await ddl('businesses')).toMatch(/COMMENT='One row per business.'/);
      expect(await h.renameTable(seq, { from: 'parents', to: 'businesses' })).toEqual({ statements: [] });
    });

    it('drops an empty copy of the new table first; refuses when both have rows', async () => {
      await seq.query('CREATE TABLE businesses (id CHAR(36) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
      const r = await h.renameTable(seq, { from: 'parents', to: 'businesses' });
      expect(r.statements).toEqual(['DROP TABLE `businesses`', 'RENAME TABLE `parents` TO `businesses`']);
      expect(await h.tableExists(seq, 'parents')).toBe(false);

      await seq.query('CREATE TABLE a (id INT PRIMARY KEY) ENGINE=InnoDB');
      await seq.query('CREATE TABLE b (id INT PRIMARY KEY) ENGINE=InnoDB');
      await seq.query('INSERT INTO a VALUES (1)');
      await seq.query('INSERT INTO b VALUES (2)');
      const s = await h.renameTable(seq, { from: 'a', to: 'b' });
      expect(s.skipped).toEqual({ reason: 'both_tables_have_data', from: 'a', to: 'b' });
      expect(await h.tableExists(seq, 'a')).toBe(true);
    });

    it('renames an index; drops the old-named duplicate when both exist; no-op when gone', async () => {
      await h.renameIndex(seq, { table: 'children', from: 'children_gym_id', to: 'children_business_id' });
      expect(await h.indexExists(seq, 'children', 'children_business_id')).toBe(true);
      expect(await h.renameIndex(seq, { table: 'children', from: 'children_gym_id', to: 'children_business_id' })).toEqual({ statements: [] });
      await seq.query('ALTER TABLE children ADD INDEX children_dup (gym_id)');
      await h.renameIndex(seq, { table: 'children', from: 'children_dup', to: 'children_business_id' });
      expect(await h.indexExists(seq, 'children', 'children_dup')).toBe(false);
    });

    it('drops a foreign-key column (FK first); re-run is a no-op', async () => {
      const r = await h.dropColumn(seq, { table: 'children', column: 'gym_id' });
      expect(r.statements).toEqual([
        'ALTER TABLE `children` DROP FOREIGN KEY `children_ibfk_1`',
        'ALTER TABLE `children` DROP COLUMN `gym_id`, ALGORITHM=INPLACE, LOCK=NONE',
      ]);
      expect(await h.columnInfo(seq, 'children', 'gym_id')).toBeNull();
      expect(await h.dropColumn(seq, { table: 'children', column: 'gym_id' })).toEqual({ statements: [] });
    });
  });

  describe('renameEnumValues, applyAll', () => {
    beforeEach(fresh);

    it('renames stored values, keeps NOT NULL and maps the default; re-run is a no-op', async () => {
      await seq.query('ALTER TABLE children MODIFY COLUMN kind ENUM(\'ORG_DELETED\',\'SLOT\') NOT NULL DEFAULT \'ORG_DELETED\'');
      const args = { table: 'children', column: 'kind', rename: { ORG_DELETED: 'BUSINESS_DELETED' }, values: ['BUSINESS_DELETED', 'SLOT'] };
      await h.renameEnumValues(seq, args);
      expect(await colLine('children', 'kind')).toBe('`kind` enum(\'BUSINESS_DELETED\',\'SLOT\') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT \'BUSINESS_DELETED\',');
      const [row] = await seq.query('SELECT kind FROM children', { type: QueryTypes.SELECT });
      expect(row.kind).toBe('BUSINESS_DELETED');
      expect(await h.renameEnumValues(seq, args)).toEqual({ statements: [] });
    });

    it('refuses when a row holds a value it does not know', async () => {
      const before = await ddl('children');
      const r = await h.renameEnumValues(seq, { table: 'children', column: 'kind', rename: {}, values: ['SLOT'] });
      expect(r.skipped).toEqual({ reason: 'unknown_enum_values', table: 'children', column: 'kind', unknown: ['ORG_DELETED'] });
      expect(await ddl('children')).toBe(before);
    });

    it('applyAll runs steps in order and collects skips', async () => {
      const out = await h.applyAll(seq, [
        [h.renameTable, { from: 'parents', to: 'businesses' }],
        [h.renameColumn, { table: 'children', from: 'gym_id', to: 'business_id' }],
        [h.renameIndex, { table: 'children', from: 'children_gym_id', to: 'children_business_id' }],
      ]);
      expect(out.skipped).toEqual([]);
      expect(out.statements).toHaveLength(3);
      const again = await h.applyAll(seq, [[h.renameTable, { from: 'parents', to: 'businesses' }]]);
      expect(again.statements).toEqual([]);
    });
  });
});
