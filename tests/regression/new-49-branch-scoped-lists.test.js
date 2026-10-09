/**
 * NEW-49: branch scoping on the staff lists for subscriptions, attendance,
 * membership plans and trainers.
 *
 * Per route, with three branches (A, B, C) and one record at each:
 *  1. Manager of all 3 branches sees all 3.
 *  2. Manager of 1 branch sees only that branch's record.
 *  3. Manager of 1 asking for a branch they lack gets 403.
 *  4. A role with the permission key off gets 403.
 *  5. The owner sees all 3.
 *
 * Routes: GET /subscriptions/staff, GET /attendance, GET /membership-plans/host,
 * GET /trainers.
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
let branches; // { a, b, c }
let rec; // per-route seeded record ids, keyed by branch letter
let managerThree;
let managerOne;
const keyOff = {}; // permission key -> { token } for a Front Desk with that key DENIED

const KEYS = ['subscriptions.view', 'checkins.view', 'plans.view', 'team.view'];

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  app = await startTestServer();

  const tenantDb = dbHarness.tenant1;
  tenantId = personas.owner.tenantId;
  const { Branch, MembershipPlan, MemberSubscription, AttendanceLog, Trainer, AssignmentOverride } = tenantDb.models;

  const listing = await GymListing.findOne({ where: { tenantId } });
  const a = await Branch.findOne({ where: { gymListingId: listing.id } });
  const b = await factories.createBranch(tenantDb, listing.id, { name: 'Branch B' });
  const c = await factories.createBranch(tenantDb, listing.id, { name: 'Branch C' });
  branches = { a, b, c };

  rec = { subs: {}, logs: {}, plans: {}, trainers: {} };
  let n = 0;
  for (const [letter, branch] of Object.entries(branches)) {
    n += 1;
    const plan = await MembershipPlan.create({
      gymId: a.gymId,
      branchId: branch.id,
      name: `N49 plan ${letter}`,
      price: 1000 + n,
      durationType: 'MONTHLY',
      durationValue: 1,
      status: 'ACTIVE',
    });
    rec.plans[letter] = plan.id;

    const member = await factories.createUser({ email: `member-${letter}@new49.test`, fullName: `Member ${letter}`, role: 'MEMBER' });
    const sub = await MemberSubscription.create({
      userId: member.id,
      membershipPlanId: plan.id,
      branchId: branch.id,
      status: 'ACTIVE',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    rec.subs[letter] = sub.id;

    const log = await AttendanceLog.create({
      branchId: branch.id,
      userId: member.id,
      memberSubscriptionId: sub.id,
      attendanceType: 'CHECK_IN',
      checkInAt: new Date(),
      entryMethod: 'MANUAL',
    });
    rec.logs[letter] = log.id;

    const trainerUser = await factories.createUser({ email: `trainer-${letter}@new49.test`, fullName: `Trainer ${letter}`, role: 'MEMBER' });
    const trainer = await Trainer.create({ userId: trainerUser.id, branchId: branch.id, status: 'ACTIVE' });
    rec.trainers[letter] = trainer.id;
  }

  managerThree = await teamMember({
    tenantDb, tenantId, email: 'mgr-three@new49.test', roleKey: 'MANAGER', scopeType: 'BRANCH',
    branchIds: [a.id, b.id, c.id],
  });
  managerOne = await teamMember({
    tenantDb, tenantId, email: 'mgr-one@new49.test', roleKey: 'MANAGER', scopeType: 'BRANCH',
    branchIds: [a.id],
  });

  // One Front Desk per key, with exactly that key DENIED.
  for (const key of KEYS) {
    const slug = key.replace('.', '-');
    const user = await factories.createUser({ email: `fd-${slug}@new49.test`, role: 'MEMBER', fullName: `FD ${slug}` });
    const assignment = await factories.createRoleAssignment(
      { ...tenantDb, tenantId },
      { userId: user.id, roleKey: 'DESK', scopeType: 'BRANCH', branchIds: [a.id], overrides: { tenantId } }
    );
    await AssignmentOverride.create({ assignmentId: assignment.id, permissionKey: key, effect: 'DENY', createdBy: user.id });
    await membershipService.syncUserOrgIndex(tenantId, user.id, tenantDb);
    keyOff[key] = {
      token: signToken({ sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true, tenantId }),
    };
  }
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const get = (path, token, query = '') =>
  request(app).get(`${path}${query}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', tenantId);

// Each route: how to call it, which key guards it, and how to read the ids of the
// seeded records out of the response.
const ROUTES = [
  {
    name: 'GET /subscriptions/staff',
    path: '/api/v1/subscriptions/staff',
    key: 'subscriptions.view',
    seeded: () => rec.subs,
    ids: (body) => body.data.subscriptions.map((s) => s.id),
  },
  {
    name: 'GET /attendance',
    path: '/api/v1/attendance',
    key: 'checkins.view',
    seeded: () => rec.logs,
    ids: (body) => body.data.logs.map((l) => l.id),
  },
  {
    name: 'GET /membership-plans/host',
    path: '/api/v1/membership-plans/host',
    key: 'plans.view',
    seeded: () => rec.plans,
    ids: (body) => body.data.plans.map((p) => p.id),
  },
  {
    name: 'GET /trainers',
    path: '/api/v1/trainers',
    key: 'team.view',
    seeded: () => rec.trainers,
    ids: (body) => body.data.trainers.map((t) => t.id),
  },
];

describe.each(ROUTES)('NEW-49: $name', ({ path, key, seeded, ids }) => {
  const seenOf = (res) => {
    const got = new Set(ids(res.body));
    return Object.entries(seeded()).filter(([, id]) => got.has(id)).map(([letter]) => letter).sort();
  };

  test('manager of three branches sees all three', async () => {
    const res = await get(path, managerThree.token);
    expect(res.status).toBe(200);
    expect(seenOf(res)).toEqual(['a', 'b', 'c']);
  });

  test('manager of one sees only their branch', async () => {
    const res = await get(path, managerOne.token);
    expect(res.status).toBe(200);
    expect(seenOf(res)).toEqual(['a']);
  });

  test('manager of one can filter to their own branch', async () => {
    const res = await get(path, managerOne.token, `?branchId=${branches.a.id}`);
    expect(res.status).toBe(200);
    expect(seenOf(res)).toEqual(['a']);
  });

  test('manager of one requesting a branch they lack gets 403', async () => {
    const res = await get(path, managerOne.token, `?branchId=${branches.b.id}`);
    expect(res.status).toBe(403);
  });

  test(`role with ${key} off gets 403`, async () => {
    const res = await get(path, keyOff[key].token);
    expect(res.status).toBe(403);
  });

  test('owner sees all three', async () => {
    const res = await get(path, personas.owner.token);
    expect(res.status).toBe(200);
    expect(seenOf(res)).toEqual(['a', 'b', 'c']);
  });
});
