/**
 * GET /me/bootstrap (API-03, spec §4.3 / §10.2): one call for the app shell.
 * Obeys SEC-02: the tenant comes only from the caller's verified memberships;
 * X-Tenant-Id merely SELECTS among them. Returns only what the caller may see.
 */
const { Sequelize } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { Notification } = require('../../src/models/platform');

describe('GET /me/bootstrap', () => {
  let personas; let tenant1; let tenant2;
  let queries = 0;
  const origQuery = Sequelize.prototype.query;

  beforeAll(async () => {
    const h = await setupTestDatabases();
    personas = await setupPersonas(h);
    await startTestServer();
    tenant1 = personas.owner.tenantId;
    tenant2 = personas.otherTenantOwner.tenantId;
    Sequelize.prototype.query = async function spy(...a) { queries += 1; return origQuery.apply(this, a); };
  });
  afterAll(async () => {
    Sequelize.prototype.query = origQuery;
    await stopTestServer();
    await teardownTestDatabases();
  });

  const boot = (persona, headers = {}) => asPersona(persona, headers).get('/me/bootstrap');

  test('owner: user, contexts, active tenant summary, quota, unread counts, grants', async () => {
    const res = await boot('owner');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.user).toMatchObject({ id: personas.owner.user.id, email: personas.owner.user.email });
    expect(d.organizations.map((o) => o.tenantId)).toEqual([tenant1]);
    expect(d.organizations[0].isOwner).toBe(true);
    expect(d.organizations[0].orgPermissions).toEqual(['*']);
    expect(d.activeTenant).toMatchObject({ tenantId: tenant1, isOwner: true, status: 'ACTIVE' });
    expect(typeof d.activeTenant.name).toBe('string');
    expect(d.quota).toMatchObject({ maxBranches: expect.any(Number), usedBranches: expect.any(Number) });
    expect(d.unread).toMatchObject({ notifications: expect.any(Number), pendingApprovals: expect.any(Number) });
    expect(d.permissionVersion).toBeDefined();
  });

  test('branch manager: own grants only, no quota, no wildcard', async () => {
    const res = await boot('manager');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.activeTenant).toMatchObject({ tenantId: tenant1, isOwner: false });
    expect(d.quota).toBeNull();
    expect(d.organizations[0].orgPermissions).not.toContain('*');
    expect(d.organizations.map((o) => o.tenantId)).toEqual([tenant1]);
  });

  test('member without any gym: empty contexts, no active tenant, no quota', async () => {
    const res = await boot('member');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.organizations).toEqual([]);
    expect(d.activeTenant).toBeNull();
    expect(d.quota).toBeNull();
    expect(d.user.id).toBe(personas.member.user.id);
  });

  test('other tenant\'s owner never sees tenant 1 anywhere in the payload', async () => {
    const res = await boot('otherTenantOwner');
    expect(res.status).toBe(200);
    expect(res.body.data.activeTenant.tenantId).toBe(tenant2);
    const text = JSON.stringify(res.body.data);
    expect(text).not.toContain(tenant1);
    expect(text).not.toMatch(/connection/i);
  });

  describe('SEC-02: X-Tenant-Id only selects among the caller\'s tenants', () => {
    test.each([
      ['member', 'tenant1'],
      ['manager', 'tenant2'],
      ['owner', 'tenant2'],
      ['otherTenantOwner', 'tenant1'],
    ])('%s forging the %s id is refused and learns nothing', async (persona, which) => {
      const forged = which === 'tenant1' ? tenant1 : tenant2;
      const res = await boot(persona, { 'X-Tenant-Id': forged });
      expect(res.status).toBe(404);
      expect(res.body.data == null).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('permissions');
    });

    test('a made-up id is refused the same way', async () => {
      const res = await boot('owner', { 'X-Tenant-Id': '00000000-0000-4000-8000-000000000000' });
      expect(res.status).toBe(404);
    });

    test('a header naming one of the caller\'s own tenants selects it', async () => {
      const res = await boot('owner', { 'X-Tenant-Id': tenant1 });
      expect(res.status).toBe(200);
      expect(res.body.data.activeTenant.tenantId).toBe(tenant1);
    });
  });

  test('ETag: unchanged → 304, private; a change → new ETag', async () => {
    const a = await boot('owner');
    expect(a.headers.etag).toBeTruthy();
    expect(a.headers['cache-control']).toBe('private, no-cache');
    expect(a.headers['cache-control']).not.toMatch(/public/);
    const b = await boot('owner', { 'If-None-Match': a.headers.etag });
    expect(b.status).toBe(304);

    const before = a.body.data.unread.notifications;
    await Notification.create({
      userId: personas.owner.user.id, role: 'host', type: 'GENERAL', title: 'Hello',
      message: 'x', body: 'x', priority: 'normal', isRead: false,
    });
    const c = await boot('owner', { 'If-None-Match': a.headers.etag });
    expect(c.status).toBe(200);
    expect(c.headers.etag).not.toBe(a.headers.etag);
    expect(c.body.data.unread.notifications).toBe(before + 1);
  });

  test('one user\'s ETag never turns another user\'s bootstrap into a 304', async () => {
    const owner = await boot('owner');
    const other = await boot('otherTenantOwner', { 'If-None-Match': owner.headers.etag });
    expect(other.status).toBe(200);
    expect(other.body.data.activeTenant.tenantId).toBe(tenant2);
  });

  test('anonymous is refused', async () => {
    const res = await asPersona('anonymous').get('/me/bootstrap');
    expect(res.status).toBe(401);
  });

  test('one request replaces the startup waterfall: fewer queries than the separate calls', async () => {
    const count = async (fn) => { queries = 0; await fn(); return queries; };
    await boot('owner'); // warm
    const separate = await count(async () => {
      await asPersona('owner').get('/auth/me');
      await asPersona('owner').get('/me/context');
      await asPersona('owner').get('/host/branch-quota');
      await asPersona('owner').get('/notifications/unread-count');
    });
    const single = await count(() => boot('owner'));
    // eslint-disable-next-line no-console
    console.log(`BOOTSTRAP_QUERIES single=${single} separate=${separate}`);
    expect(single).toBeLessThan(separate);
  });
});
