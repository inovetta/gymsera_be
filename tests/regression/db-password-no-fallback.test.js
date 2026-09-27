/**
 * SEC-DB-FALLBACK — the server must refuse to start without the database
 * password variables, never fall back to a built-in password. An explicitly
 * empty value (local/CI MySQL with no root password) still counts as set.
 *
 * The end-to-end checks start the real server.js / api/index.js in a child
 * process whose working directory is an empty temp folder (so dotenv finds no
 * .env) with the test network jail preloaded — nothing can leave the machine
 * even if the check were broken.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const JAIL = path.join(ROOT, 'tests', 'harness', 'no-network.js');
const DB_VARS = ['PLATFORM_DB_PASS', 'TENANT_DB_ADMIN_PASS', 'TENANT_DB_PASS'];

const loadDatabaseConfig = (overrides) => {
  const saved = {};
  for (const key of DB_VARS) saved[key] = process.env[key];
  let config;
  try {
    for (const key of DB_VARS) delete process.env[key];
    Object.assign(process.env, overrides);
    jest.isolateModules(() => {
      config = require('../../src/config/database.config');
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return config;
};

/** Runs node in an empty temp folder with only the env given; resolves { code, stdout, stderr }. */
const runNode = (args, env) =>
  new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'no-db-env-'));
    const child = spawn(process.execPath, ['-r', JAIL, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });

// Everything the server needs to get as far as the database check — but no DB passwords.
const envWithoutDbPasswords = () => ({
  PATH: process.env.PATH,
  NODE_ENV: 'test',
  PORT: '0',
  SMTP_HOST: 'smtp.gymsera-test.invalid',
  SMTP_USER: 'noreply@gymsera.test',
  SMTP_PASS: 'test-only-not-a-real-password',
});

describe('database passwords have no built-in fallback', () => {
  test('with the variables unset, the config holds no password at all', () => {
    const config = loadDatabaseConfig({});
    expect(config.platform.password).toBeUndefined();
    expect(config.tenantServer.adminPass).toBeUndefined();
    expect(config.tenantServer.pass).toBeUndefined();
  });

  test('assertDatabaseConfigured names every missing variable; explicitly empty values are allowed', () => {
    const { assertDatabaseConfigured, missingDatabaseSettings } = loadDatabaseConfig({});
    expect(missingDatabaseSettings({})).toEqual(DB_VARS);
    expect(() => assertDatabaseConfigured({ PLATFORM_DB_PASS: 'x', TENANT_DB_ADMIN_PASS: 'y' })).toThrow(
      /missing TENANT_DB_PASS/
    );
    expect(() =>
      assertDatabaseConfigured({ PLATFORM_DB_PASS: '', TENANT_DB_ADMIN_PASS: '', TENANT_DB_PASS: '' })
    ).not.toThrow();
  });

  test('starting server.js without the database passwords fails clearly and never touches a database', async () => {
    const { code, stdout, stderr } = await runNode([path.join(ROOT, 'server.js')], envWithoutDbPasswords());

    expect(code).toBe(1);
    expect(stderr).toMatch(/Database is not configured: missing PLATFORM_DB_PASS, TENANT_DB_ADMIN_PASS, TENANT_DB_PASS/);
    expect(stdout).not.toMatch(/\[Platform DB\] Connected/);
    expect(stdout).not.toMatch(/GymsEra API running/);
  }, 30000);

  test('the Vercel entry point refuses to load without the database passwords', async () => {
    const { code, stderr } = await runNode(
      ['-e', `require(${JSON.stringify(path.join(ROOT, 'api', 'index.js'))})`],
      envWithoutDbPasswords()
    );
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/Database is not configured: missing PLATFORM_DB_PASS/);
  }, 30000);
});
