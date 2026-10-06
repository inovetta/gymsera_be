/**
 * FLOW-05 — "Listings tab stale after creating an organization".
 *
 * Attempted reproduction at the API level: create an organization through the
 * same endpoint the app uses (POST /host/listings), then list
 * (GET /host/listings) with the same token. NOT REPRODUCED: the new PENDING
 * organization is in the very next list.
 *
 * Reproduced only with an abnormal token: a GYM_HOST token without tenantId
 * creates through tenantContext's fallback tenant but lists nothing (the JWT
 * lead). The fix is proposed in docs/changes/FLOW-05.md, not applied. The
 * diagnostic logs carry no ids or personal data.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { signToken } = require('../../src/utils/jwt.utils');
const request = require('supertest');

describe('FLOW-05: a created organization is in the next GET /host/listings', () => {
  let personas;
  let ctx;

  beforeAll(async () => {
    const h = await setupTestDatabases();
    personas = await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
  });

  afterAll(async () => {
    delete process.env.DEBUG_FLOW05;
    await teardownTestDatabases();
  });

  test('create → list (same token, no restart) shows the new PENDING organization', async () => {
    const before = await asPersona('owner').get('/host/listings');
    expect(before.status).toBe(200);
    const beforeIds = before.body.data.map((l) => l.id);

    const created = await asPersona('owner').post('/host/listings', {
      gymName: 'Flow05 New Org',
      branchSource: 'new',
      packages: [{ name: 'Monthly Pass', price: 50, durationType: 'MONTHLY', durationValue: 1 }],
    });
    expect(created.status).toBe(201);
    const newId = created.body.data.id;
    expect(beforeIds).not.toContain(newId);

    const after = await asPersona('owner').get('/host/listings');
    expect(after.status).toBe(200);
    const row = after.body.data.find((l) => l.id === newId);
    expect(row).toBeDefined();
    expect(row.status).toBe('PENDING');
    expect(after.body.data).toHaveLength(beforeIds.length + 1);
  });

  test('REPRODUCED only with a tenant-less host token: create succeeds, the list stays empty', async () => {
    // GET /host/listings reads the raw token claim (host.routes.js, no tenantContext);
    // POST /host/listings goes through tenantContext, which fills req.user.tenantId
    // from the header / the user's default tenant. A GYM_HOST token without tenantId
    // (auth.service.js#_buildTokenPayload swallows a lookup error into null) splits them.
    const owner2 = personas.otherTenantOwner.user;
    const noTenantToken = signToken({ sub: owner2.id, id: owner2.id, email: owner2.email, role: 'GYM_HOST', isVerified: true });
    const server = require('../harness/personas').personaManager.server;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let created;
    try {
      created = await request(server).post('/api/v1/host/listings')
        .set('Authorization', `Bearer ${noTenantToken}`)
        .send({ gymName: 'Flow05 Tenantless Org', branchSource: 'none', cityId: 1 });
      expect(created.status).toBe(201);

      const list = await request(server).get('/api/v1/host/listings').set('Authorization', `Bearer ${noTenantToken}`);
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual([]); // stale: the org just created is missing

      const lines = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[FLOW-05]'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(owner2.id);
      expect(lines[0]).not.toContain(owner2.email);
    } finally {
      warn.mockRestore();
    }

    // The same owner with a normal token sees it at once.
    const normal = await asPersona('otherTenantOwner').get('/host/listings');
    expect(normal.body.data.map((l) => l.id)).toContain(created.body.data.id);
  });

  test('DEBUG_FLOW05 logs counts by status only (no ids, no names)', async () => {
    process.env.DEBUG_FLOW05 = 'true';
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await asPersona('owner').get('/host/listings');
      expect(res.status).toBe(200);
      const lines = log.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[FLOW-05]'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/listing\(s\) \{.*"PENDING":1.*\}; X-Tenant-Id matches/);
      expect(lines[0]).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(lines[0]).not.toContain('Flow05 New Org');
    } finally {
      log.mockRestore();
      delete process.env.DEBUG_FLOW05;
    }
  });
});
