/**
 * Targeted verification for src/scripts/dry-run-release-1-1-backup.js:
 *  - Refuses production targets (exit 2)
 *  - Passes cleanly (exit 0) on a clean schema/data graph (Option S, non-null organization_id, renamed indexes)
 *  - Fails loudly (exit 1) when an Option S business <-> listing link is missing
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { GymListing, Tenant } = require('../../src/models/platform');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'src', 'scripts', 'dry-run-release-1-1-backup.js');

const runDryRun = (extraEnv = {}, extraArgs = []) => {
  const host = process.env.PLATFORM_DB_HOST || process.env.MYSQL_HOST || '127.0.0.1';
  const port = process.env.PLATFORM_DB_PORT || process.env.MYSQL_PORT || '3308';
  const user = process.env.PLATFORM_DB_USER || process.env.MYSQL_USER || 'root';
  const pass = process.env.PLATFORM_DB_PASS !== undefined ? process.env.PLATFORM_DB_PASS : '';
  const dbName = process.env.PLATFORM_DB_NAME || 'gymsera_test_platform';

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PLATFORM_DB_HOST: host,
    PLATFORM_DB_PORT: port,
    PLATFORM_DB_USER: user,
    PLATFORM_DB_PASS: pass,
    PLATFORM_DB_NAME: dbName,
    TENANT_DB_HOST: host,
    TENANT_DB_PORT: port,
    TENANT_DB_ADMIN_USER: user,
    TENANT_DB_ADMIN_PASS: pass,
    TENANT_DB_USER: user,
    TENANT_DB_PASS: pass,
    ...extraEnv,
  };
  return execFileSync(process.execPath, [SCRIPT, '--platform-db', env.PLATFORM_DB_NAME, ...extraArgs], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
};

describe('Release 1.1.0 restored-backup dry-run script', () => {
  let h;
  let personas;

  beforeAll(async () => {
    h = await setupTestDatabases();
    personas = await setupPersonas(h);
    await Tenant.update({ dbName: 'gymsera_test_tenant_1' }, { where: { id: personas.owner.organizationId } });
    await Tenant.update({ dbName: 'gymsera_test_tenant_2' }, { where: { id: personas.otherTenantOwner.organizationId } });
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test('refuses production targets with exit code 2', () => {
    let exitCode = null;
    let stderr = '';
    try {
      runDryRun({ NODE_ENV: 'production' });
    } catch (err) {
      exitCode = err.status;
      stderr = String(err.stderr || '');
    }
    expect(exitCode).toBe(2);
    expect(stderr).toContain('REFUSED:');
  });

  test('passes migrations, row counts, Option S listing IDs, non-null organization_id, and index checks', () => {
    const out = runDryRun();
    expect(out).toContain('Organizations checked     : 2 / 2');
    expect(out).toContain('RESULT: PASS');
    expect(out).toContain('Index checks evaluated');
  });

  test('fails with exit code 1 when an Option S listing has no matching tenant business', async () => {
    const orphanListingId = uuidv4();
    await factories.createGymListing(personas.owner.organizationId, {
      id: orphanListingId,
      name: 'Orphan Listing Without Business',
      status: 'PENDING',
    });

    let exitCode = null;
    let stdout = '';
    try {
      runDryRun({}, ['--verify-only']);
    } catch (err) {
      exitCode = err.status;
      stdout = String(err.stdout || '');
    } finally {
      await GymListing.destroy({ where: { id: orphanListingId } });
    }
    expect(exitCode).toBe(1);
    expect(stdout).toContain('has no matching row in tenant businesses');
  });
});

