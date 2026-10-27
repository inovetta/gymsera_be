/**
 * NEW-134 — production connects to the platform database `gymsera` while its .env has no
 * PLATFORM_DB_NAME line. No version of the code defaults to `gymsera` (database.config.js has always
 * said PLATFORM_DB_NAME || 'gymsera_platform'), so the name comes from the process environment set
 * outside .env (Windows / IIS). dotenv never overrides a variable that is already set: such a
 * host-level value also wins over any PLATFORM_DB_NAME line in a site's .env, for every site on the
 * server.
 *
 * The NEW-131 guard and check-environment.js assumed production is `gymsera_platform`, so staging on
 * `gymsera` passed. Now:
 *   - the production platform database defaults to `gymsera` (owner evidence 2026-10-27; still
 *     PRODUCTION_PLATFORM_DB_NAME to override);
 *   - the guard, check-environment.js and the boot line use the name the process resolves and say
 *     where it came from (process environment, .env, or the built-in default), never a password;
 *   - a .env line that the process environment overrides is named;
 *   - the orphan-database drop refuses the platform database the process actually uses (it compared
 *     with `gymsera` while the connection used `gymsera_platform`).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolvePlatformDbName } = require('../../src/config/database.config');
const { checkEnvironment } = require('../../src/config/environment-guard');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'src', 'scripts', 'check-environment.js');

describe('resolvePlatformDbName: the name and where it came from', () => {
  test.each([
    ['unset: the built-in default', {}, {}, { name: 'gymsera_platform', source: /built-in default/ }],
    ['set only in the process environment (host level, not in .env)', { PLATFORM_DB_NAME: 'gymsera' }, {}, { name: 'gymsera', source: /process environment.*not in \.env/ }],
    ['set by .env', { PLATFORM_DB_NAME: 'gymsera_staging' }, { PLATFORM_DB_NAME: 'gymsera_staging' }, { name: 'gymsera_staging', source: /^PLATFORM_DB_NAME from \.env$/ }],
    ['process environment overriding a different .env line', { PLATFORM_DB_NAME: 'gymsera' }, { PLATFORM_DB_NAME: 'gymsera_staging' }, { name: 'gymsera', source: /overrides .env.*"gymsera_staging"/ }],
  ])('%s', (_label, env, parsed, expected) => {
    const r = resolvePlatformDbName(env, parsed);
    expect(r.name).toBe(expected.name);
    expect(r.source).toMatch(expected.source);
  });
});

describe('the staging guard uses the production name production really uses', () => {
  test('staging on `gymsera` (production, set at host level) is refused with no extra setting', () => {
    const r = checkEnvironment({ APP_URL: 'https://apistaging.gymsera.com', PLATFORM_DB_NAME: 'gymsera' }, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/production platform database 'gymsera' \(PLATFORM_DB_NAME from the process environment/);
  });

  test('PRODUCTION_PLATFORM_DB_NAME still overrides the production name', () => {
    const env = { NODE_ENV: 'staging', PLATFORM_DB_NAME: 'gymsera', PRODUCTION_PLATFORM_DB_NAME: 'gymsera_live' };
    expect(checkEnvironment(env, {}).ok).toBe(true);
    expect(checkEnvironment({ ...env, PLATFORM_DB_NAME: 'gymsera_live' }, {}).ok).toBe(false);
  });

  test('production itself on `gymsera` starts', () => {
    expect(checkEnvironment({ NODE_ENV: 'production', APP_URL: 'https://api.gymsera.com', PLATFORM_DB_NAME: 'gymsera' }, {}).ok).toBe(true);
  });
});

describe('check-environment.js prints the resolved name and its source, never a password', () => {
  const run = (env, dotenvText) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymsera-n134-'));
    if (dotenvText !== undefined) fs.writeFileSync(path.join(dir, '.env'), dotenvText);
    const base = { PATH: process.env.PATH, HOME: process.env.HOME, PLATFORM_DB_PASS: 'n134-secret-password', TENANT_DB_PASS: 'n134-other-secret' };
    return spawnSync(process.execPath, [SCRIPT], { cwd: dir, env: { ...base, ...env }, encoding: 'utf8', timeout: 20000 });
  };

  test('host-level PLATFORM_DB_NAME=gymsera on a staging site: REFUSED, source named, exit 2', () => {
    const r = run({ PLATFORM_DB_NAME: 'gymsera' }, 'APP_URL=https://apistaging.gymsera.com\nPLATFORM_DB_PASS=n134-secret-password\n');
    expect(r.stdout).toMatch(/platform database: gymsera \(PLATFORM_DB_NAME from the process environment, not in \.env\)/);
    expect(r.stdout).toMatch(/production platform database: gymsera \(built-in production name/);
    expect(r.stdout).toMatch(/^REFUSED: /m);
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/n134-secret-password|n134-other-secret/);
  });

  test('a .env line that the process environment overrides is named', () => {
    const r = run({ PLATFORM_DB_NAME: 'gymsera' }, 'APP_URL=https://apistaging.gymsera.com\nPLATFORM_DB_NAME=gymsera_staging\n');
    expect(r.stdout).toMatch(/PLATFORM_DB_NAME from the process environment; it overrides \.env, which says "gymsera_staging"/);
    expect(r.status).toBe(2);
  });

  test('a staging site whose own .env name is used: OK, exit 0', () => {
    const r = run({}, 'APP_URL=https://apistaging.gymsera.com\nPLATFORM_DB_NAME=gymsera_staging\n');
    expect(r.stdout).toMatch(/platform database: gymsera_staging \(PLATFORM_DB_NAME from \.env\)/);
    expect(r.stdout).toMatch(/^OK: /m);
    expect(r.status).toBe(0);
  });
});

test('the boot line names the platform database and where its name came from', () => {
  const saved = process.env.PLATFORM_DB_NAME;
  process.env.PLATFORM_DB_NAME = 'gymsera_test_n134';
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    jest.isolateModules(() => require('../../src/utils/error-journal').boot());
    const line = log.mock.calls.map((c) => c.join(' ')).find((l) => l.startsWith('[ErrorJournal] boot'));
    expect(line).toMatch(/ platformDb=gymsera_test_n134 \(PLATFORM_DB_NAME from (the process environment|\.env)[^)]*\) /);
  } finally {
    log.mockRestore();
    if (saved === undefined) delete process.env.PLATFORM_DB_NAME;
    else process.env.PLATFORM_DB_NAME = saved;
  }
});

test('the orphan-database drop refuses the platform database the process uses, also when PLATFORM_DB_NAME is unset', async () => {
  const saved = process.env.PLATFORM_DB_NAME;
  delete process.env.PLATFORM_DB_NAME;
  try {
    let drop;
    jest.isolateModules(() => { drop = require('../../src/services/orphan-database.service').dropOrphanTenantDatabase; });
    const adminConn = { query: () => { throw new Error('must not reach the database'); } };
    await expect(drop({ dbName: 'gymsera_platform', adminConn, apply: true, confirm: 'gymsera_platform' }))
      .rejects.toThrow(/that is the platform database/);
  } finally {
    if (saved === undefined) delete process.env.PLATFORM_DB_NAME;
    else process.env.PLATFORM_DB_NAME = saved;
  }
});
