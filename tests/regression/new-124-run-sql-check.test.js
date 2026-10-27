/**
 * NEW-124 — the read-only tenant schema check has to run on the production API server,
 * which has no mysql client. `src/scripts/run-sql-check.js` runs a .sql file through the
 * app's own platform database settings (PLATFORM_DB_*), prints each result grid as a plain
 * table, and refuses anything that is not SELECT, SET (user or session variables), or
 * PREPARE / EXECUTE / DEALLOCATE of a SELECT. No password and no personal data in the output.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { buildTwoBranchTeam } = require('../harness/two-branch-team');

const SCRIPT = path.join(__dirname, '..', '..', 'src', 'scripts', 'run-sql-check.js');
const CHECK_SQL = path.join(__dirname, '..', '..', 'docs', 'sql', 'new-124-tenant-schema-check.sql');

const { splitStatements, checkStatement, checkFile, run } = require('../../src/scripts/run-sql-check');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'new124-sql-'));
const sqlFile = (name, text) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
};

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('NEW-124 run-sql-check: statement guard (no database)', () => {
  test('splits on semicolons outside strings and comments', () => {
    const parts = splitStatements(
      '-- a comment; with a semicolon\nSELECT \'a;b\' AS x;\n/* block; comment */ SELECT `c;d` FROM t;\nSELECT "e;f"'
    );
    expect(parts.map((p) => p.text)).toEqual(['SELECT \'a;b\' AS x', 'SELECT `c;d` FROM t', 'SELECT "e;f"']);
    expect(parts.map((p) => p.line)).toEqual([2, 3, 4]);
  });

  test('the NEW-124 check file passes the guard (two SELECTs)', () => {
    const { statements, refused } = checkFile(fs.readFileSync(CHECK_SQL, 'utf8'));
    expect(refused).toEqual([]);
    expect(statements.map((s) => s.kind)).toEqual(['select', 'select']);
  });

  test.each([
    'SELECT 1',
    '(SELECT 1) UNION ALL (SELECT 2)',
    'SET @x = 1',
    'SET @a := 1, @b = (SELECT COUNT(*) FROM tenants)',
    'SET SESSION group_concat_max_len = 100000',
    'SET @@SESSION.sql_mode = \'\'',
    'PREPARE s FROM \'SELECT 1\'',
    'PREPARE s FROM @q',
    'EXECUTE s',
    'EXECUTE s USING @x',
    'DEALLOCATE PREPARE s',
  ])('allows %s', (sql) => {
    expect(checkStatement(sql)).toMatchObject({ ok: true });
  });

  test.each([
    'INSERT INTO tenants (id) VALUES (1)',
    'UPDATE tenants SET status = 1',
    'DELETE FROM tenants',
    'REPLACE INTO tenants VALUES (1)',
    'DROP TABLE tenants',
    'DROP PREPARE s',
    'CREATE TABLE x (id INT)',
    'ALTER TABLE tenants ADD c INT',
    'TRUNCATE tenants',
    'GRANT ALL ON *.* TO x',
    'CALL p()',
    'LOAD DATA INFILE \'x\' INTO TABLE t',
    'LOCK TABLES tenants READ',
    'HANDLER tenants OPEN',
    'SHOW GRANTS',
    'USE other_db',
    'WITH x AS (SELECT 1) DELETE FROM tenants',
    'SET GLOBAL max_connections = 1',
    'SET PASSWORD = \'x\'',
    'SET autocommit = 0',
    'SET NAMES latin1',
    'SELECT * FROM tenants INTO OUTFILE \'/tmp/x\'',
    'SELECT * FROM tenants INTO DUMPFILE \'/tmp/x\'',
    'SELECT id INTO @v FROM tenants LIMIT 1',
    'SELECT * FROM tenants FOR UPDATE',
    'SELECT * FROM tenants LOCK IN SHARE MODE',
    'SELECT SLEEP(10)',
    'SELECT LOAD_FILE(\'/etc/passwd\')',
    'SELECT GET_LOCK(\'x\', 10)',
    'SELECT BENCHMARK(1000000, MD5(1))',
    'PREPARE s FROM \'DELETE FROM tenants\'',
    'PREPARE s FROM \'SELECT 1; DROP TABLE tenants\'',
    'SELECT 1 /*!50000 ; DROP TABLE tenants */',
  ])('refuses %s', (sql) => {
    const result = checkStatement(sql);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  test('EXECUTE of a statement that was never prepared is refused', () => {
    const { refused } = checkFile('EXECUTE s;');
    expect(refused).toHaveLength(1);
  });

  test('a file with one bad statement is refused whole, before any connection', () => {
    const file = sqlFile('bad.sql', 'SELECT 1;\nDELETE FROM tenants;\nSELECT 2;');
    let status = 0;
    let output = '';
    try {
      output = execFileSync(process.execPath, [SCRIPT, file], {
        env: { ...process.env, PLATFORM_DB_HOST: '203.0.113.1', PLATFORM_DB_PASS: 'never-printed-secret' },
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 20000,
      });
    } catch (err) {
      status = err.status;
      output = `${err.stdout || ''}${err.stderr || ''}`;
    }
    expect(status).not.toBe(0);
    expect(output).toMatch(/REFUSED/);
    expect(output).toMatch(/line 2/);
    expect(output).not.toMatch(/never-printed-secret/);
    expect(output).not.toMatch(/Connecting/);
  });
});

