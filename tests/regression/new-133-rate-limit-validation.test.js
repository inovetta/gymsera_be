/**
 * NEW-133 — every startup logged one `ValidationError: options.validate.keyGeneratorIpFallback is not
 * recognized` per rate limiter (12 lines, with stacks). The option exists from express-rate-limit 8;
 * the installed version is 7.5.x, which rejects unknown validate keys. The startup log must be clean:
 * building the limiters and counting a request log no express-rate-limit validation error.
 */
const express = require('express');
const request = require('supertest');
const { createLimiters } = require('../../src/middleware/rateLimiters');

const ERL = /ERR_ERL_|ValidationError|is not recognized/;

let spies;
beforeEach(() => {
  spies = ['error', 'warn', 'log'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => jest.restoreAllMocks());

const logged = () => spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).filter((l) => ERL.test(l));

test('building every limiter logs no express-rate-limit validation error', () => {
  const limiters = createLimiters();
  expect(Object.keys(limiters).length).toBeGreaterThan(0);
  expect(logged()).toEqual([]);
});

test('a request through a limiter logs none either, and is still counted (429 after the limit)', async () => {
  const saved = process.env.RATE_LIMIT_LOGIN_IP_MAX;
  process.env.RATE_LIMIT_LOGIN_IP_MAX = '3';
  const { loginIp } = createLimiters();
  if (saved === undefined) delete process.env.RATE_LIMIT_LOGIN_IP_MAX;
  else process.env.RATE_LIMIT_LOGIN_IP_MAX = saved;
  const app = express();
  app.post('/login', loginIp, (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    let last;
    for (let i = 0; i < 4; i += 1) {
      last = await request(server).post('/login');
    }
    expect(last.status).toBe(429);
    expect(logged()).toEqual([]);
  } finally {
    server.close();
  }
});
