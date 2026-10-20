/**
 * SEC-17: the admin tenant Members tab masks e-mail and phone by default. The full values come from an
 * audited, admin-only reveal route, and the audit row (append-only, OBS-07) is written before anything
 * is returned. The row never holds the values themselves.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { PlatformAuditLog, GymListing } = require('../../src/models/platform');
const { maskEmail, maskPhone } = require('../../src/utils/pii-mask');

describe('SEC-17: pii-mask', () => {
  test('masks e-mail to the first letter and the domain', () => {
    expect(maskEmail('ahmed.khan@gmail.com')).toBe('a***@gmail.com');
    expect(maskEmail('x@y.co')).toBe('x***@y.co');
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail(null)).toBeNull();
  });
  test('masks phone to the last two digits and keeps the length', () => {
    expect(maskPhone('+923001234567')).toBe('**********67');
    expect(maskPhone('12')).toBe('***');
    expect(maskPhone('')).toBeNull();
    expect(maskPhone(null)).toBeNull();
  });
});

describe('SEC-17: admin Members tab', () => {
  let h; let personas; let server; let tenantId; let member; let outsider;
  const EMAIL = 'sec17.member@example.test';
  const PHONE = '+923001234567';

  beforeAll(async () => {
    h = await setupTestDatabases();
    personas = await setupPersonas(h);
    server = await startTestServer();
    tenantId = personas.owner.tenantId;
    const { Branch, MembershipPlan, MemberSubscription } = h.tenant1.models;
    const listing = await GymListing.findOne({ where: { tenantId } });
    const branch = await Branch.findOne({ where: { gymListingId: listing.id } });
    const plan = await MembershipPlan.create({ gymId: branch.gymId, branchId: branch.id, name: 'SEC17', price: 1000, durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE' });
    member = await factories.createUser({ email: EMAIL, phone: PHONE, fullName: 'Sec Seventeen', role: 'MEMBER' });
    outsider = await factories.createUser({ email: 'sec17.outsider@example.test', phone: '+923009999999', fullName: 'Not A Member', role: 'MEMBER' });
    await MemberSubscription.create({ userId: member.id, membershipPlanId: plan.id, branchId: branch.id, status: 'ACTIVE', startDate: '2026-01-01', endDate: '2026-12-31' });
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  const list = () => asPersona('platformAdmin').get(`/admin/tenants/${tenantId}/members`);
  const reveal = (userId, body = {}, persona = 'platformAdmin') => asPersona(persona).post(`/admin/tenants/${tenantId}/members/${userId}/reveal`).send(body);
  const auditRows = () => PlatformAuditLog.findAll({ where: { action: 'admin.member_contact_revealed' } });

  test('the list masks e-mail and phone and says so; other fields stay', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const row = res.body.data.members.find((m) => m.userId === member.id);
    expect(row.user.email).toBe('s***@example.test');
    expect(row.user.phone).toBe('**********67');
    expect(row.user.contactMasked).toBe(true);
    expect(row.user.fullName).toBe('Sec Seventeen');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain('1234567');
  });

  test('reveal returns the full values and writes one audit row without them', async () => {
    const res = await reveal(member.id, { reason: 'Member asked support to confirm the number' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toEqual({ userId: member.id, email: EMAIL, phone: PHONE });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: personas.platformAdmin.user.id, targetType: 'user', targetId: member.id });
    expect(rows[0].details).toEqual({ tenantId, fields: ['email', 'phone'], reason: 'Member asked support to confirm the number' });
    const stored = JSON.stringify(rows[0].toJSON());
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain('1234567');
  });

  test('every reveal is its own audit row; the reason is optional and cleaned', async () => {
    const before = (await auditRows()).length;
    await reveal(member.id);
    await reveal(member.id, { reason: `line1\nline2${'x'.repeat(400)}` });
    const rows = await auditRows();
    expect(rows).toHaveLength(before + 2);
    const last = rows.map((r) => r.details.reason).filter(Boolean).pop();
    expect(last.length).toBeLessThanOrEqual(200);
    expect(last).not.toMatch(/[\n\r]/);
  });

  test('if the audit row cannot be written, nothing is revealed', async () => {
    const spy = jest.spyOn(PlatformAuditLog, 'create').mockRejectedValueOnce(new Error('db down'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await reveal(member.id);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(EMAIL);
    spy.mockRestore();
    err.mockRestore();
  });

  test('a user who is not a member of this tenant, and a malformed id, answer 404 and write no audit row', async () => {
    const before = (await auditRows()).length;
    expect((await reveal(outsider.id)).status).toBe(404);
    expect((await reveal('not-a-uuid')).status).toBe(404);
    expect((await auditRows()).length).toBe(before);
  });

  test('admin only: a gym owner and an anonymous caller are refused and no row is written', async () => {
    const before = (await auditRows()).length;
    expect([401, 403]).toContain((await reveal(member.id, {}, 'owner')).status);
    const anon = await request(server).post(`/api/v1/admin/tenants/${tenantId}/members/${member.id}/reveal`).send({});
    expect(anon.status).toBe(401);
    expect((await auditRows()).length).toBe(before);
  });

  test('the audit row can be read back through GET /admin/audit-logs (OBS-07)', async () => {
    const res = await asPersona('platformAdmin').get('/admin/audit-logs');
    expect(res.status).toBe(200);
    expect(res.body.data.some((r) => r.action === 'admin.member_contact_revealed' && r.targetId === member.id)).toBe(true);
  });
});
