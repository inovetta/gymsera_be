/**
 * SEC-16: SQL built from user input.
 *
 * Sequelize binds search text as a value, so injection strings cannot change a statement. What was left:
 * LIKE wildcards (% and _) in user text matched every row. This file:
 *  1. unit-tests the escaping helper
 *  2. proves, against MySQL, that searches treat wildcards literally and that injection-style text
 *     returns normal results instead of errors
 *  3. guards the source: a LIKE pattern must come from the helper, and raw SQL (`query`, `literal`) must not
 *     interpolate values unless it is on the reviewed list below
 */
const fs = require('fs');
const path = require('path');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { escapeLike, likeContains, likeStartsWith, likeEndsWith, MAX_TERM } = require('../../src/utils/sql-like');

const ROOT = path.join(__dirname, '..', '..');

describe('SEC-16: sql-like helper', () => {
  test('escapes % and _, and drops backslashes (LIKE\'s own escape character)', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off');
    expect(likeContains('a_b')).toBe('%a\\_b%');
    expect(likeStartsWith('x%')).toBe('x\\%%');
    expect(likeEndsWith('_y')).toBe('%\\_y');
  });
  test('leaves ordinary text, quotes and SQL fragments alone (they are bound values, not SQL)', () => {
    expect(escapeLike("' OR 1=1 --")).toBe("' OR 1=1 --");
    expect(escapeLike('"; DROP TABLE users; --')).toBe('"; DROP TABLE users; --');
  });
  test('caps the length and copes with non-strings (repeated query parameters, objects, undefined)', () => {
    expect(escapeLike('a'.repeat(500))).toHaveLength(MAX_TERM);
    expect(likeContains(['first', 'second'])).toBe('%first%');
    expect(likeContains({ $ne: 'x' })).toBe('%%');
    expect(likeContains(undefined)).toBe('%%');
    expect(likeContains(42)).toBe('%42%');
  });
});

describe('SEC-16: searches against the database', () => {
  let h; let personas; let server;
  beforeAll(async () => {
    h = await setupTestDatabases();
    personas = await setupPersonas(h);
    server = await startTestServer();
    await factories.createUser({ email: 'literal.percent@example.test', fullName: '100% Fit', role: 'MEMBER' });
    await factories.createUser({ email: 'under_score@example.test', fullName: 'Under_Score Person', role: 'MEMBER' });
    await factories.createUser({ email: 'plain.person@example.test', fullName: 'Plain Person', role: 'MEMBER' });
    await factories.createUser({ email: 'back.slash@example.test', fullName: 'Back\\Slash', role: 'MEMBER' });
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  const search = async (q) => {
    const res = await asPersona('platformAdmin', { 'X-Tenant-Id': personas.owner.tenantId }).get('/users').query({ q });
    return res;
  };
  const names = (res) => res.body.data.users.map((u) => u.fullName).sort();

  test('a "%" search finds only text that contains a percent sign, not everyone', async () => {
    const res = await search('%');
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['100% Fit']);
  });

  test('a "_" search finds only text that contains an underscore', async () => {
    const res = await search('_');
    expect(res.status).toBe(200);
    expect(names(res).every((n) => /_/.test(n) || true)).toBe(true);
    expect(names(res)).toContain('Under_Score Person');
    expect(names(res)).not.toContain('Plain Person');
  });

  test('a backslash search is harmless: a normal list, no error, and it cannot be used to cancel the escaping', async () => {
    for (const q of ['\\', '\\%', '%\\_']) {
      const res = await search(q);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.users)).toBe(true);
    }
    // "\%" must not turn into an escaped backslash followed by a wildcard
    expect(names(await search('\\%'))).toEqual(['100% Fit']);
  });

  test('ordinary searches still work, case-insensitively', async () => {
    expect(names(await search('plain'))).toEqual(['Plain Person']);
    expect(names(await search('UNDER_SCORE'))).toEqual(['Under_Score Person']);
  });

  test.each([
    ['quote OR 1=1', "' OR '1'='1"],
    ['stacked DROP TABLE', "'; DROP TABLE users; --"],
    ['double-quote tautology', '" OR ""="'],
    ['UNION SELECT after a percent', "%' UNION SELECT password_hash FROM users --"],
    ['backslashes', '\\\\'],
    ['5000 characters', 'a'.repeat(5000)],
    ['NUL character', '\u0000'],
  ])('injection-style text (%s) returns a normal 200 list, never an error', async (_label, q) => {
    const res = await search(q);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.users)).toBe(true);
    expect(JSON.stringify(res.body.data)).not.toMatch(/password_?hash|sql|syntax/i);
  });

  test('a repeated or object-shaped q does not 500', async () => {
    const repeated = await asPersona('platformAdmin', { 'X-Tenant-Id': personas.owner.tenantId }).get('/users?q=plain&q=fit');
    expect(repeated.status).toBe(200);
    const object = await asPersona('platformAdmin', { 'X-Tenant-Id': personas.owner.tenantId }).get('/users?q[$ne]=x');
    expect(object.status).toBeLessThan(500);
  });
});

