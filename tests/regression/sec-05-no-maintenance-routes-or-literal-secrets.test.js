/**
 * SEC-05: no remote-operation routes, no secret literals in tracked source, seeders refuse production.
 *
 * The four /system maintenance routes (run-install, run-pull, configure-fcm, fcm-test) were guarded only by
 * keys committed to git, and two of them ran shell commands. They are deleted (owner decision R-35).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { assertSeedingAllowed, platformAdminPassword } = require('../../src/seeders/seed-guard');

const ROOT = path.join(__dirname, '..', '..');

describe('SEC-05: maintenance routes are gone', () => {
  let server;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(stopTestServer);

  const routes = [
    ['get', '/api/v1/system/run-install'],
    ['get', '/api/v1/system/run-pull'],
    ['post', '/api/v1/system/configure-fcm'],
    ['post', '/api/v1/system/fcm-test'],
  ];

  test.each(routes)('%s %s answers 404, even with the old committed key', async (method, url) => {
    const res = await request(server)[method](`${url}?key=gymsera-fix-socket-2026`)
      .set('x-admin-key', 'gymsera-fcm-test-2026')
      .send({ key: 'gymsera-fix-socket-2026', serviceAccount: {} });
    expect(res.status).toBe(404);
  });

  test('the router no longer starts shell commands', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/routes/index.js'), 'utf8');
    expect(src).not.toMatch(/child_process/);
    expect(src).not.toMatch(/\bexec\(/);
  });
});

describe('SEC-05: no secret literals in tracked source', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(js|json|md|yml|yaml)$/.test(f))
    .filter((f) => !/^(tests|docs)\//.test(f) && !/package-lock\.json$/.test(f));

  const FORBIDDEN = [
    ['old maintenance key', /gymsera-(fix-socket|fcm-test)-2026/],
    ['sequential demo encryption key', /0123456789abcdef0123456789abcdef0123456789abcdef/],
    ['seeded platform admin password', /(SuperAdmin|Admin|Ops|Support)@GymsEra1/],
  ];

  test.each(FORBIDDEN)('no %s in tracked source', (_name, pattern) => {
    const hits = tracked.filter((f) => {
      try { return pattern.test(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (_) { return false; }
    });
    expect(hits).toEqual([]);
  });

  test('the scratch scripts that carried literals are removed', () => {
    for (const f of ['debug-branch-scratch.js', 'debug-orgs.js', 'query-requests.js', 'test-socket-verify.js']) {
      expect(fs.existsSync(path.join(ROOT, f))).toBe(false);
    }
  });
});

describe('SEC-05: seeders', () => {
  test('refuse to run in production', () => {
    expect(() => assertSeedingAllowed({ NODE_ENV: 'production' })).toThrow(/disabled/);
    expect(() => assertSeedingAllowed({ NODE_ENV: 'Production' })).toThrow(/disabled/);
    expect(() => assertSeedingAllowed({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertSeedingAllowed({})).not.toThrow();
  });

  test('platform admin password comes from the env, or is random per run', () => {
    expect(platformAdminPassword({ SEED_ADMIN_PASSWORD: 'from-env-1!' })).toEqual({ password: 'from-env-1!', generated: false });
    const a = platformAdminPassword({});
    const b = platformAdminPassword({});
    expect(a.generated).toBe(true);
    expect(a.password.length).toBeGreaterThanOrEqual(20);
    expect(a.password).not.toBe(b.password);
  });

  test.each(['src/seeders/seed.js', 'src/seeders/seed-tenant.js'])('%s calls the production guard', (f) => {
    expect(fs.readFileSync(path.join(ROOT, f), 'utf8')).toMatch(/assertSeedingAllowed\(\)/);
  });
});
