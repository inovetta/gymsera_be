/**
 * NEW-123 — no API log file since 2026-10-16, so a 5xx reference id could not be found.
 *
 * Cause: OBS-01 (`db790e0`, 2026-10-16) writes every log line with `fs.writeSync(1)`.
 * iisnode does not read file descriptor 1: its interceptor assigns its own `write` onto
 * `process.stdout` / `process.stderr` (the same objects; `fd` stays 1) that appends to
 * iisnode/<host>-<pid>-stdout-<ts>.txt, so since that commit nothing reached its log folder.
 * The first fix (`f457114`) tested `process.stdout.fd !== 1`, which is never true under the
 * real interceptor, and the journal swallowed its own write errors: production on `d023bc3`
 * (2026-10-26) still wrote no file at all.
 *
 * Fix: (1) the logger writes through `process.stdout.write` when a host (iisnode) installed its own;
 * (2) every 5xx answer is also appended, with its reference id, to a daily JSON-lines file
 * in ERROR_LOG_DIR (default `logs/` in production outside Vercel), independent of iisnode;
 * (3) an unwritable journal folder falls back to the temp folder and is printed once;
 * (4) server.js writes a boot line to the journal and the console at startup.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new123-'));
process.env.ERROR_LOG_DIR = dir;

const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam } = require('../harness/two-branch-team');
const { out } = require('../../src/utils/logger');

let app;
let team;
let h;

beforeAll(async () => {
  h = await setupTestDatabases();
  const personas = await setupPersonas(h);
  team = await buildTwoBranchTeam(h, personas);
  app = await startTestServer();
  // The NEW-124 shape: a tenant database without branches.currency answers a 500.
  await h.tenant1.sequelize.query('DELETE FROM schema_migrations WHERE version >= 19');
  await h.tenant1.sequelize.query('ALTER TABLE `branches` DROP COLUMN `currency`');
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
  delete process.env.ERROR_LOG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (p) => request(app).get(`/api/v1${p}`).set('Authorization', `Bearer ${team.ownerToken}`);

const journal = () => {
  const file = path.join(dir, `errors-${new Date().toISOString().slice(0, 10)}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

describe('NEW-123: every 5xx is kept with its reference id', () => {
  test('a database_error 500 writes one line with the reference id the client shows', async () => {
    const res = await get('/host/branches');
    expect(res.status).toBe(500);
    const ref = res.body.requestId;
    expect(ref).toBeTruthy();

    const lines = journal().filter((l) => l.requestId === ref);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      status: 500,
      code: 'database_error',
      method: 'GET',
      path: '/api/v1/host/branches',
      tenantId: team.tenantId,
    });
    expect(line.userId).toBeTruthy();
    expect(typeof line.time).toBe('string');
    expect(line.durationMs).toBeGreaterThanOrEqual(0);
    expect(line.error.name).toMatch(/Sequelize/);
    expect(line.error.sqlMessage).toMatch(/Unknown column 'currency'/);
  });

  test('a 4xx is not journaled', async () => {
    const before = journal().length;
    const res = await get('/host/branches/not-a-real-route/nothing/here');
    expect(res.status).toBeLessThan(500);
    expect(journal().length).toBe(before);
  });

  test('no token, e-mail or query string reaches the file', async () => {
    await request(app)
      .get('/api/v1/host/branches?email=jane@example.test')
      .set('Authorization', `Bearer ${team.ownerToken}`);
    const raw = fs.readFileSync(path.join(dir, `errors-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
    expect(raw).not.toContain(team.ownerToken);
    expect(raw).not.toContain('jane@example.test');
    expect(raw).not.toContain('?email');
  });

  test('a journal that cannot be written never changes the answer', async () => {
    const prev = process.env.ERROR_LOG_DIR;
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    process.env.ERROR_LOG_DIR = path.join(blocker, 'sub');
    try {
      const res = await get('/host/branches');
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('database_error');
    } finally {
      process.env.ERROR_LOG_DIR = prev;
    }
  });
});

describe('NEW-123: the logger writes where iisnode reads', () => {
  // iisnode src/scripts/interceptor.js does `stream.write = stream.end = function (data) {...}`
  // on the real process.stdout object before it requires server.js; process.stdout.fd stays 1.
  test('when iisnode assigned its own write onto process.stdout (fd still 1), lines go to it, not to descriptor 1', () => {
    const got = [];
    const stdout = process.stdout;
    const hadOwn = Object.prototype.hasOwnProperty.call(stdout, 'write');
    const previous = stdout.write;
    stdout.write = (chunk) => got.push(String(chunk));
    const spy = jest.spyOn(fs, 'writeSync');
    try {
      expect(stdout.fd).toBe(1);
      out.write('{"msg":"hello"}\n');
    } finally {
      if (hadOwn) stdout.write = previous;
      else delete stdout.write;
    }
    const toFd1 = spy.mock.calls.filter((c) => c[0] === 1);
    spy.mockRestore();
    expect(got).toEqual(['{"msg":"hello"}\n']);
    expect(toFd1).toHaveLength(0);
  });
});

describe('NEW-123: a journal folder that cannot be written is never silent', () => {
  const errorJournal = require('../../src/utils/error-journal');
  const today = () => `errors-${new Date().toISOString().slice(0, 10)}.jsonl`;

  test('boot() writes a boot line to the journal and prints where it went', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const written = errorJournal.boot();
      expect(written).toBe(path.join(dir, today()));
      const lines = journal().filter((l) => l.event === 'boot');
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines[lines.length - 1]).toMatchObject({ event: 'boot', pid: process.pid });
      expect(logSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(`[ErrorJournal] boot pid=${process.pid}`);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('an unwritable folder: the line goes to the temp folder and the failure is printed once', () => {
    const prev = process.env.ERROR_LOG_DIR;
    const blocker = path.join(dir, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    const fallback = path.join(dir, 'fallback');
    const tmpSpy = jest.spyOn(os, 'tmpdir').mockReturnValue(fallback);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.ERROR_LOG_DIR = path.join(blocker, 'sub');
    const res = { statusCode: 500, locals: { errorCode: 'database_error' }, getHeader: () => null };
    try {
      errorJournal.record({ method: 'GET', originalUrl: '/api/v1/x', id: 'ref-a' }, res, Date.now());
      errorJournal.record({ method: 'GET', originalUrl: '/api/v1/x', id: 'ref-b' }, res, Date.now());
    } finally {
      process.env.ERROR_LOG_DIR = prev;
      tmpSpy.mockRestore();
    }
    const printed = errSpy.mock.calls.map((c) => c.join(' '));
    errSpy.mockRestore();

    const file = path.join(fallback, 'gymsera-logs', today());
    const ids = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).requestId);
    expect(ids).toEqual(['ref-a', 'ref-b']);
    const reports = printed.filter((m) => m.includes('[ErrorJournal] cannot write to'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(path.join(fallback, 'gymsera-logs'));
  });
});
