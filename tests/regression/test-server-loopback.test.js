/**
 * TEST-FLAKE-1B — the intermittent full-suite failure (a different test each
 * time: 403 / 400 / "socket hang up", nothing in the app's own logs).
 *
 * Cause: supertest started the bare app on a random port on every address (::)
 * but called 127.0.0.1. When the OS picked a port another local program held on
 * 127.0.0.1 only, that program answered. Fix: tests call a server already
 * listening on 127.0.0.1 (tests/harness/test-server.js); a random-port,
 * every-address listen is refused in tests (tests/harness/loopback-listen.js).
 */
const http = require('http');
const request = require('supertest');
const { startTestServer, stopTestServer } = require('../harness/test-server');

const listen = (server, ...args) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, () => resolve(server));
  });
const close = (server) => new Promise((resolve) => server.close(() => resolve()));
const get = (port) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

describe('TEST-FLAKE-1B: tests call a server that listens where they call it', () => {
  let other;

  beforeEach(async () => {
    // Another program on this machine, bound to 127.0.0.1 only.
    other = http.createServer((_req, res) => {
      res.statusCode = 403;
      res.end('someone else');
    });
    await listen(other, 0, '127.0.0.1');
  });

  afterEach(async () => {
    await close(other);
  });

  afterAll(stopTestServer);

  test('the mechanism: an every-address listen on that port is allowed on macOS, and 127.0.0.1 then reaches the other program', async () => {
    const port = other.address().port;
    const ours = http.createServer((_req, res) => res.end('our app'));
    try {
      await listen(ours, port); // no host = every address, as supertest's app.listen(0) got
    } catch (err) {
      // Linux refuses this bind (EADDRINUSE): the collision cannot happen there.
      expect(err.code).toBe('EADDRINUSE');
      return;
    }
    const res = await get(port);
    await close(ours);
    expect(res).toEqual({ status: 403, body: 'someone else' });
  });

  test('a random-port, every-address listen is refused in tests, with the fix in the message', () => {
    expect(() => http.createServer().listen(0)).toThrow(/127\.0\.0\.1.*test-server/);
    expect(() => http.createServer().listen({ port: 0 })).toThrow(/test-server/);
  });

  test('the test server listens on 127.0.0.1 — never on a port another program holds there — and supertest reaches our app', async () => {
    const server = await startTestServer();
    expect(server.address().address).toBe('127.0.0.1');
    expect(server.address().port).not.toBe(other.address().port);

    const res = await request(server).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.text).not.toBe('someone else');
  });
});
