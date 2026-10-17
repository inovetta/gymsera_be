/**
 * OBS-07 — GET /admin/audit-logs (spec §12.12): the platform audit trails, queryable, for platform
 * admins only. Admin actions (`platform_audit_logs`) by default; the HTTP mutation trail
 * (`audit_logs`) with ?source=requests. No IP address, no user agent; secrets and personal data in
 * `details` and in paths are redacted the way logs are (SEC-07).
 */
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { AuditLog, PlatformAuditLog, City } = require('../../src/models/platform');
const { hashEmail } = require('../../src/utils/log-redaction');

let app;
beforeAll(async () => {
  app = await startTestServer();
});

describe('OBS-07: admin audit log view', () => {
  let admin;
  let adminToken;
  let hostToken;
  let tenantA;
  const min = (n) => new Date(Date.now() - n * 60 * 1000);

  const action = (over = {}) =>
    PlatformAuditLog.create({ actorUserId: admin.id, action: 'TENANT_APPROVED', targetType: 'TENANT', targetId: uuidv4(), createdAt: new Date(), ...over });
  const http = (over = {}) =>
    AuditLog.create({ userId: admin.id, tenantId: tenantA.id, method: 'POST', path: '/api/v1/payments', statusCode: 201, ipAddress: '203.0.113.9', userAgent: 'Secret-UA/1.0', durationMs: 12, createdAt: new Date(), ...over });
  const get = (qs = '', token = adminToken) => request(app).get(`/api/v1/admin/audit-logs${qs}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    await setupTestDatabases();
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });
  beforeEach(async () => {
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    admin = await factories.createUser({ role: 'PLATFORM_ADMIN' });
    adminToken = signToken({ sub: admin.id, id: admin.id, role: 'PLATFORM_ADMIN', isVerified: true });
    tenantA = await factories.createTenant({ gymName: 'Alpha Fitness' });
    hostToken = signToken({ sub: tenantA.ownerUserId, id: tenantA.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenantA.id });
  });

  test('401 without a token, 403 for a gym host', async () => {
    expect((await request(app).get('/api/v1/admin/audit-logs')).status).toBe(401);
    expect((await get('', hostToken)).status).toBe(403);
  });

  test('default source is the admin actions, newest first', async () => {
    await action({ action: 'OLD', createdAt: min(60) });
    await action({ action: 'NEW', targetType: 'USER' });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => r.action)).toEqual(['NEW', 'OLD']);
    expect(res.body.data[0]).toMatchObject({ source: 'actions', actorUserId: admin.id, targetType: 'USER' });
  });

  test('details are redacted: secrets removed, e-mails and phones only as hashes', async () => {
    await action({ details: { reason: 'duplicate', email: 'owner@example.test', password: 'hunter2-secret', nested: { refreshToken: 'rt-abc', phone: '+923001112223' } } });
    const body = JSON.stringify((await get()).body);
    for (const leaked of ['owner@example.test', 'hunter2-secret', 'rt-abc', '+923001112223']) expect(body).not.toContain(leaked);
    expect(body).toContain(hashEmail('owner@example.test'));
    expect(body).toContain('duplicate'); // ordinary content stays readable
  });

  test('source=requests returns the HTTP trail without IP address or user agent, and with a redacted path', async () => {
    await http({ path: '/api/v1/auth/password-reset/confirm?token=reset-secret-1&email=leak@example.test' });
    const res = await get('?source=requests');
    expect(res.status).toBe(200);
    const row = res.body.data[0];
    expect(row).toMatchObject({ source: 'requests', userId: admin.id, tenantId: tenantA.id, method: 'POST', statusCode: 201, durationMs: 12 });
    const body = JSON.stringify(res.body);
    for (const leaked of ['203.0.113.9', 'Secret-UA', 'reset-secret-1', 'leak@example.test']) expect(body).not.toContain(leaked);
    expect(row.ipAddress).toBeUndefined();
    expect(row.userAgent).toBeUndefined();
  });

  test('filters for actions: userId, action, targetType, targetId, from/to', async () => {
    const other = await factories.createUser({ role: 'PLATFORM_ADMIN' });
    const targetId = uuidv4();
    await action({ action: 'A1', targetId });
    await action({ action: 'A2', actorUserId: other.id });
    await action({ action: 'A3', targetType: 'USER', createdAt: min(120) });
    const names = async (qs) => (await get(qs)).body.data.map((r) => r.action).sort();
    expect(await names(`?userId=${other.id}`)).toEqual(['A2']);
    expect(await names('?action=A1')).toEqual(['A1']);
    expect(await names('?targetType=USER')).toEqual(['A3']);
    expect(await names(`?targetId=${targetId}`)).toEqual(['A1']);
    expect(await names(`?from=${encodeURIComponent(min(90).toISOString())}`)).toEqual(['A1', 'A2']);
    expect(await names(`?to=${encodeURIComponent(min(90).toISOString())}`)).toEqual(['A3']);
  });

  test('filters for requests: userId, tenantId, method', async () => {
    const other = await factories.createTenant({ gymName: 'Beta Fitness' });
    await http({ path: '/a', method: 'POST' });
    await http({ path: '/b', method: 'DELETE' });
    await http({ path: '/c', tenantId: other.id });
    const paths = async (qs) => (await get(`?source=requests&${qs}`)).body.data.map((r) => r.path).sort();
    expect(await paths(`tenantId=${other.id}`)).toEqual(['/c']);
    expect(await paths('method=DELETE')).toEqual(['/b']);
    expect(await paths(`userId=${admin.id}&tenantId=${tenantA.id}&method=POST`)).toEqual(['/a']);
  });

  test('invalid filters are a 422, not an empty list or a 500', async () => {
    for (const qs of ['?source=other', '?userId=nope', '?tenantId=nope&source=requests', '?from=yesterday', '?method=TRACE&source=requests', `?action=${'x'.repeat(101)}`]) {
      expect((await get(qs)).status).toBe(422);
    }
  });

  test('pages with total and limit capped at 100', async () => {
    for (let i = 0; i < 5; i++) await action({ action: `P${i}`, createdAt: min(i) });
    const res = await get('?limit=2&page=2');
    expect(res.body.data.map((r) => r.action)).toEqual(['P2', 'P3']);
    expect(res.body.pagination).toMatchObject({ total: 5, page: 2, limit: 2, totalPages: 3 });
    expect((await get('?limit=5000')).body.pagination.limit).toBe(100);
  });

  test('reading never changes the trail', async () => {
    await action();
    await http();
    const before = [await PlatformAuditLog.count(), await AuditLog.count()];
    await get();
    await get('?source=requests');
    expect([await PlatformAuditLog.count(), await AuditLog.count()]).toEqual(before);
  });
});
