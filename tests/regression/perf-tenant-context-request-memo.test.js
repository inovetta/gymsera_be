/**
 * tenantContext reads the tenant row once per request (was up to four times)
 * and runs the membership check once per user + tenant (was twice).
 *
 * The memo lives and dies inside one tenantContext call. These tests pin both
 * halves: fewer platform reads per request, and NO carry-over between requests,
 * so a tenant suspended between two requests is refused on the second (NEW-26).
 */
const { Sequelize } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const adminService = require('../../src/services/admin.service');
const { Tenant } = require('../../src/models/platform');
const { safeRedisDel } = require('../../src/config/redis.config');

describe('tenantContext: per-request memo', () => {
  let personas; let tenantId;
  let seen = [];
  const origQuery = Sequelize.prototype.query;

  beforeAll(async () => {
    const h = await setupTestDatabases();
    personas = await setupPersonas(h);
    await startTestServer();
    tenantId = personas.owner.tenantId;
    Sequelize.prototype.query = async function spy(sql, ...a) {
      seen.push(typeof sql === 'string' ? sql : (sql && sql.query) || '');
      return origQuery.call(this, sql, ...a);
    };
  });
  afterAll(async () => {
    Sequelize.prototype.query = origQuery;
    await stopTestServer();
    await teardownTestDatabases();
  });

  const tenantReads = () => seen.filter((q) => /FROM `tenants`/.test(q)).length;
  const run = async (persona, path) => {
    await asPersona(persona).get(path); // warm: pools, caches
    seen = [];
    const res = await asPersona(persona).get(path);
    return { res, tenantReads: tenantReads(), all: seen.length };
  };

  test('owner: one tenants read per request instead of four', async () => {
    await safeRedisDel(`tenant:${tenantId}:connStr`);
    const { res, tenantReads: n } = await run('owner', '/gyms/branches');
    expect(res.status).toBe(200);
    expect(n).toBeLessThanOrEqual(1);
  });

  test('team member: the membership check runs once, not twice', async () => {
    const { res } = await run('manager', '/gyms/branches');
    expect(res.status).toBe(200);
    // the tenant row tenantContext needs (owner + connection string) is one read;
    // other middleware (permission version, controller) read `tenants` separately
    const connStrReads = seen.filter((q) => /FROM `tenants`/.test(q) && /connection_string_encrypted/.test(q)).length;
    expect(connStrReads).toBeLessThanOrEqual(1);
    // owner check + (index + membership) used to run for the header check AND
    // again in resolveTenantId; now once.
    const indexReads = seen.filter((q) => /FROM `user_org_index`/.test(q)).length;
    expect(indexReads).toBeLessThanOrEqual(1);
  });

  test('nothing is carried between requests: each request reads the tenant itself', async () => {
    await asPersona('owner').get('/gyms/branches');
    seen = [];
    await asPersona('owner').get('/gyms/branches');
    const first = tenantReads();
    seen = [];
    await asPersona('owner').get('/gyms/branches');
    const second = tenantReads();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBeGreaterThanOrEqual(1);
  });

  test('a tenant suspended between two requests is refused on the second (NEW-26)', async () => {
    const before = await asPersona('owner').get('/gyms/branches');
    expect(before.status).toBe(200);
    const memberBefore = await asPersona('manager').get('/gyms/branches');
    expect(memberBefore.status).toBe(200);

    await adminService.suspendTenant(tenantId, personas.platformAdmin.user.id, 'perf memo test');

    const after = await asPersona('owner').get('/gyms/branches');
    expect([403, 404]).toContain(after.status);
    const memberAfter = await asPersona('manager').get('/gyms/branches');
    expect([403, 404]).toContain(memberAfter.status);

    const row = await Tenant.findByPk(tenantId);
    expect(row.status).toBe('SUSPENDED');
  });
});
