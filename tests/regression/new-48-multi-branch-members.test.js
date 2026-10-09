/**
 * NEW-48: GET /gyms/members for a multi-branch Branch Manager.
 *
 * Verifies:
 * 1. Multi-branch Manager (3 branches) sees members across all 3 branches without query branchId.
 * 2. Multi-branch Manager passing ?branchId=B sees only members of Branch B.
 * 3. Single-branch Manager (Branch A only) sees only Branch A members.
 * 4. Single-branch Manager requesting a branch they do not have access to (?branchId=B) gets 403.
 * 5. Front Desk with members.view off gets 403 from can.atAnyBranch('members.view').
 * 6. Gym Owner sees members across all branches.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { teamMember } = require('../harness/two-branch-team');
const { GymListing } = require('../../src/models/platform');
const { signToken } = require('../../src/utils/jwt.utils');
const membershipService = require('../../src/services/membership.service');

let app;
let dbHarness;
let personas;
let tenantId;
let branchA;
let branchB;
let branchC;
let memberA;
let memberB;
let memberC;
let managerThree;
let managerOne;
let frontDeskOff;

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  app = await startTestServer();

  const tenantDb = dbHarness.tenant1;
  tenantId = personas.owner.tenantId;

  const listing = await GymListing.findOne({ where: { tenantId } });
  branchA = await tenantDb.models.Branch.findOne({ where: { gymListingId: listing.id } });
  branchB = await factories.createBranch(tenantDb, listing.id, { name: 'Branch B' });
  branchC = await factories.createBranch(tenantDb, listing.id, { name: 'Branch C' });

  const plan = await tenantDb.models.MembershipPlan.create({
    gymId: branchA.gymId,
    branchId: branchA.id,
    name: 'Standard Monthly',
    price: 3000,
    durationType: 'MONTHLY',
    durationValue: 1,
    status: 'ACTIVE',
  });

  // 3 distinct members in platform users
  memberA = await factories.createUser({ email: 'member-a@new48.test', fullName: 'Member Alpha', role: 'MEMBER' });
  memberB = await factories.createUser({ email: 'member-b@new48.test', fullName: 'Member Beta', role: 'MEMBER' });
  memberC = await factories.createUser({ email: 'member-c@new48.test', fullName: 'Member Gamma', role: 'MEMBER' });

  // 1 member subscription per branch
  await tenantDb.models.MemberSubscription.create({
    userId: memberA.id,
    membershipPlanId: plan.id,
    branchId: branchA.id,
    status: 'ACTIVE',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  });
  await tenantDb.models.MemberSubscription.create({
    userId: memberB.id,
    membershipPlanId: plan.id,
    branchId: branchB.id,
    status: 'ACTIVE',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  });
  await tenantDb.models.MemberSubscription.create({
    userId: memberC.id,
    membershipPlanId: plan.id,
    branchId: branchC.id,
    status: 'ACTIVE',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  });

  // Team members:
  // 1. Manager of all 3 branches
  managerThree = await teamMember({
    tenantDb,
    tenantId,
    email: 'mgr-three@new48.test',
    roleKey: 'MANAGER',
    scopeType: 'BRANCH',
    branchIds: [branchA.id, branchB.id, branchC.id],
  });

  // 2. Manager of only Branch A
  managerOne = await teamMember({
    tenantDb,
    tenantId,
    email: 'mgr-one@new48.test',
    roleKey: 'MANAGER',
    scopeType: 'BRANCH',
    branchIds: [branchA.id],
  });

  // 3. Front Desk with members.view OFF (override DENY)
  const fdUser = await factories.createUser({ email: 'fd-off@new48.test', role: 'MEMBER', fullName: 'FrontDesk Off' });
  const fdAssignment = await factories.createRoleAssignment(
    { ...tenantDb, tenantId },
    { userId: fdUser.id, roleKey: 'DESK', scopeType: 'BRANCH', branchIds: [branchA.id], overrides: { tenantId } }
  );
  await tenantDb.models.AssignmentOverride.create({
    assignmentId: fdAssignment.id,
    permissionKey: 'members.view',
    effect: 'DENY',
    createdBy: fdUser.id,
  });
  await membershipService.syncUserOrgIndex(tenantId, fdUser.id, tenantDb);
  frontDeskOff = {
    user: fdUser,
    token: signToken({ sub: fdUser.id, id: fdUser.id, email: fdUser.email, role: 'MEMBER', isVerified: true, tenantId }),
  };
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const getMembers = (token, query = '') =>
  request(app)
    .get(`/api/v1/gyms/members${query}`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Tenant-Id', tenantId);

describe('NEW-48: GET /gyms/members multi-branch access and permission enforcement', () => {
  test('manager of three branches sees members at all three', async () => {
    const res = await getMembers(managerThree.token);
    expect(res.status).toBe(200);
    const memberIds = res.body.data.members.map((m) => m.id);
    expect(memberIds).toHaveLength(3);
    expect(memberIds).toContain(memberA.id);
    expect(memberIds).toContain(memberB.id);
    expect(memberIds).toContain(memberC.id);
  });

  test('manager of three branches supplying ?branchId=branchB sees only branch B members', async () => {
    const res = await getMembers(managerThree.token, `?branchId=${branchB.id}`);
    expect(res.status).toBe(200);
    const memberIds = res.body.data.members.map((m) => m.id);
    expect(memberIds).toHaveLength(1);
    expect(memberIds[0]).toBe(memberB.id);
  });

  test('manager of one sees only that branch', async () => {
    const res = await getMembers(managerOne.token);
    expect(res.status).toBe(200);
    const memberIds = res.body.data.members.map((m) => m.id);
    expect(memberIds).toHaveLength(1);
    expect(memberIds[0]).toBe(memberA.id);
  });

  test('manager of one requesting branch they lack access to gets 403', async () => {
    const res = await getMembers(managerOne.token, `?branchId=${branchB.id}`);
    expect(res.status).toBe(403);
  });

  test('Front Desk with members.view off gets 403', async () => {
    const res = await getMembers(frontDeskOff.token);
    expect(res.status).toBe(403);
  });

  test('owner sees all members', async () => {
    const res = await getMembers(personas.owner.token);
    expect(res.status).toBe(200);
    const memberIds = res.body.data.members.map((m) => m.id);
    expect(memberIds).toHaveLength(3);
    expect(memberIds).toContain(memberA.id);
    expect(memberIds).toContain(memberB.id);
    expect(memberIds).toContain(memberC.id);
  });
});
