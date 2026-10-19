/**
 * OBS-04 — in-app slow query log, a fallback for hosting where MySQL's own slow_query_log cannot be
 * switched on (spec §12.12, runbook docs/runbooks/slow-queries.md).
 *
 * OFF unless SLOW_QUERY_MS is a positive integer. When on, a query slower than that many milliseconds
 * is logged once per fingerprint per 10 s as: statement SHAPE (every literal replaced by ?), duration,
 * threshold. Never a value: Sequelize hands the logger the SQL with the parameters already substituted,
 * so e-mails, phone numbers, ids and tokens would otherwise end up in the log.
 */
const { Sequelize } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const TenantDbManager = require('../../src/database/TenantDbManager');
const { out } = require('../../src/utils/logger');
const slowQuery = require('../../src/database/slow-query');

let lines;
let dbHarness;
const logged = () => lines.map((l) => JSON.parse(l)).filter((l) => l.source === 'slow-query');

const platformSequelize = (options = {}) => {
  const { host, port, database, username, password } = require('../../src/config/database.config').platform;
  return new Sequelize(database, username, password, { host, port, dialect: 'mysql', logging: false, ...options });
};

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
});
afterAll(async () => {
  await TenantDbManager.releaseAll();
  await teardownTestDatabases();
});
beforeEach(() => {
  delete process.env.SLOW_QUERY_MS;
  slowQuery._resetForTests();
  lines = [];
  jest.spyOn(out, 'write').mockImplementation((line) => {
    lines.push(line);
  });
});
afterEach(() => {
  delete process.env.SLOW_QUERY_MS;
  jest.restoreAllMocks();
});

describe('OBS-04: switched off unless SLOW_QUERY_MS is a positive integer', () => {
  test.each([[undefined], [''], ['  '], ['0'], ['-5'], ['abc'], ['1.5'], ['200ms'], ['9999999999']])(
    'SLOW_QUERY_MS=%p: no threshold, no options, nothing logged',
    async (raw) => {
      if (raw === undefined) delete process.env.SLOW_QUERY_MS;
      else process.env.SLOW_QUERY_MS = raw;
      expect(slowQuery.thresholdMs()).toBeNull();
      expect(slowQuery.slowQueryOptions({ db: 'platform' })).toEqual({});
      const seq = platformSequelize(slowQuery.slowQueryOptions({ db: 'platform' }));
      try {
        await seq.query('SELECT SLEEP(0.1)');
      } finally {
        await seq.close();
      }
      expect(logged()).toHaveLength(0);
    }
  );

  test('a valid value turns it on', () => {
    process.env.SLOW_QUERY_MS = '200';
    expect(slowQuery.thresholdMs()).toBe(200);
    expect(slowQuery.slowQueryOptions({ db: 'platform' })).toMatchObject({ benchmark: true });
  });

  test('the existing development logging is kept when it is on', async () => {
    process.env.SLOW_QUERY_MS = '5000';
    const existing = jest.fn();
    const seq = platformSequelize(slowQuery.slowQueryOptions({ db: 'platform', existingLogging: existing }));
    try {
      await seq.query('SELECT 1');
    } finally {
      await seq.close();
    }
    expect(existing).toHaveBeenCalled();
    expect(logged()).toHaveLength(0); // fast query: nothing slow logged
  });
});

