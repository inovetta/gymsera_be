/**
 * OBS-02 (backend) — error tracking with Sentry behind the error-tracker seam (spec §12.12).
 *
 * Runs the REAL @sentry/node with a fake transport, so what is asserted is exactly what would leave the
 * process. Inert without SENTRY_DSN; release and environment from the environment; the user id is the
 * only user field; every event goes through the SEC-07 redaction in beforeSend (fail closed); a failing
 * or hanging Sentry never changes a response.
 */
const os = require('os');
const http = require('http');
const express = require('express');
const request = require('supertest');
const { DatabaseError } = require('sequelize');

const mockSdkLoads = { count: 0 };
jest.mock('@sentry/node', () => {
  mockSdkLoads.count += 1;
  return jest.requireActual('@sentry/node');
});

const errorTracker = require('../../src/utils/error-tracker');
const logRedaction = require('../../src/utils/log-redaction');
const requestId = require('../../src/middleware/requestId');
const errorHandler = require('../../src/middleware/errorHandler');

const DSN = 'https://publickey@o0.ingest.example.invalid/1';
const saved = {};

const fakeTransport = () => {
  const sent = [];
  return {
    sent,
    factory: () => ({
      send: async (envelope) => {
        sent.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
    events: () => sent.flatMap((env) => env[1].filter(([h]) => h.type === 'event').map(([, payload]) => payload)),
  };
};

const startWith = async (transport, env = {}) => {
  process.env.SENTRY_DSN = DSN;
  Object.assign(process.env, env);
  errorTracker._resetForTests();
  const ok = errorTracker.init({ transport: transport.factory });
  return ok;
};
const settle = () => errorTracker.flush(1000);

beforeEach(() => {
  for (const k of ['SENTRY_DSN', 'SENTRY_RELEASE', 'SENTRY_ENVIRONMENT']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  mockSdkLoads.count = 0;
  errorTracker._resetForTests();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  errorTracker._resetForTests();
  jest.restoreAllMocks();
});

describe('OBS-02: inert without a DSN', () => {
  test('init does nothing, the SDK is never loaded, every call is a quiet no-op', async () => {
    expect(errorTracker.init()).toBe(false);
    expect(errorTracker.captureException(new Error('x'), {})).toBe(false);
    expect(errorTracker.captureMessage('x')).toBe(false);
    await expect(errorTracker.flush(50)).resolves.toBe(false);
    expect(mockSdkLoads.count).toBe(0);
  });

  test('with a DSN it patches nothing: http is untouched and no process handler is added', async () => {
    const before = { request: http.request, get: http.get, handlers: process.listeners('uncaughtException').length + process.listeners('unhandledRejection').length };
    expect(await startWith(fakeTransport())).toBe(true);
    expect(http.request).toBe(before.request);
    expect(http.get).toBe(before.get);
    expect(process.listeners('uncaughtException').length + process.listeners('unhandledRejection').length).toBe(before.handlers);
  });

  test('an invalid DSN never throws', () => {
    process.env.SENTRY_DSN = 'not-a-dsn';
    expect(() => errorTracker.init()).not.toThrow();
    expect(() => errorTracker.captureException(new Error('x'))).not.toThrow();
  });
});

describe('OBS-02: release and environment come from the environment', () => {
  test('SENTRY_RELEASE and SENTRY_ENVIRONMENT are used', async () => {
    const t = fakeTransport();
    await startWith(t, { SENTRY_RELEASE: 'gymsera-api@1.2.3', SENTRY_ENVIRONMENT: 'staging' });
    errorTracker.captureException(new Error('boom'));
    await settle();
    expect(t.events()[0]).toMatchObject({ release: 'gymsera-api@1.2.3', environment: 'staging' });
  });

  test('environment falls back to NODE_ENV, release is left out when not set', async () => {
    const t = fakeTransport();
    await startWith(t);
    errorTracker.captureException(new Error('boom'));
    await settle();
    expect(t.events()[0].environment).toBe(process.env.NODE_ENV);
    expect(t.events()[0].release).toBeUndefined();
  });
});

describe('OBS-02: what leaves the process', () => {
  const req = () => ({
    id: 'req-77',
    tenantId: 'tenant-9',
    method: 'POST',
    baseUrl: '/api/v1',
    route: { path: '/payments/:id' },
    originalUrl: '/api/v1/payments/9f1c2d3e-aaaa-bbbb-cccc-111122223333?token=url-secret&email=leak@example.test',
    ip: '203.0.113.9',
    headers: { authorization: 'Bearer hdr-secret.abc', cookie: 'sid=cookie-secret', 'user-agent': 'Secret-UA/1.0' },
    body: { password: 'body-secret', cardNumber: '4242424242424242' },
    user: { id: 'user-1', email: 'jane@example.test', fullName: 'Jane Doe', phone: '+923001112223' },
  });

  test('the user id is the only user field; id, tenant and route pattern are tags', async () => {
    const t = fakeTransport();
    await startWith(t);
    errorTracker.captureException(new Error('boom'), { req: req() });
    await settle();
    const ev = t.events()[0];
    expect(ev.user).toEqual({ id: 'user-1' });
    expect(ev.tags).toMatchObject({ requestId: 'req-77', tenantId: 'tenant-9', route: '/api/v1/payments/:id' });
  });

  test('no e-mail, name, phone, IP, header, cookie, body, query string, hostname or local path in the event', async () => {
    const t = fakeTransport();
    await startWith(t);
    const sdk = require('@sentry/node');
    sdk.getGlobalScope().setUser({ id: 'g-1', email: 'scope@example.test', ip_address: '198.51.100.7', username: 'jdoe' });
    errorTracker.captureException(new Error('boom'), { req: req() });
    await settle();
    const text = JSON.stringify(t.events()[0]);
    for (const leaked of [
      'jane@example.test', 'Jane Doe', '+923001112223', '203.0.113.9', 'hdr-secret', 'cookie-secret', 'Secret-UA',
      'body-secret', '4242424242424242', 'url-secret', 'leak@example.test', 'scope@example.test', '198.51.100.7', 'jdoe',
      os.hostname(), process.cwd(),
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(t.events()[0].user).toEqual({ id: 'user-1' });
    expect(t.events()[0].server_name).toBeUndefined();
    expect(t.events()[0].request).toBeUndefined();
  });

  test('breadcrumbs are never sent', async () => {
    const t = fakeTransport();
    await startWith(t);
    const sdk = require('@sentry/node');
    sdk.addBreadcrumb({ message: 'user jane@example.test logged in', data: { token: 'crumb-secret' } });
    errorTracker.captureException(new Error('boom'));
    await settle();
    expect(t.events()[0].breadcrumbs || []).toEqual([]);
    expect(JSON.stringify(t.events()[0])).not.toContain('crumb-secret');
  });

  test('the SEC-07 redaction runs on messages, exception text, tags and extra', async () => {
    const t = fakeTransport();
    await startWith(t);
    const nasty =
      'Login failed for jane@example.test with Authorization: Bearer abc.def-ghi_123, card 4242 4242 4242 4242, ' +
      'CNIC 35202-1234567-1, IBAN PK36SCBL0000001123456702, url /x?token=s3cr3t-push&otp=482913';
    errorTracker.captureException(new Error(nasty), {
      req: { ...req(), user: { id: 'user-1' } },
      extra: { password: 'hunter2', email: 'jane@example.test', nested: { refreshToken: 'rt-plain', note: 'call +923001112223' } },
    });
    errorTracker.captureMessage(nasty, { level: 'error', tags: { alertCode: 'X', who: 'jane@example.test' }, extra: { tenantCount: 2 } });
    await settle();
    const [ex, msg] = t.events();
    expect(ex.exception.values[0].value).toBe(logRedaction.redactString(nasty));
    expect(msg.message).toBe(logRedaction.redactString(nasty));
    const text = JSON.stringify(t.events());
    for (const leaked of ['jane@example.test', 'abc.def-ghi_123', '4242 4242 4242 4242', '35202-1234567-1', 'PK36SCBL0000001123456702', 's3cr3t-push', '482913', 'hunter2', 'rt-plain', '+923001112223']) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain(logRedaction.hashEmail('jane@example.test'));
    expect(msg.extra).toMatchObject({ tenantCount: 2 }); // ordinary content survives
  });

  test('stack frames show paths relative to the app, not the machine', async () => {
    const t = fakeTransport();
    await startWith(t);
    errorTracker.captureException(new Error('boom'));
    await settle();
    const frames = t.events()[0].exception.values[0].stacktrace.frames;
    expect(frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(frames)).not.toContain(process.cwd());
  });

  test('fail closed: if the scrubbing itself breaks, the event is dropped, not sent raw', async () => {
    const t = fakeTransport();
    await startWith(t);
    jest.spyOn(logRedaction, 'redactString').mockImplementation(() => {
      throw new Error('redaction broke');
    });
    expect(() => errorTracker.captureException(new Error('secret jane@example.test'))).not.toThrow();
    await settle();
    expect(t.events()).toHaveLength(0);
  });
});

describe('OBS-02: Sentry never changes a response', () => {
  const makeApp = (user = { id: 'user-1' }) => {
    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.user = user;
      req.tenantId = 'tenant-9';
      next();
    });
    app.get('/ok', (_req, res) => res.json({ ok: true }));
    app.get('/boom', () => {
      throw new Error('kaboom for jane@example.test');
    });
    app.get('/db', () => {
      throw new DatabaseError(new Error('Table x doesn\'t exist for jane@example.test'));
    });
    app.get('/bad-gateway', () => {
      throw Object.assign(new Error('upstream down'), { statusCode: 502 });
    });
    for (const [path, status] of [['/e400', 400], ['/e401', 401], ['/e403', 403], ['/e404', 404], ['/e409', 409], ['/e422', 422]]) {
      app.get(path, () => {
        throw Object.assign(new Error(`client error ${status}`), { statusCode: status });
      });
    }
    app.use(errorHandler);
    return app;
  };
  const serve = async (app) => {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return server;
  };
  const closeServer = (s) => new Promise((r) => s.close(r));

  test('a 5xx is captured with the request id, tenant, route and user id; the response is unchanged', async () => {
    const t = fakeTransport();
    await startWith(t);
    const server = await serve(makeApp());
    try {
      const res = await request(server).get('/boom').set('X-Request-Id', 'req-500');
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false });
    } finally {
      await closeServer(server);
    }
    await settle();
    const ev = t.events()[0];
    expect(ev.user).toEqual({ id: 'user-1' });
    expect(ev.tags).toMatchObject({ requestId: 'req-500', tenantId: 'tenant-9', route: '/boom' });
    expect(JSON.stringify(ev)).not.toContain('jane@example.test');
  });

  test('database errors and explicit 5xx statuses are captured; the 4xx family is not', async () => {
    const t = fakeTransport();
    await startWith(t);
    const server = await serve(makeApp());
    try {
      expect((await request(server).get('/db')).status).toBe(500);
      expect((await request(server).get('/bad-gateway')).status).toBe(502);
      for (const p of ['/e400', '/e401', '/e403', '/e404', '/e409', '/e422']) await request(server).get(p);
    } finally {
      await closeServer(server);
    }
    await settle();
    expect(t.events()).toHaveLength(2);
    expect(JSON.stringify(t.events())).not.toContain('jane@example.test');
  });

  test('responses are byte-identical with Sentry on and off', async () => {
    const server = await serve(makeApp());
    let off;
    try {
      off = await request(server).get('/boom').set('X-Request-Id', 'same-id');
    } finally {
      await closeServer(server);
    }
    await startWith(fakeTransport());
    const server2 = await serve(makeApp());
    try {
      const on = await request(server2).get('/boom').set('X-Request-Id', 'same-id');
      expect(on.status).toBe(off.status);
      expect(on.text.replace(/"timestamp":"[^"]+"/, '')).toBe(off.text.replace(/"timestamp":"[^"]+"/, ''));
    } finally {
      await closeServer(server2);
    }
  });

  test('a transport that rejects does not change the response or cause an unhandled rejection', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    process.env.SENTRY_DSN = DSN;
    errorTracker._resetForTests();
    errorTracker.init({ transport: () => ({ send: async () => { throw new Error('network down'); }, flush: async () => true }) });
    const server = await serve(makeApp());
    try {
      const res = await request(server).get('/boom');
      expect(res.status).toBe(500);
      await settle();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      await closeServer(server);
    }
  });

  test('a transport that never answers does not slow the response, and flush gives up on time', async () => {
    process.env.SENTRY_DSN = DSN;
    errorTracker._resetForTests();
    errorTracker.init({ transport: () => ({ send: () => new Promise(() => {}), flush: () => new Promise(() => {}) }) });
    const server = await serve(makeApp());
    try {
      const t0 = Date.now();
      const res = await request(server).get('/boom');
      expect(res.status).toBe(500);
      expect(Date.now() - t0).toBeLessThan(500);
      const f0 = Date.now();
      await expect(errorTracker.flush(200)).resolves.toBe(false);
      expect(Date.now() - f0).toBeLessThan(1000);
    } finally {
      await closeServer(server);
    }
  });

  test('an SDK that throws on capture does not change the response', async () => {
    await startWith(fakeTransport());
    jest.spyOn(require('@sentry/node'), 'captureException').mockImplementation(() => {
      throw new Error('sdk exploded');
    });
    const server = await serve(makeApp());
    try {
      const res = await request(server).get('/boom');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  test('a request with no user still captures, with no user field', async () => {
    const t = fakeTransport();
    await startWith(t);
    const server = await serve(makeApp(null));
    try {
      await request(server).get('/boom');
    } finally {
      await closeServer(server);
    }
    await settle();
    expect(t.events()[0].user).toBeUndefined();
  });
});

describe('OBS-02: process level', () => {
  const fs = require('fs');
  const server = fs.readFileSync(require.resolve('../../server.js'), 'utf8');

  test('uncaught exceptions and unhandled rejections are reported, and the queue is flushed on the way out', () => {
    expect(server).toMatch(/process\.on\('uncaughtException'[\s\S]*captureException[\s\S]*flush/);
    expect(server).toMatch(/process\.on\('unhandledRejection'[\s\S]*captureException/);
    expect(server).toMatch(/Shutting down gracefully[\s\S]*flush/);
  });

  test('app.js starts the tracker (a no-op without a DSN)', () => {
    expect(fs.readFileSync(require.resolve('../../app.js'), 'utf8')).toMatch(/error-tracker'\)\.init\(\)/);
  });

  test('flush resolves true when the transport is healthy and never rejects', async () => {
    await startWith(fakeTransport());
    errorTracker.captureException(new Error('x'));
    await expect(errorTracker.flush(1000)).resolves.toBe(true);
  });
});
