/**
 * NEW-131 — apistaging.gymsera.com runs on the same server as production. Nothing stopped it from
 * using the production platform database: PLATFORM_DB_NAME falls back to `gymsera_platform` when
 * unset (database.config.js), and .env.example paired that name with
 * APP_URL=https://apistaging.gymsera.com. A staging API (older code) on the production platform
 * database approves gyms into production with staging's code (a NEW-127 lead).
 *
 * Staging = NODE_ENV=staging, GYMSERA_ENV=staging, or an APP_URL host containing "staging".
 * The production platform database = PRODUCTION_PLATFORM_DB_NAME, default `gymsera_platform`.
 * Staging on that database refuses to start (server.js and the Vercel entry), before any
 * database connection. `node src/scripts/check-environment.js` gives the same verdict without
 * starting, so each site's .env can be checked before a deploy.
 */
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { checkEnvironment, assertEnvironmentSafe } = require('../../src/config/environment-guard');

const ROOT = path.join(__dirname, '..', '..');

describe('checkEnvironment', () => {
  test.each([
    ['NODE_ENV=staging on the production name', { NODE_ENV: 'staging', PLATFORM_DB_NAME: 'gymsera_platform' }],
    ['GYMSERA_ENV=staging on the production name', { NODE_ENV: 'production', GYMSERA_ENV: 'staging', PLATFORM_DB_NAME: 'gymsera_platform' }],
    ['APP_URL apistaging on the production name', { NODE_ENV: 'production', APP_URL: 'https://apistaging.gymsera.com', PLATFORM_DB_NAME: 'gymsera_platform' }],
    ['APP_URL apistaging with PLATFORM_DB_NAME unset (falls back to the production name)', { NODE_ENV: 'development', APP_URL: 'https://apistaging.gymsera.com' }],
    ['staging on a production name set by PRODUCTION_PLATFORM_DB_NAME', { NODE_ENV: 'staging', PLATFORM_DB_NAME: 'gymsera_live', PRODUCTION_PLATFORM_DB_NAME: 'gymsera_live' }],
  ])('refused: %s', (_label, env) => {
    const result = checkEnvironment(env);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/staging .* production platform database/);
    expect(() => assertEnvironmentSafe(env)).toThrow(expect.objectContaining({ code: 'STAGING_ON_PRODUCTION_DB' }));
  });

  test.each([
    ['production on the production name', { NODE_ENV: 'production', APP_URL: 'https://api.gymsera.com', PLATFORM_DB_NAME: 'gymsera_platform' }],
    ['staging on its own database', { NODE_ENV: 'staging', APP_URL: 'https://apistaging.gymsera.com', PLATFORM_DB_NAME: 'gymsera_staging_platform' }],
    ['staging on gymsera_platform when production uses another name', { NODE_ENV: 'staging', PLATFORM_DB_NAME: 'gymsera_platform', PRODUCTION_PLATFORM_DB_NAME: 'gymsera_live' }],
    ['local development', { NODE_ENV: 'development', APP_URL: 'http://localhost:3000', PLATFORM_DB_NAME: 'gymsera_platform' }],
    ['tests', { NODE_ENV: 'test', PLATFORM_DB_NAME: 'gymsera_test_platform' }],
  ])('allowed: %s', (_label, env) => {
    expect(checkEnvironment(env).ok).toBe(true);
    expect(() => assertEnvironmentSafe(env)).not.toThrow();
  });

  test('the host check is on the APP_URL host only (a path or query naming staging is not staging)', () => {
    expect(checkEnvironment({ NODE_ENV: 'production', APP_URL: 'https://api.gymsera.com/staging?x=staging', PLATFORM_DB_NAME: 'gymsera_platform' }).ok).toBe(true);
    expect(checkEnvironment({ NODE_ENV: 'production', APP_URL: 'not a url', PLATFORM_DB_NAME: 'gymsera_platform' }).ok).toBe(true);
  });
});

const STAGING_ON_PRODUCTION = {
  NODE_ENV: 'production',
  APP_URL: 'https://apistaging.gymsera.com',
  PLATFORM_DB_NAME: 'gymsera_platform',
  PRODUCTION_PLATFORM_DB_NAME: '',
  GYMSERA_ENV: '',
  // Unreachable on purpose: the guard must stop the server before it tries.
  PLATFORM_DB_HOST: 'db.gymsera-test.invalid',
  ERROR_LOG_DIR: 'off',
  PORT: '0',
};

test('server.js on staging with the production platform database refuses to start, before any database connection', async () => {
  const child = spawn(process.execPath, ['-r', './tests/harness/no-network.js', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...STAGING_ON_PRODUCTION },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 20000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });

  // NODE_ENV=production: the logger writes JSON lines to stdout (OBS-01), so read both streams.
  expect(exitCode).toBe(1);
  expect(`${stdout}${stderr}`).toMatch(/Refusing to start: staging \(APP_URL host apistaging\.gymsera\.com\) is configured with the production platform database 'gymsera_platform'/);
  expect(stdout).not.toMatch(/GymsEra API running/);
  expect(`${stdout}${stderr}`).not.toMatch(/\[Platform DB\]/); // stopped before touching the database
}, 30000);

test('the Vercel entry point refuses to load on staging with the production platform database', () => {
  const saved = { ...process.env };
  Object.assign(process.env, STAGING_ON_PRODUCTION);
  try {
    expect(() => jest.isolateModules(() => require('../../api/index'))).toThrow(/Refusing to start: staging/);
  } finally {
    for (const key of Object.keys(STAGING_ON_PRODUCTION)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('check-environment.js gives the verdict without starting: exit 2 and the reason when refused, exit 0 when allowed', () => {
  const run = (env) => spawnSync(process.execPath, ['src/scripts/check-environment.js'], {
    cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000,
  });
  const refused = run(STAGING_ON_PRODUCTION);
  expect(refused.status).toBe(2);
  expect(refused.stdout).toMatch(/platform database: gymsera_platform/);
  expect(refused.stdout).toMatch(/REFUSED: staging \(APP_URL host apistaging\.gymsera\.com\)/);

  const allowed = run({ ...STAGING_ON_PRODUCTION, PLATFORM_DB_NAME: 'gymsera_staging_platform' });
  expect(allowed.status).toBe(0);
  expect(allowed.stdout).toMatch(/OK: /);
});
