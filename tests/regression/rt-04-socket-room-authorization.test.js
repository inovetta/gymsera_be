/**
 * RT-04 — Socket room authorization (spec §9.2, §12.8).
 *
 * The server computes every room. A client can only join, type into, send to
 * or mark read a conversation it belongs to (as its traveler/member, or as a
 * host of the conversation's tenant who still belongs to that tenant). A
 * forged join is ignored: the socket receives nothing from that room.
 */
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { io: ioClient } = require('socket.io-client');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { signToken } = require('../../src/utils/jwt.utils');
const { Conversation, Message } = require('../../src/models/platform');

const QUIET_MS = 400;

describe('RT-04: socket room authorization', () => {
  let server;
  let url;
  let socketGateway;
  const clients = [];

  let tenantA;
  let tenantB;
  let traveler;
  let stranger;
  let conversation;

  beforeAll(async () => {
    await setupTestDatabases();
    socketGateway = require('../../src/socket');
    server = http.createServer((_req, res) => res.end());
    socketGateway.init(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    const io = socketGateway.getIO();
    if (io) await new Promise((r) => io.close(() => r()));
    if (server.listening) await new Promise((r) => server.close(() => r()));
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    await resetTestDatabases();
    await require('../../src/models/platform').City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenantA = await factories.createTenant();
    tenantB = await factories.createTenant();
    traveler = await factories.createUser();
    stranger = await factories.createUser();
    conversation = await Conversation.create({
      id: uuidv4(), tenantId: tenantA.id, branchId: uuidv4(), userId: traveler.id, type: 'INQUIRY',
    });
  });

  afterEach(() => {
    while (clients.length) clients.pop().disconnect();
  });

  const tokenFor = (claims) => signToken({ isVerified: true, ...claims });
  const memberToken = (user) => tokenFor({ sub: user.id, id: user.id, role: 'MEMBER' });
  const hostToken = (tenant, tenantId = tenant.id) =>
    tokenFor({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', tenantId });

  const connect = (token, { viaQuery = false } = {}) => new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      ...(viaQuery ? { query: { token } } : { auth: { token } }),
    });
    clients.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

  const join = (socket, conversationId) => new Promise((resolve) => {
    socket.emit('join_conversation', { conversationId }, resolve);
  });

  const send = (socket, conversationId, text) => new Promise((resolve) => {
    socket.emit('send_message', { conversationId, text }, resolve);
  });

  /** Collects `event` on `socket` for QUIET_MS after `trigger` runs. */
  const received = async (socket, event, trigger) => {
    const got = [];
    const handler = (data) => got.push(data);
    socket.on(event, handler);
    await trigger();
    await new Promise((r) => setTimeout(r, QUIET_MS));
    socket.off(event, handler);
    return got;
  };

  const broadcastToConversation = () =>
    socketGateway.emitToConversation(conversation.id, 'new_message', { conversationId: conversation.id, probe: true });

  test('the conversation\'s own traveler can join and receives its messages', async () => {
    const s = await connect(memberToken(traveler));
    expect(await join(s, conversation.id)).toEqual({ success: true });
    expect(await received(s, 'new_message', broadcastToConversation)).toHaveLength(1);
  });

  test('the owning tenant\'s host can join and receives its messages', async () => {
    const s = await connect(hostToken(tenantA));
    expect(await join(s, conversation.id)).toEqual({ success: true });
    expect(await received(s, 'new_message', broadcastToConversation)).toHaveLength(1);
  });

  test('another member emitting join for someone else\'s conversation is ignored', async () => {
    const s = await connect(memberToken(stranger));
    expect((await join(s, conversation.id)).success).toBe(false);
    expect(await received(s, 'new_message', broadcastToConversation)).toHaveLength(0);
  });

  test('a host of another tenant cannot join', async () => {
    const s = await connect(hostToken(tenantB));
    expect((await join(s, conversation.id)).success).toBe(false);
    expect(await received(s, 'new_message', broadcastToConversation)).toHaveLength(0);
  });

  test('a host token naming a tenant the user does not belong to cannot join (token tenant is re-checked)', async () => {
    const s = await connect(hostToken(tenantB, tenantA.id));
    expect((await join(s, conversation.id)).success).toBe(false);
    expect(await received(s, 'new_message', broadcastToConversation)).toHaveLength(0);
  });

  test('a host token without a tenant cannot borrow the conversation\'s tenant to send a message', async () => {
    const s = await connect(tokenFor({ sub: tenantB.ownerUserId, id: tenantB.ownerUserId, role: 'GYM_HOST' }));
    const res = await send(s, conversation.id, 'hello from nowhere');
    expect(res.success).toBe(false);
    expect(await Message.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  test('a platform admin token without a tenant cannot send into a tenant conversation over the socket', async () => {
    const admin = await factories.createUser({ role: 'PLATFORM_ADMIN' });
    const s = await connect(tokenFor({ sub: admin.id, id: admin.id, role: 'PLATFORM_ADMIN' }));
    const res = await send(s, conversation.id, 'admin reply');
    expect(res.success).toBe(false);
    expect(await Message.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  test('another member cannot send into the conversation', async () => {
    const s = await connect(memberToken(stranger));
    const res = await send(s, conversation.id, 'intrusion');
    expect(res.success).toBe(false);
    expect(await Message.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  test('the traveler and the owning host can both still send', async () => {
    const t = await connect(memberToken(traveler));
    const h = await connect(hostToken(tenantA));
    expect((await send(t, conversation.id, 'hi gym')).success).toBe(true);
    expect((await send(h, conversation.id, 'hi traveler')).success).toBe(true);
    const rows = await Message.findAll({ where: { conversationId: conversation.id }, order: [['createdAt', 'ASC']] });
    expect(rows.map((m) => m.senderType).sort()).toEqual(['HOST', 'USER']);
  });

  test('typing into a room the socket was not allowed to join reaches nobody', async () => {
    const t = await connect(memberToken(traveler));
    await join(t, conversation.id);
    const s = await connect(memberToken(stranger));
    await join(s, conversation.id);
    const got = await received(t, 'user_typing', async () => {
      s.emit('typing_start', { conversationId: conversation.id });
    });
    expect(got).toHaveLength(0);
  });

  test('another member cannot mark the conversation read', async () => {
    await conversation.update({ unreadCountUser: 3, unreadCountHost: 2 });
    const s = await connect(memberToken(stranger));
    s.emit('mark_read', { conversationId: conversation.id });
    await new Promise((r) => setTimeout(r, QUIET_MS));
    await conversation.reload();
    expect(conversation.unreadCountUser).toBe(3);
    expect(conversation.unreadCountHost).toBe(2);
  });

  test('the tenant room is joined only while the user belongs to the token\'s tenant', async () => {
    const own = await connect(hostToken(tenantA));
    const forged = await connect(hostToken(tenantB, tenantA.id));
    await new Promise((r) => setTimeout(r, 200));
    const probe = () => socketGateway.emitToTenant(tenantA.id, 'team_probe', { ok: true });
    const [gotOwn, gotForged] = await Promise.all([
      received(own, 'team_probe', probe),
      received(forged, 'team_probe', async () => {}),
    ]);
    expect(gotOwn).toHaveLength(1);
    expect(gotForged).toHaveLength(0);
  });

  test('a token in the query string is not accepted (it would land in access logs)', async () => {
    await expect(connect(memberToken(traveler), { viaQuery: true })).rejects.toThrow(/Authentication error/);
  });
});
