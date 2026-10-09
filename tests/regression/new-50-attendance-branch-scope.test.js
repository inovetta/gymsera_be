/**
 * NEW-50: branch scoping on the remaining attendance read routes, plus the
 * subscription.service listForStaff early-exit response shape.
 *
 * Per attendance route, with three branches (A, B, C) holding 1, 2 and 4 check-ins:
 *  1. Manager of all 3 sees all 3.
 *  2. Manager of 1 sees only that branch.
 *  3. Manager of 1 asking for a branch they lack gets 403.
 *  4. A role with checkins.view DENIED gets 403 (and a Front Desk without the
 *     override gets 200, so the 403 is the permission and not the role gate).
 *  5. The owner sees all 3.
 *
 * Routes: GET /attendance/today, /range, /customer/:userId, /report, /report/:period.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { teamMember } = require('../harness/two-branch-team');
const { GymListing } = require('../../src/models/platform');
const { signToken } = require('../../src/utils/jwt.utils');
const membershipService = require('../../src/services/membership.service');
const subscriptionService = require('../../src/services/subscription.service');

let app;
let dbHarness;
let personas;
let tenantId;
let branches; // { a, b, c }
let member; // one member with check-ins at every branch
let firstLog; // branch letter -> id of one seeded log
let managerThree;
let managerOne;
let deskOn; // Front Desk, checkins.view left at its default
let deskOff; // Front Desk, checkins.view DENIED

const COUNTS = { a: 1, b: 2, c: 4 };

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  app = await startTestServer();

  const tenantDb = dbHarness.tenant1;
  tenantId = personas.owner.tenantId;
  const { Branch, AttendanceLog, AssignmentOverride } = tenantDb.models;

  const listing = await GymListing.findOne({ where: { tenantId } });
  const a = await Branch.findOne({ where: { gymListingId: listing.id } });
  const b = await factories.createBranch(tenantDb, listing.id, { name: 'Branch B' });
  const c = await factories.createBranch(tenantDb, listing.id, { name: 'Branch C' });
  branches = { a, b, c };

  member = await factories.createUser({ email: 'member@new50.test', fullName: 'Member N50', role: 'MEMBER' });
  firstLog = {};
  for (const [letter, branch] of Object.entries(branches)) {
    for (let i = 0; i < COUNTS[letter]; i += 1) {
      const log = await AttendanceLog.create({
        branchId: branch.id,
        userId: member.id,
        attendanceType: 'CHECK_IN',
        checkInAt: new Date(),
        entryMethod: 'MANUAL',
      });
      if (i === 0) firstLog[letter] = log.id;
    }
  }

  managerThree = await teamMember({
    tenantDb, tenantId, email: 'mgr-three@new50.test', roleKey: 'MANAGER', scopeType: 'BRANCH',
    branchIds: [a.id, b.id, c.id],
  });
  managerOne = await teamMember({
    tenantDb, tenantId, email: 'mgr-one@new50.test', roleKey: 'MANAGER', scopeType: 'BRANCH',
    branchIds: [a.id],
  });

  const makeDesk = async (email, denyKey) => {
    const user = await factories.createUser({ email, role: 'MEMBER', fullName: email });
    const assignment = await factories.createRoleAssignment(
      { ...tenantDb, tenantId },
      { userId: user.id, roleKey: 'DESK', scopeType: 'BRANCH', branchIds: [a.id], overrides: { tenantId } }
    );
    if (denyKey) {
      await AssignmentOverride.create({ assignmentId: assignment.id, permissionKey: denyKey, effect: 'DENY', createdBy: user.id });
    }
    await membershipService.syncUserOrgIndex(tenantId, user.id, tenantDb);
    return { token: signToken({ sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true, tenantId }) };
  };
  deskOn = await makeDesk('fd-on@new50.test', null);
  deskOff = await makeDesk('fd-off@new50.test', 'checkins.view');
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const get = (path, token, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  const sep = path.includes('?') ? '&' : '?';
  return request(app).get(`${path}${qs ? sep + qs : ''}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', tenantId);
};

// Each route: how to call it and how to reduce a response to what it exposes.
// `logs` routes report which branch letters appear; report routes report the total.
const logLetters = (body) => {
  const got = new Set(body.data.logs.map((l) => l.id));
  return Object.entries(firstLog).filter(([, id]) => got.has(id)).map(([letter]) => letter).sort();
};
const reportTotal = (body) => body.data.rows.reduce((n, r) => n + Number(r.checkIns), 0);

const ROUTES = [
  { name: 'GET /attendance/today', path: () => '/api/v1/attendance/today', params: {}, observe: logLetters, all: ['a', 'b', 'c'], onlyA: ['a'] },
  { name: 'GET /attendance/range', path: () => '/api/v1/attendance/range', params: { from: day(-1), to: day(1) }, observe: logLetters, all: ['a', 'b', 'c'], onlyA: ['a'] },
  { name: 'GET /attendance/customer/:userId', path: () => `/api/v1/attendance/customer/${member.id}`, params: {}, observe: logLetters, all: ['a', 'b', 'c'], onlyA: ['a'] },
  { name: 'GET /attendance/report?period=', path: () => '/api/v1/attendance/report?period=monthly', params: {}, observe: reportTotal, all: 7, onlyA: 1 },
  { name: 'GET /attendance/report/:period', path: () => '/api/v1/attendance/report/daily', params: {}, observe: reportTotal, all: 7, onlyA: 1 },
];

describe.each(ROUTES)('NEW-50: $name', ({ path, params, observe, all, onlyA }) => {
  test('manager of three branches sees all three', async () => {
    const res = await get(path(), managerThree.token, params);
    expect(res.status).toBe(200);
    expect(observe(res.body)).toEqual(all);
  });

  test('manager of one sees only their branch', async () => {
    const res = await get(path(), managerOne.token, params);
    expect(res.status).toBe(200);
    expect(observe(res.body)).toEqual(onlyA);
  });

  test('manager of one can filter to their own branch', async () => {
    const res = await get(path(), managerOne.token, { ...params, branchId: branches.a.id });
    expect(res.status).toBe(200);
    expect(observe(res.body)).toEqual(onlyA);
  });

  test('manager of one requesting a branch they lack gets 403', async () => {
    const res = await get(path(), managerOne.token, { ...params, branchId: branches.b.id });
    expect(res.status).toBe(403);
  });

  test('Front Desk with checkins.view on sees only their branch', async () => {
    const res = await get(path(), deskOn.token, params);
    expect(res.status).toBe(200);
    expect(observe(res.body)).toEqual(onlyA);
  });

  test('role with checkins.view off gets 403', async () => {
    const res = await get(path(), deskOff.token, params);
    expect(res.status).toBe(403);
  });

  test('owner sees all three', async () => {
    const res = await get(path(), personas.owner.token, params);
    expect(res.status).toBe(200);
    expect(observe(res.body)).toEqual(all);
  });
});

describe('NEW-50: listForStaff early exits return the normal response shape', () => {
  const page = 1;
  const limit = 20;
  const offset = 0;
  const stubDb = (activeIds) => ({
    models: { MemberSubscription: {}, MembershipPlan: {}, Payment: {}, Branch: { findAll: async () => activeIds.map((id) => ({ id })) } },
  });

  test('no active branches', async () => {
    const result = await subscriptionService.listForStaff(stubDb([]), { page, limit, offset });
    expect(result.subscriptions).toEqual([]);
    expect(result.pagination).toEqual(expect.objectContaining({ total: 0 }));
  });

  test('branchId that is not an active branch', async () => {
    const result = await subscriptionService.listForStaff(stubDb(['b1']), { branchId: 'not-active', page, limit, offset });
    expect(result.subscriptions).toEqual([]);
    expect(result.pagination).toEqual(expect.objectContaining({ total: 0 }));
  });

  test('GET /subscriptions/staff?branchId=<inactive branch> answers 200 with subscriptions: []', async () => {
    const { Branch } = dbHarness.tenant1.models;
    const listing = await GymListing.findOne({ where: { tenantId } });
    const inactive = await factories.createBranch(dbHarness.tenant1, listing.id, { name: 'Branch Closed' });
    await Branch.update({ status: 'INACTIVE' }, { where: { id: inactive.id } });
    const res = await get('/api/v1/subscriptions/staff', personas.owner.token, { branchId: inactive.id });
    expect(res.status).toBe(200);
    expect(res.body.data.subscriptions).toEqual([]);
    expect(res.body.pagination).toEqual(expect.objectContaining({ total: 0 }));
  });
});
