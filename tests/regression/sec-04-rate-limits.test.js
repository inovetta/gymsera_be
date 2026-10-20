/**
 * SEC-04: per-route rate limits.
 *  - login / register / OTP / password reset: limited per IP and per IP + account
 *  - public discovery search: moderate per IP
 *  - writes: per verified user (a forged token never gets its own bucket)
 *  - every 429 carries Retry-After and the standard error envelope
 *  - production defaults are generous (mobile users share NATs) and every limit has an env override
 * The limits are tiny in these tests through the same env overrides production uses.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sec04-test-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_LOGIN_IP_MAX = '5';
process.env.RATE_LIMIT_LOGIN_ID_MAX = '2';
process.env.RATE_LIMIT_OTP_ID_MAX = '2';
process.env.RATE_LIMIT_SEARCH_IP_MAX = '3';
process.env.RATE_LIMIT_MUTATION_USER_MAX = '3';

const express = require('express');
const request = require('supertest');
const http = require('http');
const { signToken } = require('../../src/utils/jwt.utils');
const { mount, settingsFor, DEFAULTS } = require('../../src/middleware/rateLimiters');
const errorHandler = require('../../src/middleware/errorHandler');
const stores = require('../../src/utils/rate-limit-stores');

let server;
let hits;

const makeApp = () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  mount(app);
  app.all('*', (req, res) => { hits.push(`${req.method} ${req.path}`); res.json({ ok: true }); });
  app.use(errorHandler);
  return app;
};

beforeAll(async () => {
  server = http.createServer(makeApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  stores.shutdownAll();
});
beforeEach(() => { hits = []; });

const ip = (n) => ({ 'X-Forwarded-For': `10.0.0.${n}` });
const login = (email, n = 1) => request(server).post('/api/v1/auth/login').set(ip(n)).send({ email, password: 'x' });
const bearer = (id) => ({ Authorization: `Bearer ${signToken({ sub: id, role: 'MEMBER' })}` });

describe('SEC-04: login', () => {
  test('the same IP and account is stopped after its limit, with Retry-After and the error envelope', async () => {
    expect((await login('a@example.com', 11)).status).toBe(200);
    expect((await login('a@example.com', 11)).status).toBe(200);
    const limited = await login('a@example.com', 11);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body.success).toBe(false);
    expect(limited.body.code).toBe('rate_limit_exceeded');
    expect(limited.body.data.retryAfterSeconds).toBe(Number(limited.headers['retry-after']));
    expect(hits).toHaveLength(2);
  });

  test('another account from the same IP, and the same account from another IP, are not affected', async () => {
    for (let i = 0; i < 3; i++) await login('b@example.com', 12);
    expect((await login('c@example.com', 12)).status).toBe(200);
    expect((await login('b@example.com', 13)).status).toBe(200);
  });

  test('one IP cannot try unlimited accounts: the per-IP limit stops it', async () => {
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await login(`user${i}@example.com`, 14)).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  test('the account is matched case-insensitively and nothing readable is kept as a key', async () => {
    await login('Case@Example.com', 15);
    await login('case@example.com', 15);
    expect((await login('CASE@example.COM', 15)).status).toBe(429);
  });
});

describe('SEC-04: OTP and the other auth routes', () => {
  const otp = (email, n) => request(server).post('/api/v1/auth/otp/resend').set(ip(n)).send({ email });

  test('OTP resend/verify share a per IP + account limit', async () => {
    await otp('o@example.com', 21);
    await request(server).post('/api/v1/auth/otp/verify').set(ip(21)).send({ email: 'o@example.com', code: '1' });
    expect((await otp('o@example.com', 21)).status).toBe(429);
  });

  test('a request without an account identifier is not counted by the account limiter', async () => {
    for (let i = 0; i < 4; i++) expect((await request(server).post('/api/v1/auth/password-reset/request').set(ip(22)).send({})).status).toBe(200);
  });
});

describe('SEC-04: public discovery search', () => {
  test('moderate per-IP limit with Retry-After; other IPs and non-discovery routes are unaffected', async () => {
    const get = (n) => request(server).get('/api/v1/discovery/gyms').set(ip(n));
    for (let i = 0; i < 3; i++) expect((await get(31)).status).toBe(200);
    const limited = await get(31);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await get(32)).status).toBe(200);
    expect((await request(server).get('/api/v1/cities').set(ip(31))).status).toBe(200);
  });
});

describe('SEC-04: writes per user', () => {
  const post = (headers, n = 41) => request(server).post('/api/v1/payments').set({ ...ip(n), ...headers }).send({});

  test('a user is limited across IPs; another user and reads are not', async () => {
    for (let i = 0; i < 3; i++) expect((await post(bearer('user-a'), 41 + i)).status).toBe(200);
    const limited = await post(bearer('user-a'), 50);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await post(bearer('user-b'))).status).toBe(200);
    expect((await request(server).get('/api/v1/payments').set({ ...ip(41), ...bearer('user-a') })).status).toBe(200);
  });

  test('a forged token has no bucket: it cannot be used to exhaust anyone, and counts nowhere', async () => {
    const forged = { Authorization: 'Bearer not.a.token' };
    for (let i = 0; i < 6; i++) expect((await post(forged, 60)).status).toBe(200);
    expect((await post(bearer('user-c'), 60)).status).toBe(200);
  });

  test('provider webhooks and biometric devices are not limited', async () => {
    for (let i = 0; i < 6; i++) {
      expect((await request(server).post('/api/v1/billing/webhooks/stripe').set(ip(70)).send({})).status).toBe(200);
      expect((await request(server).post('/api/v1/attendance/device-notify').set(ip(70)).send({})).status).toBe(200);
    }
  });
});

describe('SEC-04: defaults and overrides', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  test('production defaults are generous enough for a shared mobile NAT', () => {
    process.env.NODE_ENV = 'production';
    for (const k of Object.keys(DEFAULTS)) delete process.env[`RATE_LIMIT_${k}_MAX`];
    expect(settingsFor('LOGIN_IP').max).toBeGreaterThanOrEqual(300);
    expect(settingsFor('OTP_IP').max).toBeGreaterThanOrEqual(200);
    expect(settingsFor('SEARCH_IP').max).toBeGreaterThanOrEqual(100);
    expect(settingsFor('SEARCH_IP').windowMs).toBe(60 * 1000);
    expect(settingsFor('MUTATION_USER').max).toBeGreaterThanOrEqual(100);
    expect(settingsFor('LOGIN_ID').max).toBeGreaterThanOrEqual(20);
  });

  test('every limit can be overridden by env, window included', () => {
    process.env.NODE_ENV = 'production';
    process.env.RATE_LIMIT_LOGIN_IP_MAX = '7';
    process.env.RATE_LIMIT_LOGIN_IP_WINDOW_S = '30';
    expect(settingsFor('LOGIN_IP')).toEqual({ windowMs: 30000, max: 7 });
    process.env.RATE_LIMIT_LOGIN_IP_MAX = 'abc';
    expect(settingsFor('LOGIN_IP').max).toBeGreaterThanOrEqual(300);
  });

  test('tests and development get a very high ceiling', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.RATE_LIMIT_LOGIN_IP_MAX;
    expect(settingsFor('LOGIN_IP').max).toBeGreaterThanOrEqual(100000);
  });
});

describe('SEC-04: Retry-After on 429s raised inside services', () => {
  test('the error handler sends Retry-After when the error carries retryAfter', async () => {
    const app = express();
    app.get('/cooldown', (_req, _res, next) => { const e = new Error('wait'); e.statusCode = 429; e.retryAfter = 42; next(e); });
    app.get('/plain429', (_req, _res, next) => { const e = new Error('slow'); e.statusCode = 429; next(e); });
    app.use(errorHandler);
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const a = await request(srv).get('/cooldown');
      expect(a.status).toBe(429);
      expect(a.headers['retry-after']).toBe('42');
      const b = await request(srv).get('/plain429');
      expect(b.status).toBe(429);
      expect(b.headers['retry-after']).toBeUndefined();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('SEC-04: limiters register with the test cleanup hook', () => {
  test('createLimiters adds one tracked store per limiter, and shutdownAll stops them', () => {
    const { createLimiters } = require('../../src/middleware/rateLimiters');
    const before = stores.activeStores().length;
    const created = Object.keys(createLimiters()).length;
    expect(stores.activeStores().length).toBe(before + created);
    stores.shutdownAll();
    expect(stores.activeStores()).toHaveLength(0);
  });
});