describe('OBS-04: slow queries are logged by shape and duration', () => {
  test('a query over the threshold is logged; a fast one is not', async () => {
    process.env.SLOW_QUERY_MS = '60';
    const seq = platformSequelize(slowQuery.slowQueryOptions({ db: 'platform' }));
    try {
      await seq.query('SELECT 1');
      await seq.query('SELECT SLEEP(0.15)');
    } finally {
      await seq.close();
    }
    const rows = logged();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 'warn', db: 'platform', thresholdMs: 60, msg: 'slow query' });
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(100);
    expect(rows[0].shape).toBe('SELECT SLEEP(?)');
    expect(rows[0].fingerprint).toMatch(/^[0-9a-f]{10}$/);
  });

  test('no value from the statement reaches the log: e-mail, phone, CNIC, token, ids, lists', async () => {
    process.env.SLOW_QUERY_MS = '30';
    const seq = platformSequelize(slowQuery.slowQueryOptions({ db: 'platform' }));
    try {
      await seq.query(
        'SELECT SLEEP(0.1) AS s FROM DUAL WHERE :email = :email AND :phone = :phone AND :cnic = :cnic AND :tok = :tok AND :id IN (:ids)',
        {
          replacements: {
            email: 'jane.doe@example.test',
            phone: '+923001112223',
            cnic: '35202-1234567-1',
            tok: 'secret-token-abc123',
            id: 987654,
            ids: [11, 22, 987654],
          },
        }
      );
    } finally {
      await seq.close();
    }
    const text = lines.join('\n');
    expect(logged()).toHaveLength(1);
    for (const leaked of ['jane.doe', 'example.test', '+923001112223', '3001112223', '35202', '1234567', 'secret-token', 'abc123', '987654', '11, 22']) {
      expect(text).not.toContain(leaked);
    }
    expect(logged()[0].shape).toContain('IN (?)');
  });

  test('only shape and duration: no SQL parameters, no table data', async () => {
    process.env.SLOW_QUERY_MS = '30';
    const seq = platformSequelize(slowQuery.slowQueryOptions({ db: 'platform' }));
    try {
      await seq.query('SELECT SLEEP(0.1)');
    } finally {
      await seq.close();
    }
    const keys = Object.keys(logged()[0]).sort();
    expect(keys).toEqual(
      ['db', 'durationMs', 'fingerprint', 'level', 'msg', 'shape', 'source', 'suppressed', 'thresholdMs', 'time'].sort()
    );
  });

  test('a slow query on a tenant pool is logged with db "tenant" (wired into TenantDbManager)', async () => {
    process.env.SLOW_QUERY_MS = '30';
    const entry = await TenantDbManager.getConnection('slow-q-tenant', dbHarness.tenant1.encryptedConnStr);
    expect(entry.sequelize.options.benchmark).toBe(true);
    await entry.sequelize.query('SELECT SLEEP(0.1)');
    expect(logged().map((r) => r.db)).toEqual(['tenant']);
  });

  test('a tenant pool created while it is off has no benchmarking at all', async () => {
    await TenantDbManager.releaseAll();
    const entry = await TenantDbManager.getConnection('slow-q-tenant-off', dbHarness.tenant1.encryptedConnStr);
    expect(entry.sequelize.options.benchmark).toBeFalsy();
    expect(entry.sequelize.options.logging).toBe(false);
  });

  test('the platform connection is wired too (read at load time)', () => {
    process.env.SLOW_QUERY_MS = '150';
    let on;
    jest.isolateModules(() => {
      on = require('../../src/database/platform').sequelize.options;
    });
    expect(on.benchmark).toBe(true);
    delete process.env.SLOW_QUERY_MS;
    let off;
    jest.isolateModules(() => {
      off = require('../../src/database/platform').sequelize.options;
    });
    expect(off.benchmark).toBeFalsy();
  });
});

describe('OBS-04: a flood of the same slow query is rate limited per fingerprint', () => {
  test('one line per fingerprint per 10 s, counting what it suppressed; another statement is not held back', async () => {
    process.env.SLOW_QUERY_MS = '1';
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const log = slowQuery.slowQueryOptions({ db: 'platform' }).logging;
    for (let i = 0; i < 5; i++) log("Executed (default): SELECT * FROM `users` WHERE `id` = " + i, 50);
    log('Executed (default): SELECT 1 FROM `payments` WHERE `a` = 1', 50);
    expect(logged().map((r) => r.shape)).toEqual(['SELECT * FROM `users` WHERE `id` = ?', 'SELECT ? FROM `payments` WHERE `a` = ?']);
    now += 10_001;
    log("Executed (default): SELECT * FROM `users` WHERE `id` = 99", 50);
    const last = logged().pop();
    expect(last.shape).toBe('SELECT * FROM `users` WHERE `id` = ?');
    expect(last.suppressed).toBe(4);
  });

  test('the fingerprint table stays bounded', () => {
    process.env.SLOW_QUERY_MS = '1';
    const log = slowQuery.slowQueryOptions({ db: 'platform' }).logging;
    for (let i = 0; i < 5000; i++) log(`Executed (default): SELECT col_${i} FROM t`, 50);
    expect(slowQuery._trackedFingerprints()).toBeLessThanOrEqual(500);
  });
});