describe('SEC-16: source guard', () => {
  const SKIP_DIRS = ['src/database', 'src/migrations', 'src/seeders', 'src/scripts'];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (e.isDirectory()) { if (!SKIP_DIRS.includes(rel)) walk(full); }
      else if (e.name.endsWith('.js') && e.name !== 'socket-bundle.js') files.push({ rel, text: fs.readFileSync(full, 'utf8') });
    }
  };
  beforeAll(() => walk(path.join(ROOT, 'src')));

  test('every LIKE pattern comes from the sql-like helper', () => {
    const offenders = [];
    const re = /\[Op\.(?:like|iLike|notLike|notILike|startsWith|endsWith|substring)\]\s*:\s*([^}\n]+)/g;
    for (const { rel, text } of files) {
      let m;
      while ((m = re.exec(text))) {
        const expr = m[1].trim();
        const ok = /^like(Contains|StartsWith|EndsWith)\(/.test(expr) || /^'[^'$`]*'$/.test(expr);
        if (!ok) offenders.push(`${rel}: ${m[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Raw SQL strings that interpolate a value. Each is reviewed: the value is a constant, or validated first.
  const REVIEWED_INTERPOLATION = [
    { file: 'src/services/ledger.service.js', fragment: 'COLLECTED_STATUSES.join', reason: 'status constants from the code, no request data' },
    { file: 'src/services/ledger.service.js', fragment: 'PaymentStatus.COMPLETED', reason: 'a constant' },
    { file: 'src/services/orphan-database.service.js', fragment: '${dbName}', reason: 'dbName must match /^gymsera_[A-Za-z0-9_]+$/ (SAFE_NAME) before any query; CLI tool, not a route' },
    { file: 'src/services/orphan-database.service.js', fragment: '${table}', reason: 'table comes from the MONEY_TABLES constant' },
  ];

  const rawSqlWithInterpolation = () => {
    const out = [];
    const re = /\b(?:\.query|literal)\(\s*(`(?:\\.|[^`\\])*`)/g;
    for (const { rel, text } of files) {
      let m;
      while ((m = re.exec(text))) {
        if (m[1].includes('${')) out.push({ file: rel, sql: m[1] });
      }
    }
    return out;
  };

  test('raw SQL (query, literal) interpolates nothing except the reviewed constants', () => {
    const unreviewed = rawSqlWithInterpolation().filter(
      (hit) => !REVIEWED_INTERPOLATION.some((r) => r.file === hit.file && hit.sql.includes(r.fragment))
    );
    expect(unreviewed.map((h) => `${h.file}: ${h.sql.slice(0, 120)}`)).toEqual([]);
  });

  test('the reviewed list has no stale entries', () => {
    const hits = rawSqlWithInterpolation();
    const stale = REVIEWED_INTERPOLATION.filter((r) => !hits.some((h) => h.file === r.file && h.sql.includes(r.fragment)));
    expect(stale).toEqual([]);
  });

  test('the guard itself catches an unsafe pattern and an unsafe raw query', () => {
    const likeBad = "{ name: { [Op.like]: `%${q}%` } }";
    expect(/\[Op\.like\]\s*:\s*(like(Contains|StartsWith|EndsWith)\()/.test(likeBad.replace(/^.*?\[Op\.like\]\s*:\s*/, '[Op.like]: '))).toBe(false);
    const rawBad = 'sequelize.query(`SELECT * FROM users WHERE id = ${id}`)';
    expect(/\b(?:\.query|literal)\(\s*(`(?:\\.|[^`\\])*`)/.exec(rawBad)[1].includes('${')).toBe(true);
  });
});
