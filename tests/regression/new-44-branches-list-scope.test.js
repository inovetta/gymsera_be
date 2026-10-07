/**
 * NEW-44 (2) — GET /gyms/branches returns only the branches the caller has any
 * grant at; owners and hosts still see every branch.
 *
 * Before: every team member got every branch of the tenant.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam, teamMember } = require('../harness/two-branch-team');

let app;
let team;
let personas;
let dbHarness;

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  team = await buildTwoBranchTeam(dbHarness, personas);
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const names = (res) => res.body.data.branches.map((b) => b.id).sort();
const list = (path, token) =>
  request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', team.tenantId);

describe('NEW-44: the branches list is scoped to the caller', () => {
  test('a Front Desk clerk at branch A sees only A', async () => {
    const res = await list('/gyms/branches', team.frontDeskOff.token);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual([team.branchA.id]);
  });

  test('a Branch Manager of A sees only A', async () => {
    const res = await list('/gyms/branches', team.managerA.token);
    expect(names(res)).toEqual([team.branchA.id]);
  });

  test('a team member assigned to B only sees only B', async () => {
    const atB = await teamMember({
      tenantDb: dbHarness.tenant1,
      tenantId: team.tenantId,
      email: 'desk-b@new44.test',
      roleKey: 'DESK',
      scopeType: 'BRANCH',
      branchIds: [team.branchB.id],
    });
    const res = await list('/gyms/branches', atB.token);
    expect(names(res)).toEqual([team.branchB.id]);
  });

  test('an Org Admin (organization-wide) sees every branch', async () => {
    const res = await list('/gyms/branches', team.orgAdmin.token);
    expect(names(res)).toEqual([team.branchA.id, team.branchB.id].sort());
  });

  test('the owner sees every branch, unchanged', async () => {
    const res = await list('/gyms/branches', team.ownerToken);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual([team.branchA.id, team.branchB.id].sort());
  });

  test('the host route the mobile app uses is unchanged for the owner', async () => {
    const res = await list('/host/branches', team.ownerToken);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual([team.branchA.id, team.branchB.id].sort());
  });

  test('a revoked team member sees no branches', async () => {
    const { RoleAssignment } = dbHarness.tenant1.models;
    const revoked = await teamMember({
      tenantDb: dbHarness.tenant1,
      tenantId: team.tenantId,
      email: 'revoked@new44.test',
      roleKey: 'DESK',
      scopeType: 'BRANCH',
      branchIds: [team.branchA.id],
    });
    await RoleAssignment.update({ status: 'REVOKED' }, { where: { id: revoked.assignment.id } });
    const res = await list('/gyms/branches', revoked.token);
    // Either refused outright or an empty list — never someone else's branches.
    const branches = res.status === 200 ? res.body.data.branches : [];
    expect(branches).toEqual([]);
  });
});
