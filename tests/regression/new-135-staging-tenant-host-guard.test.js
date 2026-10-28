/**
 * NEW-135 — the staging guard (NEW-131, NEW-134) compared only the platform database name. Tenant
 * databases are named `gymsera_<tenant code>` whatever the platform database is
 * (tenant-provisioning.service.js#buildDbName), so a staging site with its own platform database but
 * production's tenant server could still create and use databases there. On 2026-10-28 both sites'
 * .env files had TENANT_DB_HOST=209.209.42.64 (owner evidence).
 *
 * Now a staging site whose resolved tenant host (the one provisioning connects to: TENANT_DB_HOST,
 * else PLATFORM_DB_HOST, else 127.0.0.1) equals the production tenant host refuses to start.
 * Production tenant host = PRODUCTION_TENANT_DB_HOST, default 209.209.42.64 (production's .env).
 * Host names only are printed, never a password.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { checkEnvironment, assertEnvironmentSafe } = require('../../src/config/environment-guard');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'src', 'scripts', 'check-environment.js');
const STAGING = { NODE_ENV: 'staging', APP_URL: 'https://apistaging.gymsera.com', PLATFORM_DB_NAME: 'gymsera_staging_platform' };

describe('checkEnvironment: the tenant server', () => {
  test.each([
    ['TENANT_DB_HOST is the production tenant server', { ...STAGING, TENANT_DB_HOST: '209.209.42.64' }, /TENANT_DB_HOST/],
    ['TENANT_DB_HOST unset: provisioning falls back to PLATFORM_DB_HOST', { ...STAGING, PLATFORM_DB_HOST: '209.209.42.64' }, /PLATFORM_DB_HOST/],
    ['a production tenant host set by PRODUCTION_TENANT_DB_HOST (case and spaces ignored)', { ...STAGING, TENANT_DB_HOST: 'DB.Example.TEST ', PRODUCTION_TENANT_DB_HOST: 'db.example.test' }, /TENANT_DB_HOST/],
  ])('refused: %s', (_label, env, sourceName) => {
    const r = checkEnvironment(env, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/production tenant database server/);
    expect(r.reason).toMatch(sourceName);
    expect(() => assertEnvironmentSafe(env, {})).toThrow(expect.objectContaining({ code: 'STAGING_ON_PRODUCTION_DB' }));
  });

  test.each([
    ['staging on its own tenant server', { ...STAGING, TENANT_DB_HOST: '10.0.0.9' }],
    ['staging with no tenant host set (127.0.0.1)', { ...STAGING }],
    ['staging on 209.209.42.64 when PRODUCTION_TENANT_DB_HOST names another host', { ...STAGING, TENANT_DB_HOST: '209.209.42.64', PRODUCTION_TENANT_DB_HOST: '10.0.0.5' }],
    ['production itself on the production tenant server', { NODE_ENV: 'production', APP_URL: 'https://api.gymsera.com', PLATFORM_DB_NAME: 'gymsera', TENANT_DB_HOST: '209.209.42.64' }],
  ])('allowed: %s', (_label, env) => {
    expect(checkEnvironment(env, {}).ok).toBe(true);
  });

  test('the result names both tenant hosts and where they came from', () => {
    const r = checkEnvironment({ ...STAGING, TENANT_DB_HOST: '209.209.42.64' }, { TENANT_DB_HOST: '209.209.42.64' });
    expect(r.tenantDbHost).toBe('209.209.42.64');
    expect(r.tenantDbHostSource).toBe('TENANT_DB_HOST from .env');
    expect(r.productionTenantDbHost).toBe('209.209.42.64');
    expect(r.productionTenantDbHostSource).toMatch(/built-in production tenant host; PRODUCTION_TENANT_DB_HOST is not set/);
  });

  test("today's apistaging .env (production platform database and tenant server) is refused for both", () => {
    const r = checkEnvironment({ APP_URL: 'https://apistaging.gymsera.com', PLATFORM_DB_NAME: 'gymsera', TENANT_DB_HOST: '209.209.42.64' }, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/production platform database 'gymsera'/);
    expect(r.reason).toMatch(/production tenant database server '209\.209\.42\.64'/);
  });
});

test('the guard checks the same tenant host provisioning connects to', () => {
  const { getTenantDbConfig } = require('../../src/services/tenant-provisioning.service');
  const { resolveTenantDbHost } = require('../../src/config/database.config');
  const creds = { TENANT_DB_ADMIN_USER: 'a', TENANT_DB_ADMIN_PASS: 'x', TENANT_DB_USER: 'b', TENANT_DB_PASS: 'y' };
  for (const env of [{ TENANT_DB_HOST: 'h1' }, { PLATFORM_DB_HOST: 'h2' }, {}]) {
    expect(resolveTenantDbHost({ ...creds, ...env }, {}).host).toBe(getTenantDbConfig({ ...creds, ...env }).host);
  }
});

test('check-environment.js prints the tenant hosts and their sources, never a password', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymsera-n135-'));
  fs.writeFileSync(path.join(dir, '.env'), [
    'APP_URL=https://apistaging.gymsera.com',
    'PLATFORM_DB_NAME=gymsera_staging_platform',
    ' TENANT_DB_HOST=209.209.42.64',
    'TENANT_DB_ADMIN_PASS=n135-admin-secret',
    'TENANT_DB_PASS=n135-tenant-secret',
    'PLATFORM_DB_PASS=n135-platform-secret',
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', timeout: 20000,
  });
  expect(r.stdout).toMatch(/^tenant database server: 209\.209\.42\.64 \(TENANT_DB_HOST from \.env\)$/m);
  expect(r.stdout).toMatch(/^production tenant database server: 209\.209\.42\.64 \(built-in production tenant host/m);
  expect(r.stdout).toMatch(/^REFUSED: .*production tenant database server '209\.209\.42\.64'/m);
  expect(r.status).toBe(2);
  expect(`${r.stdout}${r.stderr}`).not.toMatch(/n135-(admin|tenant|platform)-secret/);
});

test('server.js on staging with the production tenant server refuses to start, before any database connection', async () => {
  const child = spawn(process.execPath, ['-r', './tests/harness/no-network.js', 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      GYMSERA_ENV: '',
      APP_URL: 'https://apistaging.gymsera.com',
      PLATFORM_DB_NAME: 'gymsera_staging_platform',
      PRODUCTION_PLATFORM_DB_NAME: '',
      PRODUCTION_TENANT_DB_HOST: '',
      TENANT_DB_HOST: '209.209.42.64',
      PLATFORM_DB_HOST: 'db.gymsera-test.invalid',
      ERROR_LOG_DIR: 'off',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 20000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  expect(exitCode).toBe(1);
  expect(out).toMatch(/Refusing to start: staging \(APP_URL host apistaging\.gymsera\.com\) is configured with the production tenant database server '209\.209\.42\.64' \(TENANT_DB_HOST from the process environment/);
  expect(out).not.toMatch(/\[Platform DB\]/);
}, 30000);

test('the boot line names the tenant database server and where it came from', () => {
  const saved = process.env.TENANT_DB_HOST;
  process.env.TENANT_DB_HOST = 'tenant-db.n135.test';
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    jest.isolateModules(() => require('../../src/utils/error-journal').boot());
    const line = log.mock.calls.map((c) => c.join(' ')).find((l) => l.startsWith('[ErrorJournal] boot'));
    expect(line).toMatch(/ tenantDbHost=tenant-db\.n135\.test \(TENANT_DB_HOST from (the process environment|\.env)[^)]*\) /);
  } finally {
    log.mockRestore();
    if (saved === undefined) delete process.env.TENANT_DB_HOST;
    else process.env.TENANT_DB_HOST = saved;
  }
});
