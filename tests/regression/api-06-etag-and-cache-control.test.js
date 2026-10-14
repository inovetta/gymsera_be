/**
 * API-06: ETag / 304.
 *  - the ETag is a hash of the response CONTENT (data + pagination); the
 *    envelope's meta (timestamp, requestId, path) never changes it
 *  - If-None-Match on an unchanged GET answers 304 with no body
 *  - authenticated responses are Cache-Control: private, no-cache; only the
 *    10 public discovery GETs are public, and only on 200
 *  - a validator from one user never yields a 304 for a different user's content
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');

describe('API-06: ETag, 304 and Cache-Control', () => {
  let server; let h; let personas;

  beforeAll(async () => {
    h = await setupTestDatabases();
    personas = await setupPersonas(h);
    server = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  const get = (path, headers = {}) => request(server).get(`/api/v1${path}`).set(headers);
  const as = (persona) => ({ Authorization: `Bearer ${personas[persona].token}` });

  test('the ETag ignores meta.timestamp / requestId: two reads of the same content share it', async () => {
    const a = await get('/discovery/cities');
    const b = await get('/discovery/cities');
    expect(a.status).toBe(200);
    expect(a.headers.etag).toBeTruthy();
    expect(b.body.meta.requestId).not.toBe(a.body.meta.requestId);
    expect(b.headers.etag).toBe(a.headers.etag);
  });

  test('If-None-Match with the current ETag answers 304 and no body', async () => {
    const a = await get('/discovery/cities');
    const b = await get('/discovery/cities', { 'If-None-Match': a.headers.etag });
    expect(b.status).toBe(304);
    expect(b.text || '').toBe('');
    expect(b.headers.etag).toBe(a.headers.etag);
  });

  test('a stale validator gets the full 200 body', async () => {
    const r = await get('/discovery/cities', { 'If-None-Match': 'W/"stale"' });
    expect(r.status).toBe(200);
    expect(r.body.data).toBeDefined();
  });

  test('authenticated GET: 304 on an unchanged read, private + no-cache, never public', async () => {
    const a = await get('/payments?page=1&limit=20', as('owner'));
    expect(a.status).toBe(200);
    expect(a.headers['cache-control']).toBe('private, no-cache');
    const b = await get('/payments?page=1&limit=20', { ...as('owner'), 'If-None-Match': a.headers.etag });
    expect(b.status).toBe(304);
    expect(b.headers['cache-control']).toBe('private, no-cache');
  });

  test('changed content changes the ETag (no stale 304)', async () => {
    const a = await get('/payments?page=1&limit=20', as('owner'));
    const branch = await h.tenant1.models.Branch.findOne();
    await factories.createPayment(h.tenant1, branch.id, { userId: personas.member.user.id, amount: 1234 });
    const b = await get('/payments?page=1&limit=20', { ...as('owner'), 'If-None-Match': a.headers.etag });
    expect(b.status).toBe(200);
    expect(b.headers.etag).not.toBe(a.headers.etag);
  });

  test('one user\'s validator never turns another user\'s different content into a 304', async () => {
    const owner = await get('/me/context', as('owner'));
    expect(owner.status).toBe(200);
    const member = await get('/me/context', { ...as('member'), 'If-None-Match': owner.headers.etag });
    expect(member.status).toBe(200);
    expect(member.body.data).not.toEqual(owner.body.data);
    expect(member.headers.etag).not.toBe(owner.headers.etag);
  });

  test('only the public discovery GETs are public; authenticated and error responses never are', async () => {
    const pub = await get('/discovery/cities');
    expect(pub.headers['cache-control']).toMatch(/^public/);
    const authed = await get('/me/context', as('owner'));
    expect(authed.headers['cache-control']).toBe('private, no-cache');
    const bad = await get('/payments', {}); // no token → 401
    expect(bad.status).toBe(401);
    expect(bad.headers['cache-control'] || '').not.toMatch(/public/);
    const missing = await get('/discovery/gyms/00000000-0000-4000-8000-000000000000', as('owner'));
    expect(missing.headers['cache-control'] || '').not.toMatch(/public/);
  });

  test('mutations are never answered 304', async () => {
    const r = await asPersona('owner').post('/host/listings', { gymName: 'Etag Org', branchSource: 'none', cityId: 1 });
    expect(r.status).not.toBe(304);
  });
});
