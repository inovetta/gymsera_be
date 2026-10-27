/**
 * NEW-126 — the startup tenant schema check only printed a warning (lost with NEW-123), so
 * GYM-4814C134 stayed live below the target. A tenant behind the target or unreadable now gives
 * an error line with the fix, the TENANT_SCHEMA_BEHIND alert to platform admins, a 503 on
 * GET /api/v1/health/tenant-schema, and exit 1 from `run-tenant-migrations.js --check`.
 * /health stays 200 (liveness of the only API instance).
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, factories } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { encrypt } = require('../../src/utils/crypto.utils');
const { Notification, Tenant } = require('../../src/models/platform');
const alertService = require('../../src/services/alert.service');
const health = require('../../src/services/tenant-schema-health.service');
const { check } = require('../../src/scripts/run-tenant-migrations');

let h;
let app;
let admin;
let tenantA;

beforeAll(async () => {
  h = await setupTestDatabases();
  app = await startTestServer();
  admin = await factories.createUser({ email: 'admin-n126@gymsera.test', role: 'PLATFORM_ADMIN' });
  tenantA = await factories.createTenant({ tenantCode: 'GYM-N126A', status: 'ACTIVE', connectionStringEncrypted: h.tenant1.encryptedConnStr });
  await factories.createTenant({ tenantCode: 'GYM-N126B', status: 'SUSPENDED', connectionStringEncrypted: h.tenant2.encryptedConnStr });
});

beforeEach(() => {
  health._resetForTests();
  alertService._resetForTests();
});

afterAll(async () => {
  await teardownTestDatabases();
});

const capture = () => {
  const lines = [];
  return { write: (s) => lines.push(String(s)), text: () => lines.join('') };
};

test('every tenant at the target: /health/tenant-schema 200 ok, --check exit 0, no alert', async () => {
  await health.runTenantSchemaCheck();
  const res = await request(app).get('/api/v1/health/tenant-schema');
  expect(res.status).toBe(200);
  expect(res.body.data.tenantSchema).toEqual(expect.objectContaining({ status: 'ok', behindCount: 0, failedCount: 0 }));

  const out = capture();
  expect(await check(out.write)).toBe(0);
  expect(out.text()).toMatch(/OK: every tenant database is at the target/);
  expect(await Notification.count({ where: { type: 'PLATFORM_ALERT' } })).toBe(0);
});

describe('a tenant below the target', () => {
  beforeAll(async () => {
    await h.tenant1.sequelize.query('DELETE FROM schema_migrations WHERE version >= 19');
  });
  afterAll(async () => {
    await h.tenant1.sequelize.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (19, \'019_add_branch_currency\', NOW())');
  });

  test('an error line names the tenant, its version and the fix; the platform admin gets TENANT_SCHEMA_BEHIND', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await health.runTenantSchemaCheck();
      const line = errors.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('GYM-N126A'));
      expect(line).toMatch(/\[TenantSchema\] BEHIND: tenant GYM-N126A \(ACTIVE\) is at v18, target v19; missing 19\. Fix: node src\/scripts\/run-tenant-migrations\.js --dry-run/);
    } finally {
      errors.mockRestore();
    }
    const alert = await Notification.findOne({ where: { type: 'PLATFORM_ALERT', userId: admin.id } });
    expect(alert).toBeTruthy();
    const meta = typeof alert.metadataJson === 'string' ? JSON.parse(alert.metadataJson) : alert.metadataJson;
    expect(meta.alertCode).toBe('TENANT_SCHEMA_BEHIND');
    expect(meta.runbook).toBe('docs/runbooks/tenant-schema.md#tenant_schema_behind');
  });

  test('/health/tenant-schema answers 503 with counts only; /health stays 200', async () => {
    await health.runTenantSchemaCheck();
    const res = await request(app).get('/api/v1/health/tenant-schema');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.data.tenantSchema).toEqual(expect.objectContaining({ status: 'behind', behindCount: 1, failedCount: 0, targetVersion: 19 }));
    expect(JSON.stringify(res.body)).not.toContain('GYM-N126A');
    expect(JSON.stringify(res.body)).not.toContain(tenantA.gymName);

    expect((await request(app).get('/api/v1/health')).status).toBe(200);
  });

  test('--check (deploy gate) exits 1 and names the tenant', async () => {
    const out = capture();
    expect(await check(out.write)).toBe(1);
    expect(out.text()).toMatch(/BEHIND\s+GYM-N126A \(ACTIVE\) at v18; missing 19/);
    expect(out.text()).toMatch(/FAILED: 1 behind, 0 unchecked/);
  });
});

test('a tenant with no schema_migrations is named with the repair command', async () => {
  await h.tenant2.sequelize.query('RENAME TABLE schema_migrations TO schema_migrations_n126');
  try {
    const out = capture();
    expect(await check(out.write)).toBe(1);
    expect(out.text()).toMatch(/BEHIND\s+GYM-N126B \(SUSPENDED\) at v0, NO schema_migrations table; .*Fix: node src\/scripts\/repair-tenant-schema\.js --tenant GYM-N126B/);
  } finally {
    await h.tenant2.sequelize.query('RENAME TABLE schema_migrations_n126 TO schema_migrations');
  }
});

test('an unreadable tenant database counts: 503 and UNCHECKED', async () => {
  const broken = await factories.createTenant({
    tenantCode: 'GYM-N126C',
    status: 'ACTIVE',
    connectionStringEncrypted: encrypt('mysql://nobody:wrong@127.0.0.1:3308/gymsera_test_no_such_db'),
  });
  try {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await health.runTenantSchemaCheck();
    const res = await request(app).get('/api/v1/health/tenant-schema');
    expect(res.status).toBe(503);
    expect(res.body.data.tenantSchema.failedCount).toBe(1);
    const out = capture();
    expect(await check(out.write)).toBe(1);
    expect(out.text()).toMatch(/UNCHECKED\s+GYM-N126C/);
  } finally {
    jest.restoreAllMocks();
    await Tenant.destroy({ where: { id: broken.id } });
  }
});

test('before the first check the route says unchecked (503), never ok', async () => {
  const res = await request(app).get('/api/v1/health/tenant-schema');
  expect(res.status).toBe(503);
  expect(res.body.data.tenantSchema.status).toBe('unchecked');
});
