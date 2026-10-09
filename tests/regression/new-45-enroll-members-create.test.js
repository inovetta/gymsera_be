/**
 * NEW-45 (a) — POST /gyms/members/enroll goes through members.create and the
 * approval engine (approvalService.perform), like every other approvable action.
 *
 * Before: no permission check and no approval tier. Any team member (a Trainer, a
 * Support account) could enrol a member directly.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam, teamMember } = require('../harness/two-branch-team');

let app;
let team;
let dbHarness;
let plan;
let trainer;
let branchAdmin;
let seq = 0;

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  const personas = await setupPersonas(dbHarness);
  team = await buildTwoBranchTeam(dbHarness, personas);
  app = await startTestServer();

  plan = await dbHarness.tenant1.models.MembershipPlan.create({
    gymId: team.branchA.gymId,
    branchId: team.branchA.id,
    name: 'Standard Monthly',
    price: 3000,
    durationType: 'MONTHLY',
    durationValue: 1,
    status: 'ACTIVE',
  });

  const base = { tenantDb: dbHarness.tenant1, tenantId: team.tenantId, scopeType: 'BRANCH', branchIds: [team.branchA.id] };
  trainer = await teamMember({ ...base, email: 'trainer@new45.test', roleKey: 'TRAINER' });
  branchAdmin = await teamMember({ ...base, email: 'bradmin@new45.test', roleKey: 'BR_ADMIN' });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const enroll = (token, over = {}) => {
  seq += 1;
  const body = { email: `walkin${seq}@new45.test`, fullName: 'Walk In', planId: plan.id, branchId: team.branchA.id, ...over };
  return { body, call: request(app).post('/api/v1/gyms/members/enroll').set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', team.tenantId).send(body) };
};

const subscriptionsFor = async (email) => {
  const { User } = require('../../src/models/platform');
  const user = await User.findOne({ where: { email } });
  if (!user) return { user: null, count: 0 };
  const count = await dbHarness.tenant1.models.MemberSubscription.count({ where: { userId: user.id } });
  return { user, count };
};

describe('NEW-45: member enrolment follows members.create', () => {
  test('a Trainer (no members.create) gets 403 and nothing is created', async () => {
    const { body, call } = enroll(trainer.token);
    const res = await call;
    expect(res.status).toBe(403);
    expect(await subscriptionsFor(body.email)).toEqual({ user: null, count: 0 });
  });

  test('Front Desk holds it at "needs approval": 202, a pending request, nothing enrolled yet', async () => {
    const { body, call } = enroll(team.frontDeskOff.token);
    const res = await call;
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.approvalRequestId).toBeTruthy();

    const request = await dbHarness.tenant1.models.ApprovalRequest.findByPk(res.body.data.approvalRequestId);
    expect(request.actionKey).toBe('members.create');
    expect(request.status).toBe('PENDING');
    expect(request.branchId).toBe(team.branchA.id);
    expect((await subscriptionsFor(body.email)).count).toBe(0);
  });

  test('approving that request (an Org Admin; /approvals checks organization-wide grants) enrols the member', async () => {
    const { body, call } = enroll(team.frontDeskOff.token);
    const pending = await call;
    const approve = await request(app)
      .post(`/api/v1/approvals/${pending.body.data.approvalRequestId}/approve`)
      .set('Authorization', `Bearer ${team.orgAdmin.token}`)
      .set('X-Tenant-Id', team.tenantId)
      .send({});
    expect(approve.status).toBe(200);
    expect((await subscriptionsFor(body.email)).count).toBe(1);
  });

  test('Front Desk at branch A cannot enrol at branch B: 403', async () => {
    const { body, call } = enroll(team.frontDeskOff.token, { branchId: team.branchB.id });
    const res = await call;
    expect(res.status).toBe(403);
    expect((await subscriptionsFor(body.email)).user).toBeNull();
  });

  test.each([
    ['Branch Admin', () => branchAdmin.token],
    ['Branch Manager', () => team.managerA.token],
    ['Org Admin', () => team.orgAdmin.token],
  ])('%s holds it directly: 201, enrolled at once, same response shape', async (_label, token) => {
    const { body, call } = enroll(token());
    const res = await call;
    expect(res.status).toBe(201);
    expect(res.body.data.userCreated).toBe(true);
    expect(res.body.data.user.email).toBe(body.email);
    expect(res.body.data.subscription.branchId).toBe(team.branchA.id);
    expect((await subscriptionsFor(body.email)).count).toBe(1);
  });

  test('the owner is unchanged: 201 with user, subscription and userCreated', async () => {
    const { body, call } = enroll(team.ownerToken);
    const res = await call;
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Member enrolled successfully');
    expect(res.body.data.user.email).toBe(body.email);
    expect(res.body.data.subscription.status).toBe('ACTIVE');
    expect(res.body.data.userCreated).toBe(true);
    expect((await subscriptionsFor(body.email)).count).toBe(1);
  });

  test('a body with no branch or no plan is a 400, not a 500', async () => {
    const noBranch = enroll(team.ownerToken, { branchId: undefined });
    expect((await noBranch.call).status).toBe(400);
    const noPlan = enroll(team.ownerToken, { planId: undefined });
    expect((await noPlan.call).status).toBe(400);
  });
});
