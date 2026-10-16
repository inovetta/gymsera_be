/**
 * OBS-01 — structured JSON logs with request context (spec §12.12).
 *
 * Runs a real HTTP server with the production middleware order:
 * requestId -> accessLog -> body parser -> requestContext. Lines are read from
 * the logger's single output seam, so this is exactly what would be printed.
 */
const http = require('http');
const express = require('express');
const request = require('supertest');
const requestId = require('../../src/middleware/requestId');
const accessLog = require('../../src/middleware/accessLog');
const openRequestContext = require('../../src/middleware/requestContext');
const logRedaction = require('../../src/utils/log-redaction');
const { out } = require('../../src/utils/logger');
const { hashEmail } = logRedaction;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lines;
let server;
let prevFormat;

const parsed = () => lines.map((l) => JSON.parse(l));

beforeAll(async () => {
  prevFormat = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = 'json';
  logRedaction.installConsoleRedaction(); // app.js does this at startup
  const app = express();
  app.use(requestId);
  app.use(accessLog);
  app.use(express.json());
  app.use(openRequestContext);
  // Stand-in for authenticate / tenantContext: they set these on req.
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) req.user = { id: req.headers['x-test-user'] };
    if (req.headers['x-test-tenant']) req.tenantId = req.headers['x-test-tenant'];
    next();
  });
  const router = express.Router();
  router.get('/members/:id', async (req, res) => {
    await sleep(Number(req.query.wait || 0)); // the context must survive an await
    console.log('looked up member for jane@example.test');
    setTimeout(() => {
      console.warn('timer after response');
    }, 5);
    res.json({ ok: true });
  });
  router.post('/echo', async (req, res) => {
    await new Promise((r) => setImmediate(r)); // after the body parser's stream callbacks
    console.log('body parsed');
    res.json({ got: req.body });
  });
  app.use('/api/v1', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  if (prevFormat === undefined) delete process.env.LOG_FORMAT;
  else process.env.LOG_FORMAT = prevFormat;
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  lines = [];
  jest.spyOn(out, 'write').mockImplementation((line) => { lines.push(line); });
});

afterEach(() => jest.restoreAllMocks());

describe('OBS-01: X-Request-Id', () => {
  test('a valid incoming id is kept and returned', async () => {
    const res = await request(server).get('/api/v1/members/1').set('X-Request-Id', 'mobile-7f3a_01.b:2');
    expect(res.headers['x-request-id']).toBe('mobile-7f3a_01.b:2');
  });

  test.each([
    ['too long', 'a'.repeat(65)],
    ['spaces and newline-ish characters', 'abc def'],
    ['log-injection attempt', 'x","level":"fatal'],
    ['non-ASCII', 'idé'],
  ])('an unsafe incoming id (%s) is replaced by a UUID', async (_label, bad) => {
    const res = await request(server).get('/api/v1/members/1').set('X-Request-Id', bad);
    expect(res.headers['x-request-id']).not.toBe(bad);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a 64-character id is accepted, 65 is not (the cap)', () => {
    expect(requestId.SAFE_ID.test('a'.repeat(64))).toBe(true);
    expect(requestId.SAFE_ID.test('a'.repeat(65))).toBe(false);
  });

  test('no header gets a generated id', async () => {
    const res = await request(server).get('/api/v1/members/1');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('OBS-01: access line', () => {
  test('carries requestId, tenantId, userId, route pattern, status and latency', async () => {
    await request(server)
      .get('/api/v1/members/abc-123?token=secret-t&email=leak@x.test')
      .set('X-Request-Id', 'req-1')
      .set('x-test-user', 'user-9')
      .set('x-test-tenant', 'tenant-4');
    await sleep(20);
    const access = parsed().find((l) => l.source === 'access');
    expect(access).toMatchObject({
      level: 'info',
      requestId: 'req-1',
      tenantId: 'tenant-4',
      userId: 'user-9',
      method: 'GET',
      route: '/api/v1/members/:id',
      status: 200,
    });
    expect(typeof access.latencyMs).toBe('number');
    expect(access.latencyMs).toBeGreaterThanOrEqual(0);
    // SEC-07 still applies to the raw URL
    expect(JSON.stringify(access)).not.toContain('secret-t');
    expect(JSON.stringify(access)).not.toContain('leak@x.test');
  });

  test('an unmatched URL logs route "unmatched" (no ids, so safe to group by) with level warn', async () => {
    await request(server).get('/nope/12345');
    await sleep(10);
    const access = parsed().find((l) => l.source === 'access');
    expect(access).toMatchObject({ route: 'unmatched', status: 404, level: 'warn' });
  });

  test('no e-mail, name or phone field is ever added to a line', async () => {
    await request(server).get('/api/v1/members/1').set('x-test-user', 'user-9');
    await sleep(20);
    for (const l of parsed()) {
      expect(Object.keys(l)).not.toEqual(expect.arrayContaining(['email']));
      expect(Object.keys(l)).not.toEqual(expect.arrayContaining(['phone']));
    }
  });
});

describe('OBS-01: console lines carry the request context', () => {
  test('console.log inside a handler, after an await and in a later timer, is JSON with the request id', async () => {
    await request(server)
      .get('/api/v1/members/1?wait=15')
      .set('X-Request-Id', 'req-ctx')
      .set('x-test-user', 'user-2')
      .set('x-test-tenant', 'tenant-2');
    await sleep(30);
    const consoleLines = parsed().filter((l) => l.source === 'console');
    expect(consoleLines).toHaveLength(2);
    for (const l of consoleLines) {
      expect(l).toMatchObject({ requestId: 'req-ctx', userId: 'user-2', tenantId: 'tenant-2' });
    }
    expect(consoleLines[0].level).toBe('info');
    expect(consoleLines[1].level).toBe('warn');
  });

  test('the context survives the body parser (a POST with a JSON body)', async () => {
    await request(server).post('/api/v1/echo').set('X-Request-Id', 'req-body').send({ a: 1 });
    await sleep(10);
    const line = parsed().find((l) => l.msg === 'body parsed');
    expect(line.requestId).toBe('req-body');
  });

  test('concurrent requests never see each other\'s context', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        request(server)
          .get(`/api/v1/members/${i}?wait=${(i % 4) * 5}`)
          .set('X-Request-Id', `req-c-${i}`)
          .set('x-test-user', `user-${i}`)
      )
    );
    await sleep(40);
    const mine = parsed().filter((l) => l.source === 'console');
    expect(mine).toHaveLength(24);
    for (const l of mine) {
      expect(l.userId).toBe(`user-${l.requestId.split('-').pop()}`);
    }
  });

  test('SEC-07 redaction still runs first: an e-mail in a message appears only as its hash', async () => {
    jest.spyOn(logRedaction.sink, 'write'); // keep the real sink
    await request(server).get('/api/v1/members/1');
    await sleep(20);
    const all = lines.join('\n');
    expect(all).not.toContain('jane@example.test');
    expect(all).toContain(hashEmail('jane@example.test'));
  });

  test('outside a request (cron, startup) a line is still JSON, just without a requestId', () => {
    console.log('[Cron] nightly job started');
    const line = parsed().find((l) => l.msg.includes('nightly job started'));
    expect(line.requestId).toBeUndefined();
    expect(line.level).toBe('info');
  });

  test('LOG_FORMAT=text keeps the plain console output', () => {
    process.env.LOG_FORMAT = 'text';
    try {
      console.log('plain text mode');
      expect(lines).toHaveLength(0);
    } finally {
      process.env.LOG_FORMAT = 'json';
    }
  });
});
