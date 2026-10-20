/**
 * SEC-04: the real app mounts the per-route limiters (the unit file builds its own app).
 * No database needed: the limiter answers before the controller runs.
 */
process.env.RATE_LIMIT_LOGIN_ID_MAX = '2';
process.env.RATE_LIMIT_SEARCH_IP_MAX = '2';

const request = require('supertest');
const { startTestServer, stopTestServer } = require('../harness/test-server');

let server;
beforeAll(async () => { server = await startTestServer(); });
afterAll(stopTestServer);

test('POST /auth/login for one account answers 429 with Retry-After after its limit', async () => {
  const send = () => request(server).post('/api/v1/auth/login').send({ email: 'wiring@example.com', password: 'x' });
  const first = await send();
  const second = await send();
  const third = await send();
  expect(first.status).not.toBe(429);
  expect(second.status).not.toBe(429);
  expect(third.status).toBe(429);
  expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  expect(third.body.code).toBe('rate_limit_exceeded');
});

test('GET /discovery/* is limited per IP', async () => {
  const get = () => request(server).get('/api/v1/discovery/cities');
  await get();
  await get();
  const limited = await get();
  expect(limited.status).toBe(429);
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
});
