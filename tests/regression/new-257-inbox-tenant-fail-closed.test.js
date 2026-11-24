/**
 * NEW-257 (security, found during NEW-256): the gym side of the inbox skipped its tenant check when
 * the caller had no tenant. inbox.service.js getInquiryDetail, replyToInquiry and markInquiryRead
 * built `{ id }` and added `organizationId` only `if (organizationId)`, so a GYM_HOST whose token carries no
 * tenant (req.user.organizationId undefined) could read, answer and mark read ANY gym's conversation by
 * id. Fix: fail closed — no tenant, no conversation (404, nothing written).
 */
const { v4: uuidv4 } = require('uuid');
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { createUser } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');
const { Conversation, Message } = require('../../src/models/platform');
const inbox = require('../../src/services/inbox.service');

let personas;
let ctx;
let conversation;
let tenantlessHostToken;

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  ctx = require('../harness/personas').personaManager.context;
  conversation = await Conversation.create({
    id: uuidv4(), organizationId: personas.owner.organizationId, branchId: ctx.branch1.id, userId: personas.member.user.id,
    type: 'INQUIRY', unreadCountHost: 3, lastMessageText: 'private question',
  });
  await Message.create({ conversationId: conversation.id, senderId: personas.member.user.id, senderType: 'USER', text: 'private question' });
  // A gym host account whose token has no tenant (e.g. before onboarding, or a stale token).
  const host = await createUser({ role: 'GYM_HOST', email: `tenantless-${uuidv4()}@test.local` });
  tenantlessHostToken = signToken({ sub: host.id, id: host.id, email: host.email, role: 'GYM_HOST', isVerified: true });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const asTenantless = () => {
  const server = require('../harness/personas').personaManager.server;
  const auth = (r) => r.set('Authorization', `Bearer ${tenantlessHostToken}`).set('Accept', 'application/json');
  return {
    get: (p) => auth(request(server).get(`/api/v1${p}`)),
    post: (p, body) => auth(request(server).post(`/api/v1${p}`)).send(body),
    patch: (p, body) => auth(request(server).patch(`/api/v1${p}`)).send(body),
  };
};

describe('NEW-257: the gym inbox fails closed without a tenant', () => {
  test('the service refuses every tenant-less call with 404 (detail, reply, read)', async () => {
    await expect(inbox.getInquiryDetail(conversation.id, null)).rejects.toMatchObject({ statusCode: 404 });
    await expect(inbox.getInquiryDetail(conversation.id, undefined)).rejects.toMatchObject({ statusCode: 404 });
    await expect(inbox.replyToInquiry(conversation.id, uuidv4(), 'hijack', null)).rejects.toMatchObject({ statusCode: 404 });
    await expect(inbox.markInquiryRead(conversation.id, null)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('over HTTP, a GYM_HOST token without a tenant cannot read, answer or mark read another gym\'s conversation', async () => {
    const detail = await asTenantless().get(`/host/inbox/inquiries/${conversation.id}`);
    expect(detail.status).toBe(404);
    expect(JSON.stringify(detail.body)).not.toContain('private question');

    const reply = await asTenantless().post(`/host/inbox/inquiries/${conversation.id}/reply`, { text: 'hijack' });
    expect(reply.status).toBe(404);
    const read = await asTenantless().patch(`/host/inbox/inquiries/${conversation.id}/read`, {});
    expect(read.status).toBe(404);

    expect(await Message.count({ where: { conversationId: conversation.id, text: 'hijack' } })).toBe(0);
    await conversation.reload();
    expect(conversation.unreadCountHost).toBe(3);
  });

  test('the gym that owns the conversation still works; another gym still gets 404', async () => {
    expect((await asPersona('owner').get(`/host/inbox/inquiries/${conversation.id}`)).status).toBe(200);
    expect((await asPersona('otherTenantOwner').get(`/host/inbox/inquiries/${conversation.id}`)).status).toBe(404);
  });
});
