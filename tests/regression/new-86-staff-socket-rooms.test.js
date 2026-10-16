/**
 * NEW-86 — staff sockets join tenant and branch rooms (spec §9.2).
 *
 * Every token here comes from a real POST /auth/login. A team member's token
 * has role MEMBER and tenantId null, so the gateway has to derive the orgs from
 * verified staff relationships. The earlier room tests signed `tenantId` into
 * their tokens by hand, which real logins never carry, so they could not see
 * this. The one hand-signed token below is the "foreign tenantId claim" case.
 */
const http = require('http');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { io: ioClient } = require('socket.io-client');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  factories,
} = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam, teamMember } = require('../harness/two-branch-team');
const { signToken } = require('../../src/utils/jwt.utils');
const membershipService = require('../../src/services/membership.service');

const QUIET_MS = 400;
const PASSWORD = 'Test@12345';

describe('NEW-86: staff socket rooms from verified membership', () => {
  let dbHarness;
  let personas;
  let team;
  let appServer;
  let server;
  let url;
  let socketGateway;
  let ledgerService;
  let accessService;
  let T1;
  let T2;
  const clients = [];

  beforeAll(async () => {
    const bcrypt = require('bcrypt');
    const { Tenant, User } = require('../../src/models/platform');
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    team = await buildTwoBranchTeam(dbHarness, personas);
    T1 = team.tenantId;
    T2 = require('../harness/personas').personaManager.context.tenant2.id;
    const tenant = await Tenant.findByPk(T1);
    team.ownerUser = await User.findByPk(tenant.ownerUserId);
    await team.ownerUser.update({ passwordHash: bcrypt.hashSync(PASSWORD, 8) });

    appServer = await startTestServer();
    socketGateway = require('../../src/socket');
    ledgerService = require('../../src/services/ledger.service');
    accessService = require('../../src/services/access.service');
    server = http.createServer((_req, res) => res.end());
    socketGateway.init(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  // One user, one socket at a time: rooms are read per user.
  afterEach(async () => {
    while (clients.length) clients.pop().disconnect();
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    while (clients.length) clients.pop().disconnect();
    const io = socketGateway.getIO();
    if (io) await new Promise((r) => io.close(() => r()));
    if (server.listening) await new Promise((r) => server.close(() => r()));
    await teardownTestDatabases();
  });

  /** A token from the real login route; the claims are whatever the issuer mints. */
  const login = async (email) => {
    const res = await request(appServer).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body.data.accessToken;
  };

  const connect = (token, auth = {}) => new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token, ...auth },
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

  const roomsOf = async (userId) => {
    const sockets = await socketGateway.getIO().in(`user:${userId}`).fetchSockets();
    return [...new Set(sockets.flatMap((s) => [...s.rooms]))].filter((r) => r !== sockets[0]?.id).sort();
  };
  const tenantRoomsOf = async (userId) => (await roomsOf(userId)).filter((r) => r.startsWith('tenant:'));

  const ledgerAt = (tenantId, branchId) => () =>
    ledgerService.notifyLedgerUpdated(tenantId, branchId, '2026-10-16');

  const settle = () => new Promise((r) => setTimeout(r, 300));

  test('owner: exactly user:{id} and tenant:{T}, no branch or org room', async () => {
    const token = await login(team.ownerUser.email);
    await connect(token);
    expect(await roomsOf(team.ownerUser.id)).toEqual(
      [`tenant:${T1}`, `user:${team.ownerUser.id}`].sort()
    );
  });

  test('branch manager (token tenantId null) joins tenant:{T} and its branch only', async () => {
    const token = await login(team.managerA.user.email);
    expect(JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).tenantId).toBeNull();
    await connect(token);
    expect(await tenantRoomsOf(team.managerA.user.id)).toEqual(
      [`tenant:${T1}`, `tenant:${T1}:branch:${team.branchA.id}`].sort()
    );
  });

  test('front desk joins tenant:{T} and its branch only', async () => {
    await connect(await login(team.frontDeskOff.user.email));
    expect(await tenantRoomsOf(team.frontDeskOff.user.id)).toEqual(
      [`tenant:${T1}`, `tenant:${T1}:branch:${team.branchA.id}`].sort()
    );
  });

  test('org-wide admin joins tenant:{T} and the org room, no branch rooms', async () => {
    await connect(await login(team.orgAdmin.user.email));
    expect(await tenantRoomsOf(team.orgAdmin.user.id)).toEqual(
      [`tenant:${T1}`, `tenant:${T1}:org`].sort()
    );
  });

  test('ledger_updated reaches the right staff by real login', async () => {
    const mgrA = await connect(await login(team.managerA.user.email));
    const orgAdmin = await connect(await login(team.orgAdmin.user.email));
    const owner = await connect(await login(team.ownerUser.email));

    expect(await received(mgrA, 'ledger_updated', ledgerAt(T1, team.branchB.id))).toHaveLength(0);
    expect(await received(mgrA, 'ledger_updated', ledgerAt(T1, team.branchA.id))).toHaveLength(1);
    for (const s of [orgAdmin, owner]) {
      expect(await received(s, 'ledger_updated', ledgerAt(T1, team.branchA.id))).toHaveLength(1);
      expect(await received(s, 'ledger_updated', ledgerAt(T1, team.branchB.id))).toHaveLength(1);
    }
  });

  describe('several organizations', () => {
    let multi;

    beforeAll(async () => {
      multi = await teamMember({
        tenantDb: dbHarness.tenant1,
        tenantId: T1,
        email: 'multi@new86.test',
        roleKey: 'MANAGER',
        scopeType: 'BRANCH',
        branchIds: [team.branchA.id],
      });
      await factories.createRoleAssignment(
        { ...dbHarness.tenant2, tenantId: T2 },
        { userId: multi.user.id, roleKey: 'ORG_ADMIN', scopeType: 'ORG', overrides: { tenantId: T2 } }
      );
      await membershipService.syncUserOrgIndex(T2, multi.user.id, dbHarness.tenant2);
    });

    test('joins the rooms of every org they are staff of', async () => {
      await connect(await login(multi.user.email));
      expect(await tenantRoomsOf(multi.user.id)).toEqual(
        [`tenant:${T1}`, `tenant:${T1}:branch:${team.branchA.id}`, `tenant:${T2}`, `tenant:${T2}:org`].sort()
      );
    });

    test('a handshake tenantId narrows to that org', async () => {
      await connect(await login(multi.user.email), { tenantId: T2 });
      expect(await tenantRoomsOf(multi.user.id)).toEqual([`tenant:${T2}`, `tenant:${T2}:org`].sort());
    });

    test('a handshake tenantId for an org they are not staff of joins nothing', async () => {
      await connect(await login(team.managerA.user.email), { tenantId: T2 });
      expect(await tenantRoomsOf(team.managerA.user.id)).toEqual([]);
    });
  });

  test('a gym member (membership row only) joins no staff room', async () => {
    const { UserGymMembership, GymListing } = require('../../src/models/platform');
    const listing = await GymListing.findOne({ where: { tenantId: T1 } });
    const member = await factories.createUser({ email: 'member@new86.test', role: 'MEMBER' });
    await UserGymMembership.create({
      userId: member.id,
      tenantId: T1,
      gymListingId: listing.id,
      subscriptionId: uuidv4(),
      gymName: 'Gym',
      planName: 'Monthly',
      status: 'ACTIVE',
    });
    const socket = await connect(await login(member.email));
    expect(await tenantRoomsOf(member.id)).toEqual([]);
    expect(await received(socket, 'ledger_updated', ledgerAt(T1, team.branchA.id))).toHaveLength(0);
  });

  test('a revoked assignment joins nothing on a fresh connect', async () => {
    const gone = await teamMember({
      tenantDb: dbHarness.tenant1, tenantId: T1, email: 'revoked@new86.test',
      roleKey: 'DESK', scopeType: 'BRANCH', branchIds: [team.branchA.id],
    });
    await gone.assignment.update({ status: 'REVOKED', revokedAt: new Date() });
    await membershipService.syncUserOrgIndex(T1, gone.user.id, dbHarness.tenant1);
    await connect(await login(gone.user.email));
    expect(await tenantRoomsOf(gone.user.id)).toEqual([]);
  });

  test('a suspended assignment joins nothing on a fresh connect', async () => {
    const paused = await teamMember({
      tenantDb: dbHarness.tenant1, tenantId: T1, email: 'suspended@new86.test',
      roleKey: 'DESK', scopeType: 'BRANCH', branchIds: [team.branchA.id],
    });
    await paused.assignment.update({ status: 'SUSPENDED' });
    await membershipService.syncUserOrgIndex(T1, paused.user.id, dbHarness.tenant1);
    await connect(await login(paused.user.email));
    expect(await tenantRoomsOf(paused.user.id)).toEqual([]);
  });

  test('an assignment suspended while connected removes the rooms live', async () => {
    const live = await teamMember({
      tenantDb: dbHarness.tenant1, tenantId: T1, email: 'live@new86.test',
      roleKey: 'DESK', scopeType: 'BRANCH', branchIds: [team.branchA.id],
    });
    await connect(await login(live.user.email));
    expect(await tenantRoomsOf(live.user.id)).toContain(`tenant:${T1}`);

    await live.assignment.update({ status: 'SUSPENDED' });
    await membershipService.syncUserOrgIndex(T1, live.user.id, dbHarness.tenant1);
    await accessService.bumpUserPermissionVersion(live.user.id);
    await settle();
    expect(await tenantRoomsOf(live.user.id)).toEqual([]);
  });

  test('an org joined while connected is picked up on grants.changed', async () => {
    const late = await teamMember({
      tenantDb: dbHarness.tenant1, tenantId: T1, email: 'late@new86.test',
      roleKey: 'DESK', scopeType: 'BRANCH', branchIds: [team.branchA.id],
    });
    await connect(await login(late.user.email));
    await factories.createRoleAssignment(
      { ...dbHarness.tenant2, tenantId: T2 },
      { userId: late.user.id, roleKey: 'ORG_ADMIN', scopeType: 'ORG', overrides: { tenantId: T2 } }
    );
    await membershipService.syncUserOrgIndex(T2, late.user.id, dbHarness.tenant2);
    await accessService.bumpUserPermissionVersion(late.user.id);
    await settle();
    expect(await tenantRoomsOf(late.user.id)).toEqual(
      expect.arrayContaining([`tenant:${T2}`, `tenant:${T2}:org`])
    );
  });

  test('a token claiming a tenant the user does not belong to joins nothing there', async () => {
    const forged = signToken({
      sub: team.managerA.user.id,
      id: team.managerA.user.id,
      role: 'MEMBER',
      isVerified: true,
      tenantId: T2,
    });
    await connect(forged);
    const rooms = await tenantRoomsOf(team.managerA.user.id);
    expect(rooms.filter((r) => r.startsWith(`tenant:${T2}`))).toEqual([]);
    // The rooms still come from verified membership: tenant 1, branch A.
    expect(rooms).toEqual([`tenant:${T1}`, `tenant:${T1}:branch:${team.branchA.id}`].sort());
  });
});
