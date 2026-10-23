/**
 * SEC-06 stage 3: tier 3 (admin, notifications, cities, staff, staff-invites, attendance, users, payments proof, and the
 * multipart upload routes left by tier 2). Routes that had no validator now declare their body fields and run strict in
 * LOG mode (R-61: reject on 2026-12-20). For a multipart route the declared body is its text fields (files are not body).
 *  - tests/fixtures/sec-06-stage3-bodies.json pins, per route, the declared fields (changing one is a conscious edit)
 *    and the keys the clients send (which must stay accepted).
 *  - The routes that stay without a declaration are listed below, each with its reason; any new route without one fails.
 */
const fixture = require('../fixtures/sec-06-stage3-bodies.json');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const walk = require('../harness/route-walk');

const ENV = ['UNKNOWN_FIELDS_MODE', 'UNKNOWN_FIELDS_STAGE2_MODE'];
const saved = {};
beforeEach(() => ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
afterEach(() => ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  await startTestServer();
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('declared fields per route (fixture)', () => {
  const routes = walk(require('../../app')._router.stack);

  test('the fixture is not empty', () => {
    expect(fixture.routes.length).toBeGreaterThan(50);
  });

  test.each(fixture.routes.map((r) => [`${r.method} ${r.path}`, r]))('%s', (key, r) => {
    const found = routes.filter((x) => x.key === key);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) {
      expect(f.stage).toBe(2);
      expect([...f.allowed].sort()).toEqual(r.allowed);
      expect(r.clientKeys.filter((k) => !f.allowed.includes(k))).toEqual([]);
    }
  });

  test('every mutating route declares its body, except these (not user-facing JSON: provider webhooks, devices, one dynamic command route)', () => {
    const missing = [...new Set(
      routes.filter((x) => /^(POST|PUT|PATCH|DELETE) /.test(x.key) && x.stage === null).map((x) => x.key)
    )].sort();
    expect(missing).toEqual([
      'POST /api/v1/actions/:p', // body is { payload, idempotencyKey }; the payload shape belongs to each command (SEC-06 tier 4)
      'POST /api/v1/attendance/device-notify', // biometric device push, authenticated by device key
      'POST /api/v1/billing/webhooks/apple', // provider payloads, authenticated by signature (SEC-03)
      'POST /api/v1/billing/webhooks/google',
      'POST /api/v1/billing/webhooks/stripe',
      'POST /iclock/cdata', // ZKTeco device protocol
      'POST /iclock/devicecmd',
    ]);
  });
});

describe('an undeclared field on a tier-3 route', () => {
  test('is logged and the call still works (log mode)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await asPersona('member').post('/notifications/read-all', { evil: 1 });
    expect(res.status).toBeLessThan(300);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('[unknown-fields]');
    expect(logged).toContain('evil');
    warn.mockRestore();
  });

  test('is a 422 with UNKNOWN_FIELDS_STAGE2_MODE=reject', async () => {
    process.env.UNKNOWN_FIELDS_STAGE2_MODE = 'reject';
    const res = await asPersona('member').post('/notifications/read-all', { evil: 1 });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('unknown_field');
  });

  test('a declared-only body logs nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await asPersona('member').post('/notifications/read-all', {});
    expect(res.status).toBeLessThan(300);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('[unknown-fields]');
    warn.mockRestore();
  });
});
