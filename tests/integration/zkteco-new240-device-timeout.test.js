/**
 * NEW-240: the push load test's "socket hang up" in CI (twice), reproduced with the CPU limited (the Mac's
 * efficiency cores, or docker --cpus=0.25).
 *
 * On a slow server, device requests (devicecmd, getrequest) and Push now ran past 15 s: every query takes a
 * tenant pool connection on its own, first come first served (3 connections), behind 50 polling devices.
 *   1. The API's 15-second timeout (app.js, mounted before the device router) answered the DEVICE with a JSON
 *      408 while the device handler carried on; the handler's own answer then threw ERR_HTTP_HEADERS_SENT
 *      (device-push.routes.js:116 from :403, the code frame in CI). A getrequest that had already claimed
 *      commands lost them to the 408 until the ack timeout (DEVICE_ACK_TIMEOUT_SECONDS, 60 s, then the jobs).
 *   2. The load test stopped at its first failure with 50 device loops still polling, and the harness closed
 *      the server under them: "socket hang up" (or ECONNRESET), the error CI showed last. Fixed in the test.
 * The slowness itself (Push now 163 queries for one member on 10 devices) is NEW-238, an owner decision.
 *
 * Checked here: a device path answers in the device protocol however slow, never with the API's 408, and
 * nothing writes its answer twice; API routes keep their timeout.
 */
const http = require('http');
const express = require('express');
const { createWorld } = require('../harness/zkteco-world');
const registry = require('../../src/services/devices/device-registry.service');
const { requestTimeout } = require('../../src/middleware/timeout');

let w;
beforeAll(async () => { w = await createWorld(); }, 120000);
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });
afterEach(() => jest.restoreAllMocks());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (app) => new Promise((resolve) => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

describe('the API request timeout never answers a device (NEW-240)', () => {
  test('a device request slower than the timeout gets its own text answer, not a JSON 408; the API still gets 408', async () => {
    const branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
    const d = await w.device(w.db1, { branch, name: 'Slow Door' });

    // The app's order (app.js): the timeout, then the push-host guard and the device router. 150 ms here.
    const errors = [];
    const app = express();
    app.use(requestTimeout(150));
    app.use(require('../../src/middleware/pushHostGuard'));
    app.use(require('../../src/routes/device-push.routes'));
    app.get('/api/v1/slow', async (_req, res) => { await wait(400); if (!res.headersSent) res.json({ ok: true }); });
    app.use((err, _req, res, _next) => { errors.push(err); if (!res.headersSent) res.status(500).end(); });
    const onRejection = (err) => errors.push(err);
    process.on('unhandledRejection', onRejection);
    const server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const original = registry.detailsOf;
      jest.spyOn(registry, 'detailsOf').mockImplementation(async (...a) => { await wait(400); return original(...a); });

      d.sim.baseUrl = base;
      const poll = await d.sim.poll();
      expect(poll.status).toBe(200);
      expect(poll.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(poll.text).not.toMatch(/request_timeout|"success"/);
      expect(poll.ms).toBeGreaterThanOrEqual(400); // the handler's own answer, after the slow step

      const api = await new Promise((resolve, reject) => {
        http.get(`${base}/api/v1/slow`, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, text: t })); }).on('error', reject);
      });
      expect(api.status).toBe(408); // the API keeps its 15-second rule (150 ms here)
      expect(api.text).toMatch(/request_timeout/);

      await wait(600); // anything still running finishes
      expect(errors.map((e) => e && e.code)).not.toContain('ERR_HTTP_HEADERS_SENT');
      expect(errors).toEqual([]);
    } finally {
      d.sim.baseUrl = w.baseUrl;
      process.off('unhandledRejection', onRejection);
      await new Promise((r) => server.close(r));
    }
  }, 60000);

  test('both device path forms are exempt (/iclock/… and /d/<key>/iclock/…); lookalike API paths are not', async () => {
    const app = express();
    app.use(requestTimeout(50));
    const slow = async (_req, res) => { await wait(150); if (!res.headersSent) res.type('text/plain').send('OK\n'); };
    app.get('/iclock/getrequest', slow);
    app.get('/d/ABCD2345/iclock/getrequest', slow);
    app.get('/api/v1/iclock-report', slow);
    const server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (path) => new Promise((resolve, reject) => {
      http.get(base + path, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, text: t })); }).on('error', reject);
    });
    try {
      expect(await get('/iclock/getrequest?SN=X')).toEqual({ status: 200, text: 'OK\n' });
      expect(await get('/d/ABCD2345/iclock/getrequest?SN=X')).toEqual({ status: 200, text: 'OK\n' });
      expect((await get('/api/v1/iclock-report')).status).toBe(408);
    } finally {
      await wait(200);
      await new Promise((r) => server.close(r));
    }
  });
});
