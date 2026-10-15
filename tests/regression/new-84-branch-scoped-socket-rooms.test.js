/**
 * NEW-84 — branch-scoped socket rooms (spec §9.2).
 *
 * The server puts a staff socket only in the branch rooms it holds a grant on,
 * and `new_message` / `ledger_updated` go to a branch room, not to the whole
 * tenant. Tenant owners and org-wide staff receive every branch. A grants
 * change re-syncs the rooms of sockets that are already connected.
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

describe('NEW-84: branch-scoped socket rooms', () => {
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
      email: 'desk-b@new84.test',
      roleKey: 'DESK',
      scopeType: 'BRANCH',
      branchIds: [team.branchB.id],
    });
    traveler = await factories.createUser({ email: 'traveler@new84.test', role: 'MEMBER' });
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

  const ledgerAt = (branchId) => () =>
    ledgerService.notifyLedgerUpdated(team.tenantId, branchId, '2026-10-15');

  const inquiryAt = (branchId) => () =>
    require('../../src/services/inbox.service').createTravelerInquiry(
      traveler.id,
      branchId,
      'Is the gym open on Friday?'
    );

  test('ledger_updated: branch-A staff do not receive branch B, and do receive branch A', async () => {
    const mgrA = await connect(team.managerA.token);
    expect(await received(mgrA, 'ledger_updated', ledgerAt(team.branchB.id))).toHaveLength(0);
    expect(await received(mgrA, 'ledger_updated', ledgerAt(team.branchA.id))).toHaveLength(1);
  });

  test('ledger_updated: branch-B staff receive branch B only', async () => {
    const s = await connect(staffB.token);
    expect(await received(s, 'ledger_updated', ledgerAt(team.branchB.id))).toHaveLength(1);
    expect(await received(s, 'ledger_updated', ledgerAt(team.branchA.id))).toHaveLength(0);
  });

  test('ledger_updated: org-wide staff and the tenant owner receive every branch', async () => {
    const orgAdmin = await connect(team.orgAdmin.token);
    const owner = await connect(await ownerToken());
    for (const s of [orgAdmin, owner]) {
      expect(await received(s, 'ledger_updated', ledgerAt(team.branchA.id))).toHaveLength(1);
      expect(await received(s, 'ledger_updated', ledgerAt(team.branchB.id))).toHaveLength(1);
    }
  });

  test('new_message from a branch-B inquiry reaches B staff, org-wide staff and the owner, not branch-A staff', async () => {
    const mgrA = await connect(team.managerA.token);
    const sB = await connect(staffB.token);
    const orgAdmin = await connect(team.orgAdmin.token);
    const owner = await connect(await ownerToken());

    const events = { mgrA: [], sB: [], orgAdmin: [], owner: [] };
    const subs = { mgrA, sB, orgAdmin, owner };
    for (const [k, s] of Object.entries(subs)) s.on('new_message', (d) => events[k].push(d));
    await inquiryAt(team.branchB.id)();
    await new Promise((r) => setTimeout(r, QUIET_MS));

    expect(events.mgrA).toHaveLength(0);
    expect(events.sB).toHaveLength(1);
    expect(events.orgAdmin).toHaveLength(1);
    expect(events.owner).toHaveLength(1);
  });

  test('grants.changed: a revoked branch stops delivering to a socket that is already connected', async () => {
    const s = await connect(staffB.token);
    expect(await received(s, 'ledger_updated', ledgerAt(team.branchB.id))).toHaveLength(1);

    await dbHarness.tenant1.models.RoleAssignment.update(
      { status: 'REVOKED' },
      { where: { id: staffB.assignment.id } }
    );
    await accessService.bumpUserPermissionVersion(staffB.user.id);
    await new Promise((r) => setTimeout(r, 300));

    expect(await received(s, 'ledger_updated', ledgerAt(team.branchB.id))).toHaveLength(0);
  });

  test('grants.changed: a newly granted branch starts delivering without a reconnect', async () => {
    const mgrA = await connect(team.managerA.token);
    expect(await received(mgrA, 'ledger_updated', ledgerAt(team.branchB.id))).toHaveLength(0);

    await dbHarness.tenant1.models.RoleAssignmentBranch.create({
      assignmentId: team.managerA.assignment.id,
      branchId: team.branchB.id,
    });
    await accessService.bumpUserPermissionVersion(team.managerA.user.id);
    await new Promise((r) => setTimeout(r, 300));

    expect(await received(mgrA, 'ledger_updated', ledgerAt(team.branchB.id))).toHaveLength(1);
  });
});
