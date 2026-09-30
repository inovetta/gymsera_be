/**
 * R-25 — Tenant provisioning uses only the configured tenant DB credentials
 * (spec §14 R-25; same approach as SEC-DB-FALLBACK).
 *
 * It used to try TENANT_DB_ADMIN_*, then the platform DB credentials, then
 * `root` with an empty password; and when the tenant app user could not log
 * in, it stored the admin credentials as the tenant's connection string.
 * Now a missing or rejected credential stops provisioning with a clear error,
 * the tenant is not activated, and no other credential is ever tried.
 */
const mysql = require('mysql2/promise');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, getAdminConnection } = require('../harness');
const { createUser, createTenant } = require('../harness/factories');
const { installMailFake } = require('../harness/mail-fake');
const provisioning = require('../../src/services/tenant-provisioning.service');
const adminService = require('../../src/services/admin.service');
const { decrypt } = require('../../src/utils/crypto.utils');

const VARS = ['TENANT_DB_ADMIN_USER', 'TENANT_DB_ADMIN_PASS', 'TENANT_DB_USER', 'TENANT_DB_PASS'];

const withEnv = async (overrides, fn) => {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

beforeAll(async () => {
  await setupTestDatabases();
  installMailFake();
});

afterAll(async () => {
  const conn = await getAdminConnection();
  for (const code of ['r25_admin', 'r25_app', 'r25_ok']) {
    await conn.query(`DROP DATABASE IF EXISTS \`gymsera_${code}\``).catch(() => {});
  }
  await teardownTestDatabases();
});

describe('R-25: tenant DB configuration', () => {
  const full = {
    TENANT_DB_ADMIN_USER: 'prov_admin', TENANT_DB_ADMIN_PASS: 'admin-pw', TENANT_DB_USER: 'tenant_app', TENANT_DB_PASS: 'app-pw',
  };

  test.each(VARS)('missing %s → TENANT_DB_NOT_CONFIGURED naming it, never a default', (key) => {
    const env = { ...full };
    delete env[key];
    let err;
    try { provisioning.getTenantDbConfig(env); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('TENANT_DB_NOT_CONFIGURED');
    expect(err.message).toContain(key);
    expect(err.message).not.toContain('admin-pw');
    expect(err.message).not.toContain('app-pw');
  });

  test('an empty user is rejected; an explicitly empty password is allowed', () => {
    expect(() => provisioning.getTenantDbConfig({ ...full, TENANT_DB_ADMIN_USER: '' })).toThrow(/TENANT_DB_ADMIN_USER/);
    const cfg = provisioning.getTenantDbConfig({ ...full, TENANT_DB_ADMIN_PASS: '', TENANT_DB_PASS: '' });
    expect(cfg.adminPassword).toBe('');
    expect(cfg.appPassword).toBe('');
  });

  test('platform credentials are never used for the tenant server', () => {
    const cfg = provisioning.getTenantDbConfig({ ...full, PLATFORM_DB_USER: 'platform_user', PLATFORM_DB_PASS: 'platform-pw' });
    expect(cfg.adminUser).toBe('prov_admin');
    expect(cfg.appUser).toBe('tenant_app');
    expect(JSON.stringify(cfg)).not.toContain('platform');
  });

  test('a rejected admin login tries only the configured user (host spelling may change), never root / platform creds', async () => {
    const calls = [];
    const spy = jest.spyOn(mysql, 'createConnection').mockImplementation(async (opts) => {
      calls.push({ host: opts.host, user: opts.user, password: opts.password });
      const e = new Error('Access denied'); e.code = 'ER_ACCESS_DENIED_ERROR'; throw e;
    });
    try {
      await withEnv({ PLATFORM_DB_USER: 'platform_user', PLATFORM_DB_PASS: 'platform-pw' }, async () => {
        const cfg = provisioning.getTenantDbConfig({ ...full, TENANT_DB_HOST: 'localhost' });
        await expect(provisioning.createSafeAdminConnection(cfg)).rejects.toThrow(/TENANT_DB_ADMIN_USER 'prov_admin'/);
      });
    } finally {
      spy.mockRestore();
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.user).toBe('prov_admin');
      expect(c.password).toBe('admin-pw');
    }
    expect(new Set(calls.map((c) => c.host))).toEqual(new Set(['localhost', '127.0.0.1']));
  });
});

describe('R-25: approval with a bad credential fails loudly and activates nothing', () => {
  let adminUser;
  let hostUser;

  beforeEach(async () => {
    await resetTestDatabases();
    await require('../../src/models/platform').City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    adminUser = await createUser({ role: 'PLATFORM_ADMIN' });
    hostUser = await createUser({ role: 'GYM_HOST' });
  });

  const pendingTenant = (tenantCode) =>
    createTenant({ tenantCode, gymName: `R25 ${tenantCode}`, ownerUserId: hostUser.id, status: 'PENDING_REVIEW', connectionStringEncrypted: null });

  const dbExists = async (name) => {
    const conn = await getAdminConnection();
    const [rows] = await conn.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
    return rows.length > 0;
  };

  test('wrong TENANT_DB_ADMIN_PASS → approval fails, no database, tenant not ACTIVE', async () => {
    const tenant = await pendingTenant('r25_admin');
    await withEnv({ TENANT_DB_ADMIN_PASS: 'definitely-not-the-password' }, async () => {
      await expect(adminService.approveTenant(tenant.id, adminUser.id)).rejects.toThrow(/TENANT_DB_ADMIN_USER/);
    });
    await tenant.reload();
    expect(tenant.status).not.toBe('ACTIVE');
    expect(tenant.connectionStringEncrypted).toBeFalsy();
    expect(await dbExists('gymsera_r25_admin')).toBe(false);
  });

  test('tenant app user rejected → approval fails; the admin credentials are never tried or stored for the tenant', async () => {
    const tenant = await pendingTenant('r25_app');
    // The server refuses the app user for this tenant's database (e.g. wrong TENANT_DB_PASS on a managed server).
    const { Sequelize } = require('sequelize');
    const realAuthenticate = Sequelize.prototype.authenticate;
    const logins = [];
    const spy = jest.spyOn(Sequelize.prototype, 'authenticate').mockImplementation(function authenticate(...args) {
      if (this.config.database === 'gymsera_r25_app') {
        logins.push(this.config.username);
        const e = new Error('Access denied'); e.name = 'SequelizeAccessDeniedError';
        return Promise.reject(e);
      }
      return realAuthenticate.apply(this, args);
    });
    try {
      await expect(adminService.approveTenant(tenant.id, adminUser.id)).rejects.toThrow(/TENANT_DB_USER/);
    } finally {
      spy.mockRestore();
    }
    expect(logins).toEqual([process.env.TENANT_DB_USER]);
    await tenant.reload();
    expect(tenant.status).not.toBe('ACTIVE');
    expect(tenant.connectionStringEncrypted).toBeFalsy();
  });

  test('with correct settings the tenant connects as the configured app user, not the admin', async () => {
    const tenant = await pendingTenant('r25_ok');
    const result = await adminService.approveTenant(tenant.id, adminUser.id);
    expect(result.tenant.status).toBe('ACTIVE');
    await tenant.reload();
    const user = decodeURIComponent(new URL(decrypt(tenant.connectionStringEncrypted)).username);
    expect(user).toBe(process.env.TENANT_DB_USER);
  });
});

describe('R-25: read-only check script for tenants already stored with admin credentials', () => {
  const { classifyTenants } = require('../../gymsera-r25-tenant-db-credentials-check');
  const { encrypt } = require('../../src/utils/crypto.utils');
  const conn = (user, pass = 'pw') => encrypt(`mysql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@db.internal:3306/gymsera_x`);

  test('classifies each tenant by the stored username and never returns a password', () => {
    const rows = [
      { id: 't1', tenant_code: 'A', status: 'ACTIVE', connection_string_encrypted: conn('tenant_app', 'secret-app') },
      { id: 't2', tenant_code: 'B', status: 'ACTIVE', connection_string_encrypted: conn('prov_admin', 'secret-admin') },
      { id: 't3', tenant_code: 'C', status: 'ACTIVE', connection_string_encrypted: conn('platform_user', 'secret-platform') },
      { id: 't4', tenant_code: 'D', status: 'ACTIVE', connection_string_encrypted: conn('root', '') },
      { id: 't5', tenant_code: 'E', status: 'ACTIVE', connection_string_encrypted: conn('someone') },
      { id: 't6', tenant_code: 'F', status: 'PENDING_REVIEW', connection_string_encrypted: null },
      { id: 't7', tenant_code: 'G', status: 'ACTIVE', connection_string_encrypted: 'not-a-valid-ciphertext' },
    ];
    const { decrypt } = require('../../src/utils/crypto.utils');
    const out = classifyTenants(rows, { appUser: 'tenant_app', adminUser: 'prov_admin', platformUser: 'platform_user', decrypt });
    expect(out.map((r) => r.verdict)).toEqual(['OK_APP_USER', 'ADMIN_USER', 'PLATFORM_USER', 'ROOT', 'OTHER_USER', 'NOT_PROVISIONED', 'UNDECRYPTABLE']);
    expect(out[3].emptyPassword).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/secret-/);
  });

  test('runs against a real platform DB inside a READ ONLY transaction and changes nothing', async () => {
    await resetTestDatabases();
    await require('../../src/models/platform').City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    const { Tenant } = require('../../src/models/platform');
    await createTenant({ tenantCode: 'r25chk_ok', connectionStringEncrypted: conn('tenant_app') });
    await createTenant({ tenantCode: 'r25chk_admin', connectionStringEncrypted: conn('prov_admin', 'secret-admin') });
    const before = JSON.stringify(await Tenant.findAll({ order: [['id', 'ASC']], raw: true }));

    const { spawnSync } = require('child_process');
    const path = require('path');
    const root = path.join(__dirname, '..', '..');
    const res = spawnSync(process.execPath, ['-r', path.join(root, 'tests', 'harness', 'no-network.js'), 'gymsera-r25-tenant-db-credentials-check.js'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CHK_HOST: process.env.PLATFORM_TEST_DB_HOST || process.env.PLATFORM_DB_HOST || process.env.MYSQL_HOST || 'localhost',
        CHK_PORT: process.env.PLATFORM_DB_PORT,
        CHK_USER: process.env.PLATFORM_TEST_DB_USER || process.env.PLATFORM_DB_USER || process.env.MYSQL_USER || 'root',
        CHK_PASSWORD: process.env.PLATFORM_TEST_DB_PASS ?? process.env.PLATFORM_DB_PASS ?? '',
        CHK_PLATFORM_DB: process.env.PLATFORM_DB_NAME,
        CHK_APP_USER: 'tenant_app',
        CHK_ADMIN_USER: 'prov_admin',
        CHK_PLATFORM_USER: 'platform_user',
      },
    });
    expect(res.stderr).not.toMatch(/Check failed/);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/ADMIN_USER\s+tenant=\S+ code=r25chk_admin/);
    expect(res.stdout).not.toMatch(/code=r25chk_ok/);
    expect(res.stdout).not.toContain('secret-admin');
    expect(JSON.stringify(await Tenant.findAll({ order: [['id', 'ASC']], raw: true }))).toBe(before);
  });
});
