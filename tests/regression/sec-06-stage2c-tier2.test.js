/**
 * SEC-06 stage 2c: tier 2 (host, me, tenants, subscriptions, gyms, member, membership-plans). Routes that had no
 * validator now declare their body fields with validate.allowBody and run strict in LOG mode (R-61: reject on 2026-12-20).
 * Multipart upload routes are not covered here (the body is parsed by multer, SEC-06 stage 3).
 *  - tests/fixtures/sec-06-stage2c-bodies.json pins, per route, the declared fields (changing one is a conscious edit)
 *    and the keys the clients send (which must stay accepted).
 */
const fixture = require('../fixtures/sec-06-stage2c-bodies.json');
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
  test.each(fixture.routes.map((r) => [`${r.method} ${r.path}`, r]))('%s', (key, r) => {
    const found = routes.filter((x) => x.key === key);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) {
      expect(f.stage).toBe(2);
      expect([...f.allowed].sort()).toEqual(r.allowed);
      expect(r.clientKeys.filter((k) => !f.allowed.includes(k))).toEqual([]);
    }
  });

  test('every tier-2 route that takes a JSON body is covered (only the multipart uploads are left out: their body is read by multer)', () => {
    const T2 = /^\/api\/v1\/(host|me|tenants|subscriptions|gyms|member|membership-plans)\//;
    const missing = routes
      .filter((x) => T2.test(x.key.split(' ')[1]) && /^(POST|PUT|PATCH|DELETE) /.test(x.key) && x.stage === null)
      .map((x) => x.key)
      .sort();
    expect(missing).toEqual([
      'POST /api/v1/gyms/branches/:p/images',
      'POST /api/v1/gyms/profile/cover',
      'POST /api/v1/gyms/profile/images',
      'POST /api/v1/gyms/profile/logo',
      'POST /api/v1/host/listings/staging-images',
      'POST /api/v1/membership-plans/:p/poster',
      'POST /api/v1/me/payment-requests/:p/proof',
      'POST /api/v1/me/payments/:p/proof',
      'POST /api/v1/me/profile-image',
      'POST /api/v1/me/profile/image',
      'POST /api/v1/subscriptions/:p/proof',
      'POST /api/v1/tenants/:p/kyc-documents',
      'POST /api/v1/tenants/:p/onboarding-images',
    ].sort());
  });
});

describe('an undeclared field on a tier-2 route', () => {
  test('is logged and the call still works (log mode)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await asPersona('owner').post('/host/expense-categories', { name: 'Cleaning', evil: 1 });
    expect(res.status).toBeLessThan(300);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('[unknown-fields]');
    expect(logged).toContain('evil');
    warn.mockRestore();
  });

  test('is a 422 with UNKNOWN_FIELDS_STAGE2_MODE=reject', async () => {
    process.env.UNKNOWN_FIELDS_STAGE2_MODE = 'reject';
    const res = await asPersona('owner').post('/host/expense-categories', { name: 'Cleaning 2', evil: 1 });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('unknown_field');
  });

  test('a declared-only body logs nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await asPersona('owner').post('/host/expense-categories', { name: 'Cleaning 3' });
    expect(res.status).toBeLessThan(300);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('[unknown-fields]');
    warn.mockRestore();
  });
});
