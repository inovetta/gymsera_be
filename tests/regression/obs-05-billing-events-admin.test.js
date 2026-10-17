/**
 * OBS-05 — GET /admin/billing-events (spec §12.12): every BillingEvent, filterable by tenant and
 * status, for platform admins only, without the raw provider payload.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { BillingEvent, City } = require('../../src/models/platform');

let app;
beforeAll(async () => {
  app = await startTestServer();
});

describe('OBS-05: admin billing events view', () => {
  let adminToken;
  let hostToken;
  let tenantA;
  let tenantB;

  const mk = (over) =>
    BillingEvent.create({
      provider: 'APPLE',
      providerEventId: `evt-${Math.random().toString(36).slice(2)}`,
      eventType: 'DID_RENEW',
      rawPayload: '{"secret":"receipt-data-123"}',
      status: 'PROCESSED',
      receivedAt: new Date(),
      ...over,
    });
  const get = (qs = '', token = adminToken) =>
    request(app).get(`/api/v1/admin/billing-events${qs}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    await setupTestDatabases();
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });
  beforeEach(async () => {
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    const admin = await factories.createUser({ role: 'PLATFORM_ADMIN' });
    adminToken = signToken({ sub: admin.id, id: admin.id, role: 'PLATFORM_ADMIN', isVerified: true });
    tenantA = await factories.createTenant({ gymName: 'Alpha Fitness' });
    tenantB = await factories.createTenant({ gymName: 'Beta Fitness' });
    hostToken = signToken({ sub: tenantA.ownerUserId, id: tenantA.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenantA.id });
  });

  test('401 without a token, 403 for a gym host', async () => {
    expect((await request(app).get('/api/v1/admin/billing-events')).status).toBe(401);
    expect((await get('', hostToken)).status).toBe(403);
  });

  test('lists events newest first with tenant name, status and age; never the raw payload', async () => {
    await mk({ tenantId: tenantA.id, providerEventId: 'old', receivedAt: new Date(Date.now() - 3600 * 1000) });
    await mk({ tenantId: tenantA.id, providerEventId: 'new', status: 'FAILED', attempts: 2, lastError: 'Apple API down' });
    const res = await get();
    expect(res.status).toBe(200);
    const rows = res.body.data;
    expect(rows.map((r) => r.providerEventId)).toEqual(['new', 'old']);
    expect(rows[0]).toMatchObject({ tenantId: tenantA.id, tenantName: tenantA.gymName, status: 'FAILED', attempts: 2, provider: 'APPLE' });
    expect(JSON.stringify(res.body)).not.toContain('receipt-data-123');
    expect(rows[0].rawPayload).toBeUndefined();
  });

  test('filters by tenant, by status, by provider, and combinations', async () => {
    await mk({ tenantId: tenantA.id, providerEventId: 'a-ok' });
    await mk({ tenantId: tenantA.id, providerEventId: 'a-fail', status: 'FAILED' });
    await mk({ tenantId: tenantB.id, providerEventId: 'b-fail', status: 'FAILED', provider: 'STRIPE' });
    await mk({ tenantId: null, providerEventId: 'orphan', status: 'RECEIVED' });

    const ids = async (qs) => (await get(qs)).body.data.map((r) => r.providerEventId).sort();
    expect(await ids(`?tenantId=${tenantA.id}`)).toEqual(['a-fail', 'a-ok']);
    expect(await ids('?status=FAILED')).toEqual(['a-fail', 'b-fail']);
    expect(await ids(`?tenantId=${tenantB.id}&status=FAILED`)).toEqual(['b-fail']);
    expect(await ids('?provider=STRIPE')).toEqual(['b-fail']);
    expect(await ids('?status=RECEIVED')).toEqual(['orphan']);
    expect(await ids('?tenantId=none')).toEqual(['orphan']);
  });

  test('invalid filters are a 422, not an empty list or a 500', async () => {
    expect((await get('?status=BOGUS')).status).toBe(422);
    expect((await get('?provider=PAYPAL')).status).toBe(422);
    expect((await get('?tenantId=not-a-uuid')).status).toBe(422);
  });

  test('pages with total and limit capped at 100', async () => {
    for (let i = 0; i < 5; i++) await mk({ providerEventId: `p-${i}`, receivedAt: new Date(Date.now() - i * 1000) });
    const res = await get('?limit=2&page=2');
    expect(res.body.data.map((r) => r.providerEventId)).toEqual(['p-2', 'p-3']);
    expect(res.body.pagination).toMatchObject({ total: 5, page: 2, limit: 2, totalPages: 3 });
    expect((await get('?limit=5000')).body.pagination.limit).toBe(100);
  });

  test('flags events that are unprocessed for more than 10 minutes', async () => {
    await mk({ providerEventId: 'fresh', status: 'RECEIVED' });
    await mk({ providerEventId: 'stuck', status: 'RECEIVED', receivedAt: new Date(Date.now() - 11 * 60 * 1000) });
    await mk({ providerEventId: 'done', status: 'PROCESSED', receivedAt: new Date(Date.now() - 11 * 60 * 1000) });
    const byId = Object.fromEntries((await get()).body.data.map((r) => [r.providerEventId, r.stuck]));
    expect(byId).toEqual({ fresh: false, stuck: true, done: false });
  });
});
