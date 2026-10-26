/**
 * NEW-123 — no API log file since 2026-10-16, so a 5xx reference id could not be found.
 *
 * Cause: OBS-01 (`db790e0`, 2026-10-16) writes every log line with `fs.writeSync(1)`.
 * iisnode does not read file descriptor 1: it replaces `process.stdout` / `process.stderr`
 * with its own file streams (created on the first write), so since that commit nothing
 * reached its log folder.
 *
 * Fix: (1) the logger writes through `process.stdout` when something replaced it;
 * (2) every 5xx answer is also appended, with its reference id, to a daily JSON-lines file
 * in ERROR_LOG_DIR (default `logs/` in production outside Vercel), independent of iisnode.
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
  test('when process.stdout was replaced (iisnode), lines go to it, not to descriptor 1', () => {
    const got = [];
    const fake = { fd: null, write: (chunk) => got.push(String(chunk)) };
    const desc = Object.getOwnPropertyDescriptor(process, 'stdout');
    Object.defineProperty(process, 'stdout', { configurable: true, get: () => fake });
    const spy = jest.spyOn(fs, 'writeSync');
    try {
      out.write('{"msg":"hello"}\n');
    } finally {
      Object.defineProperty(process, 'stdout', desc);
    }
    const toFd1 = spy.mock.calls.filter((c) => c[0] === 1);
    spy.mockRestore();
    expect(got).toEqual(['{"msg":"hello"}\n']);
    expect(toFd1).toHaveLength(0);
  });
});
