/**
 * NEW-85 — a gym member holding a tenant-scoped token must not join the staff
 * rooms of that tenant (spec §9.2).
 *
 * `userBelongsToTenant` also answers true for a plain gym member (a
 * UserGymMembership row). The socket gateway used it to admit a socket to
 * `tenant:{id}` and to branch rooms, so any signed token that names the tenant
 * would receive staff events. Staff = the tenant owner or someone with a live
 * role assignment; a paying member is neither.
 */
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { io: ioClient } = require('socket.io-client');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  factories,
} = require('../harness');
const { buildTwoBranchTeam } = require('../harness/two-branch-team');
const { signToken } = require('../../src/utils/jwt.utils');

const QUIET_MS = 400;

describe('NEW-85: gym member with a tenant-scoped token', () => {
  let dbHarness;
  let personas;
  let team;
  let server;
  let url;
  let socketGateway;
  let member;
  let conversation;
  const clients = [];

  beforeAll(async () => {
    const { UserGymMembership, GymListing, Conversation } = require('../../src/models/platform');
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    team = await buildTwoBranchTeam(dbHarness, personas);
    const listing = await GymListing.findOne({ where: { tenantId: team.tenantId } });

    member = await factories.createUser({ email: 'member@new85.test', role: 'MEMBER' });
    await UserGymMembership.create({
      userId: member.id,
      tenantId: team.tenantId,
      gymListingId: listing.id,
      subscriptionId: uuidv4(),
      gymName: 'Gym',
      planName: 'Monthly',
      status: 'ACTIVE',
    });
    // A conversation of somebody else, in this tenant's branch A.
    const other = await factories.createUser({ email: 'other@new85.test', role: 'MEMBER' });
    conversation = await Conversation.create({
      tenantId: team.tenantId,
      branchId: team.branchA.id,
      userId: other.id,
      type: 'INQUIRY',
    });

    socketGateway = require('../../src/socket');
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
      await new Promise((r) => setTimeout(r, 300)); // rooms are joined asynchronously
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

  // The token the issuer would never mint for a member, signed by the server key.
  const memberTenantToken = () =>
    signToken({
      sub: member.id,
      id: member.id,
      role: 'MEMBER',
      isVerified: true,
      tenantId: team.tenantId,
    });

  const roomsOf = async (userId) => {
    const sockets = await socketGateway.getIO().in(`user:${userId}`).fetchSockets();
    return [...new Set(sockets.flatMap((s) => [...s.rooms]))];
  };

  test('the member socket is in no tenant or branch room', async () => {
    await connect(memberTenantToken());
    const rooms = await roomsOf(member.id);
    expect(rooms.filter((r) => r.startsWith('tenant:'))).toEqual([]);
  });

  test('a tenant-wide staff event does not reach the member', async () => {
    const s = await connect(memberTenantToken());
    const got = await received(s, 'ledger_updated', () =>
      // no branchId: the fallback is the tenant room
      socketGateway.emitToBranch(team.tenantId, null, 'ledger_updated', { probe: true })
    );
    expect(got).toHaveLength(0);
  });

  test('a conversation preview and a new message of another member do not reach them', async () => {
    const s = await connect(memberTenantToken());
    const events = [];
    s.on('conversation_updated', (d) => events.push(['conversation_updated', d]));
    s.on('new_message', (d) => events.push(['new_message', d]));

    await socketGateway.emitConversationUpdated(conversation.id, { lastMessageText: 'secret' });
    await socketGateway.emitToBranch(team.tenantId, team.branchA.id, 'new_message', {
      conversationId: conversation.id,
      probe: true,
    });
    await new Promise((r) => setTimeout(r, QUIET_MS));

    expect(events).toEqual([]);
  });

  test('staff are unaffected: the owner and a branch manager still get tenant-wide events', async () => {
    const { Tenant } = require('../../src/models/platform');
    const tenant = await Tenant.findByPk(team.tenantId);
    const owner = await connect(
      signToken({
        sub: tenant.ownerUserId,
        id: tenant.ownerUserId,
        role: 'GYM_HOST',
        isVerified: true,
        tenantId: team.tenantId,
      })
    );
    const mgr = await connect(team.managerA.token);
    for (const s of [owner, mgr]) {
      const got = await received(s, 'ledger_updated', () =>
        socketGateway.emitToBranch(team.tenantId, null, 'ledger_updated', { probe: true })
      );
      expect(got).toHaveLength(1);
    }
  });
});