describe('OBS-04: statementShape replaces every literal', () => {
  const shape = slowQuery.statementShape;

  test.each([
    ["SELECT * FROM `users` WHERE `email` = 'a@b.com' AND `id` = 5", 'SELECT * FROM `users` WHERE `email` = ? AND `id` = ?'],
    ["SELECT 1 WHERE n = 'O\\'Brien' OR n = 'it''s'", 'SELECT ? WHERE n = ? OR n = ?'],
    ['SELECT 1 WHERE n = "double \\" quoted"', 'SELECT ? WHERE n = ?'],
    ['SELECT * FROM t WHERE id IN (1, 2, 3, 4)', 'SELECT * FROM t WHERE id IN (?)'],
    ["SELECT * FROM t WHERE id IN ('a','b')", 'SELECT * FROM t WHERE id IN (?)'],
    ["INSERT INTO t (a, b) VALUES (1,'x'),(2,'y'),(3,'z')", 'INSERT INTO t (a, b) VALUES (?)'],
    ['SELECT * FROM t LIMIT 10 OFFSET 20', 'SELECT * FROM t LIMIT ? OFFSET ?'],
    ['SELECT SLEEP(0.12), -1.5e3, +7, 0x1F, X\'AB\'', 'SELECT SLEEP(?), ?, ?, ?, ?'],
    ["SELECT * FROM t WHERE id = '9f1c2d3e-aaaa-bbbb-cccc-111122223333'", 'SELECT * FROM t WHERE id = ?'],
    ['SELECT t1.col2 FROM tenant_1 AS t1 WHERE t1.x = 3', 'SELECT t1.col2 FROM tenant_1 AS t1 WHERE t1.x = ?'],
    ['SELECT `tenant_2`.`id`, `col3` FROM `tenant_2`', 'SELECT `tenant_2`.`id`, `col3` FROM `tenant_2`'],
    ['SELECT 1 /* secret: jane@example.test */ FROM t -- trailing 12345\n WHERE a = 1', 'SELECT ? FROM t WHERE a = ?'],
    ['SELECT * FROM t WHERE a = $1 AND b = $2', 'SELECT * FROM t WHERE a = ? AND b = ?'],
    ["SELECT * FROM t WHERE j = '{\"email\":\"a@b.test\",\"n\":5}'", 'SELECT * FROM t WHERE j = ?'],
    ['Executed (default): SELECT 1', 'SELECT ?'],
    ['Executing (default): UPDATE `payments` SET `status` = \'PAID\' WHERE `id` = 7', 'UPDATE `payments` SET `status` = ? WHERE `id` = ?'],
    ['SELECT   *\n  FROM\tt   WHERE a=1', 'SELECT * FROM t WHERE a=?'],
  ])('%s', (sql, expected) => {
    expect(shape(sql)).toBe(expected);
  });

  test('long statements are cut at 300 characters', () => {
    const out300 = shape(`SELECT ${'`some_long_column_name`, '.repeat(40)}x FROM t`);
    expect(out300.length).toBeLessThanOrEqual(303);
    expect(out300.endsWith('...')).toBe(true);
  });

  test('odd input never throws', () => {
    for (const bad of [undefined, null, 42, {}, [], '', "'unterminated", '`unterminated', '/* unterminated', 'x'.repeat(100000)]) {
      expect(() => shape(bad)).not.toThrow();
      expect(typeof shape(bad)).toBe('string');
    }
  });

  test('an unterminated quote does not let the rest of the statement through', () => {
    // a plain name, which no pattern-based redaction would catch: only the shape logic can remove it
    const s = shape("SELECT 1 WHERE name = 'Zebra Quokka AND p = 5");
    expect(s).not.toContain('Quokka');
    expect(s).not.toContain('Zebra');
    expect(shape('SELECT 1 WHERE name = "Zebra Quokka AND p = 5')).not.toContain('Quokka');
    expect(shape('SELECT `Zebra Quokka FROM t')).not.toContain('Quokka');
    expect(shape('SELECT 1 /* Zebra Quokka')).not.toContain('Quokka');
  });
});

describe('OBS-04: a failure in the slow-query logger never reaches the query', () => {
  test('a throwing log sink does not make the query fail', async () => {
    process.env.SLOW_QUERY_MS = '30';
    out.write.mockImplementation(() => {
      throw new Error('disk full');
    });
    const seq = platformSequelize(slowQuery.slowQueryOptions({ db: 'platform' }));
    try {
      await expect(seq.query('SELECT SLEEP(0.1)')).resolves.toBeDefined();
    } finally {
      await seq.close();
    }
  });

  test('a throwing existing logging function does not make the query fail either', async () => {
    process.env.SLOW_QUERY_MS = '30';
    const seq = platformSequelize(
      slowQuery.slowQueryOptions({
        db: 'platform',
        existingLogging: () => {
          throw new Error('bad logger');
        },
      })
    );
    try {
      await expect(seq.query('SELECT SLEEP(0.1)')).resolves.toBeDefined();
    } finally {
      await seq.close();
    }
  });
});