test('without PLATFORM_DB_PASS it names the variables it needs (no values) and does not connect', async () => {
  const saved = { pass: process.env.PLATFORM_DB_PASS, user: process.env.PLATFORM_DB_USER };
  delete process.env.PLATFORM_DB_PASS;
  process.env.PLATFORM_DB_USER = 'user-value-not-printed';
  const lines = [];
  try {
    const code = await run({ sqlPath: sqlFile('ok.sql', 'SELECT 1 AS n;'), write: (s) => lines.push(s) });
    expect(code).toBe(3);
  } finally {
    if (saved.pass === undefined) delete process.env.PLATFORM_DB_PASS;
    else process.env.PLATFORM_DB_PASS = saved.pass;
    if (saved.user === undefined) delete process.env.PLATFORM_DB_USER;
    else process.env.PLATFORM_DB_USER = saved.user;
  }
  const text = lines.join('');
  expect(text).toMatch(/PLATFORM_DB_PASS is not set/);
  expect(text).toMatch(/Set here: .*PLATFORM_DB_USER/);
  expect(text).not.toContain('user-value-not-printed');
  expect(text).not.toMatch(/Connecting/);
});

describe('NEW-124 run-sql-check: against the test databases', () => {
  let h;
  let team;

  beforeAll(async () => {
    h = await setupTestDatabases();
    const personas = await setupPersonas(h);
    team = await buildTwoBranchTeam(h, personas);
    // The harness leaves tenants.db_name empty; production fills it (NEW-122). Point it at the
    // real test tenant databases so the check reads their information_schema.
    await h.platform.sequelize.query('UPDATE tenants SET db_name = :db WHERE id = \'test-tenant-1\' OR tenant_code = \'GYM-TENANT1\'', { replacements: { db: h.tenant1.database } });
    await h.platform.sequelize.query('UPDATE tenants SET db_name = :db WHERE id = \'test-tenant-2\' OR tenant_code = \'GYM-TENANT2\'', { replacements: { db: h.tenant2.database } });
    // One tenant database below schema v19, as in production.
    await h.tenant1.sequelize.query('ALTER TABLE `branches` DROP COLUMN `currency`');
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  const capture = () => {
    const lines = [];
    return { write: (s) => lines.push(String(s)), text: () => lines.join('') };
  };

  test('runs the NEW-124 check and prints both grids as plain tables', async () => {
    const out = capture();
    const code = await run({ sqlPath: CHECK_SQL, write: out.write });
    const text = out.text();
    expect(code).toBe(0);

    expect(text).toMatch(/Grid 1 \(line \d+\)/);
    expect(text).toMatch(/Grid 2 \(line \d+\)/);
    // Grid 1 header row and the tenant below v19
    expect(text).toMatch(/\|\s*tenant_id\s*\|\s*tenant_code\s*\|\s*gym_name\s*\|\s*db_name\s*\|/);
    const [tenant] = await h.platform.sequelize.query('SELECT tenant_code, db_name FROM tenants WHERE id = :id', {
      replacements: { id: team.tenantId },
      type: h.platform.sequelize.QueryTypes.SELECT,
    });
    const grid1Row = text.split('\n').find((l) => l.includes(` ${tenant.db_name} `) && /\|\s*0\s*\|\s*$/.test(l.trimEnd()));
    expect(grid1Row).toBeTruthy();
    const okRow = text.split('\n').find((l) => l.includes(` ${h.tenant2.database} `) && /\|\s*1\s*\|\s*1\s*\|$/.test(l.trimEnd()));
    expect(okRow).toBeTruthy();
    // Grid 2 lists the missing column
    expect(text).toMatch(new RegExp(`\\|\\s*${tenant.tenant_code}\\s*\\|\\s*${tenant.db_name}\\s*\\|\\s*branches\\s*\\|\\s*currency\\s*\\|`));
  });

  test('no password, no gym name (personal data) and no e-mail in the output', async () => {
    const out = capture();
    await run({ sqlPath: CHECK_SQL, write: out.write });
    const text = out.text();
    const [rows] = await h.platform.sequelize.query('SELECT gym_name FROM tenants WHERE status = \'ACTIVE\'');
    for (const { gym_name: name } of rows) if (name) expect(text).not.toContain(name);
    expect(text).toMatch(/\[hidden\]/);
    const pass = process.env.PLATFORM_DB_PASS;
    if (pass) expect(text).not.toContain(pass);
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  test('e-mails inside values are redacted even in an allowed column', async () => {
    const out = capture();
    await run({ sqlPath: sqlFile('email.sql', 'SELECT \'jane@example.test\' AS db_name;'), write: out.write });
    expect(out.text()).not.toContain('jane@example.test');
  });

  test('PREPARE FROM @var: the real value is checked before it runs', async () => {
    const [[before]] = await h.platform.sequelize.query('SELECT COUNT(*) AS n FROM tenants');
    const bad = capture();
    const badCode = await run({
      sqlPath: sqlFile('prep-bad.sql', 'SET @q = CONCAT(\'DELETE \', \'FROM tenants\');\nPREPARE s FROM @q;\nEXECUTE s;'),
      write: bad.write,
    });
    expect(badCode).not.toBe(0);
    expect(bad.text()).toMatch(/REFUSED/);
    const [[after]] = await h.platform.sequelize.query('SELECT COUNT(*) AS n FROM tenants');
    expect(after.n).toBe(before.n);

    const good = capture();
    const goodCode = await run({
      sqlPath: sqlFile('prep-good.sql', 'SET @q = CONCAT(\'SELECT COUNT(*) AS \', \'tenant_count FROM tenants\');\nPREPARE s FROM @q;\nEXECUTE s;\nDEALLOCATE PREPARE s;'),
      write: good.write,
    });
    expect(goodCode).toBe(0);
    expect(good.text()).toMatch(/\|\s*tenant_count\s*\|/);
    expect(good.text()).toMatch(new RegExp(`\\|\\s*${before.n}\\s*\\|`));
  });

  test('the session is read-only: a write that slipped past the guard is refused by MySQL', async () => {
    const { openReadOnlyConnection } = require('../../src/scripts/run-sql-check');
    const conn = await openReadOnlyConnection();
    try {
      await expect(conn.query('UPDATE tenants SET gym_name = gym_name WHERE id = \'none\'')).rejects.toThrow(/READ ONLY/i);
    } finally {
      await conn.end();
    }
  });
});
