/**
 * R-25 (seed script) — src/scripts/provision-seeded-tenants.js uses only the
 * configured tenant DB credentials.
 *
 * It used to fall back to admin user `root`, an empty admin password, app user
 * `gymsera_tenant` and the built-in app password 'tenant_pass'. It now reads
 * the same getTenantDbConfig as tenant provisioning (R-25) and stops, before
 * connecting to anything, when a setting is missing.
 *
 * The end-to-end check runs the real script in a child process whose working
 * directory is an empty temp folder (dotenv finds no .env) with the test
 * network jail preloaded, so nothing can leave the machine.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'src', 'scripts', 'provision-seeded-tenants.js');
const JAIL = path.join(ROOT, 'tests', 'harness', 'no-network.js');
const VARS = ['TENANT_DB_ADMIN_USER', 'TENANT_DB_ADMIN_PASS', 'TENANT_DB_USER', 'TENANT_DB_PASS'];

describe('R-25: seed provisioning script has no credential fallback', () => {
  const seedScript = require(SCRIPT);
  const provisioning = require('../../src/services/tenant-provisioning.service');

  test('it reuses the provisioning service config (one implementation, no local defaults)', () => {
    expect(seedScript.getTenantDbConfig).toBe(provisioning.getTenantDbConfig);
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/tenant_pass/);
    expect(source).not.toMatch(/\|\|\s*'root'/);
    expect(source).not.toMatch(/TENANT_DB_\w+\s*\|\|/);
  });

  test.each(VARS)('missing %s → TENANT_DB_NOT_CONFIGURED, never root / empty / tenant_pass', (key) => {
    const env = { TENANT_DB_ADMIN_USER: 'seed_admin', TENANT_DB_ADMIN_PASS: 'a', TENANT_DB_USER: 'seed_app', TENANT_DB_PASS: 'b' };
    delete env[key];
    expect(() => seedScript.getTenantDbConfig(env)).toThrow(expect.objectContaining({ code: 'TENANT_DB_NOT_CONFIGURED' }));
  });

  test('running the script with no tenant DB settings exits 1 with a clear message before connecting', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gymsera-seed-r25-'));
    try {
      const env = { PATH: process.env.PATH, NODE_ENV: 'test', TENANT_CONN_ENCRYPTION_KEY: process.env.TENANT_CONN_ENCRYPTION_KEY };
      const res = spawnSync(process.execPath, ['-r', JAIL, SCRIPT], { cwd, env, encoding: 'utf8', timeout: 20000 });
      const out = `${res.stdout}\n${res.stderr}`;
      expect(res.status).toBe(1);
      expect(out).toMatch(/Tenant database server is not configured: missing TENANT_DB_ADMIN_USER, TENANT_DB_ADMIN_PASS, TENANT_DB_USER, TENANT_DB_PASS/);
      // Stopped before any connection attempt: no platform DB connect, no blocked socket.
      expect(out).not.toMatch(/Found \d+ tenant|ECONNREFUSED|no-network\]/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
