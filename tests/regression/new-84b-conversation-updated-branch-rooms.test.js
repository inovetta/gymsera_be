/**
 * NEW-84b — `conversation_updated` is branch-scoped like new_message (spec §9.2).
 *
 * A conversation preview (last message, unread counts) goes to the staff of the
 * conversation's branch, to org-wide staff, to the tenant owner and to the
 * traveler. Staff of another branch receive nothing. One emit per socket.
 */
const http = require('http');
const { io: ioClient } = require('socket.io-client');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  factories,
} = require('../harness');
const { buildTwoBranchTeam, teamMember } = require('../harness/two-branch-team');
const { signToken } = require('../../src/utils/jwt.utils');

const QUIET_MS = 400;

describe('NEW-84b: conversation_updated is branch-scoped', () => {
  let dbHarness;
  let personas;
  let team;
  let server;
  let url;
  let socketGateway;
  let ledgerService;
  let accessService;
  let staffB;
  let traveler;
  const clients = [];

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    team = await buildTwoBranchTeam(dbHarness, personas);
    staffB = await teamMember({
      tenantDb: dbHarness.tenant1,
      tenantId: team.tenantId,
      email: 'desk-b@new84b.test',
      roleKey: 'DESK',
      scopeType: 'BRANCH',
      branchIds: [team.branchB.id],
    });
    traveler = await factories.createUser({ email: 'traveler@new84b.test', role: 'MEMBER' });
    await require('../../src/models/platform').City.findOrCreate({
      where: { id: 1 },
      defaults: { id: 1, name: 'Karachi', isActive: true },
    });
    await factories.createGymListing(team.tenantId, { branchId: team.branchB.id });

    socketGateway = require('../../src/socket');
    ledgerService = require('../../src/services/ledger.service');
    accessService = require('../../src/services/access.service');
    server = http.createServer((_req, res) => res.end());
    socketGateway.init(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    while (clients.length) clients.pop().disconnect();
    const io = socketGateway.getIO();
    if (io) await new Promise((r) => io.close(() => r()));
    if (server.listening) await new Promise((r) => server.close(() => r()));
    await teardownTestDatabases();
  });

  const connect = (token) => new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token },
    });
    clients.push(socket);
    socket.once('connect', async () => {
      // rooms are computed asynchronously right after connect
      await new Promise((r) => setTimeout(r, 250));
      resolve(socket);
    });
    socket.once('connect_error', reject);
  });

  const received = async (socket, event, trigger) => {
    const got = [];
    const handler = (d) => got.push(d);
    socket.on(event, handler);
    await trigger();
    await new Promise((r) => setTimeout(r, QUIET_MS));
    socket.off(event, handler);
    return got;
  };

  const ownerToken = async () => {
    const { Tenant } = require('../../src/models/platform');
    const tenant = await Tenant.findByPk(team.tenantId);
    return signToken({
      sub: tenant.ownerUserId,
      id: tenant.ownerUserId,
      role: 'GYM_HOST',
      isVerified: true,
      tenantId: team.tenantId,
    });
  };

  const touch = (conversation) => () =>
    socketGateway.emitConversationUpdated(conversation.id, { lastMessageText: 'ping' });

  let conversationB;
  beforeAll(async () => {
    const { Conversation } = require('../../src/models/platform');
    conversationB = await Conversation.create({
      tenantId: team.tenantId,
      branchId: team.branchB.id,
      userId: traveler.id,
      type: 'INQUIRY',
    });
  });

  test('staff of another branch do not receive a branch-B conversation preview', async () => {
    const mgrA = await connect(team.managerA.token);
    expect(await received(mgrA, 'conversation_updated', touch(conversationB))).toHaveLength(0);
  });

  test('branch-B staff, org-wide staff and the owner each receive it exactly once', async () => {
    const sB = await connect(staffB.token);
    const orgAdmin = await connect(team.orgAdmin.token);
    const owner = await connect(await ownerToken());
    for (const s of [sB, orgAdmin, owner]) {
      expect(await received(s, 'conversation_updated', touch(conversationB))).toHaveLength(1);
    }
  });

  test('the conversation\'s traveler still receives it', async () => {
    const t = await connect(
      signToken({ sub: traveler.id, id: traveler.id, role: 'MEMBER', isVerified: true })
    );
    expect(await received(t, 'conversation_updated', touch(conversationB))).toHaveLength(1);
  });

  test('a branch-A conversation reaches branch-A staff', async () => {
    const { Conversation } = require('../../src/models/platform');
    const conversationA = await Conversation.create({
      tenantId: team.tenantId,
      branchId: team.branchA.id,
      userId: traveler.id,
      type: 'INQUIRY',
    });
    const mgrA = await connect(team.managerA.token);
    expect(await received(mgrA, 'conversation_updated', touch(conversationA))).toHaveLength(1);
  });
});
