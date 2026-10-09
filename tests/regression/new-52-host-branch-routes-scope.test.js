/**
 * NEW-52: branch scoping on the remaining /host/branches/:branchId/* routes
 * (members, announcements, schedule, resubmit-visibility, expenses) and GET /reports/branch/:branchId.
 *
 * Per route, with three branches A, B, C:
 *  1. Manager of all 3 works at each.
 *  2. Manager of 1 works at their own branch (positive control: the 2xx proves the 403s below
 *     are the branch check and not a wrong role gate) and gets 403 at B and C.
 *  3. A manager of A with the route's key DENIED gets 403 at A.
 *  4. An org-wide Gym Admin and the owner work at all 3.
 *
 * Expenses already check the branch inside the controller (hasExpenseAccess); they are here as
 * a lock so a later refactor cannot loosen them.
 *
 * Keys: members.view / members.create, announcements.view / .create (+ .publish for a sent post) /
 * .delete, schedule.view / schedule.class.create, branch.settings (resubmit-visibility),
 * dashboard.revenue.view (branch report), expenses.view / .create / .delete.
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
let plans; // letter -> plan
let announcementIds; // letter -> id
let expenseIds; // letter -> id
let categoryId;
let managerThree;
let managerOne;
let orgAdmin;
const denied = {}; // key -> token of a manager of A with that key DENIED
let desk; // Front Desk at A: announcements.create (Request), no announcements.publish
let seq = 0;

const LETTERS = ['a', 'b', 'c'];
const KEYS = [
  'members.view', 'members.create', 'announcements.view', 'announcements.create', 'announcements.delete',
  'schedule.view', 'schedule.class.create', 'branch.settings', 'dashboard.revenue.view',
  'expenses.view', 'expenses.create', 'expenses.delete',
];

const makeUser = async (email, roleKey, branchId, denyKey) => {
  const user = await factories.createUser({ email, role: 'MEMBER', fullName: email });
  const assignment = await factories.createRoleAssignment(
    { ...dbHarness.tenant1, tenantId },
    { userId: user.id, roleKey, scopeType: 'BRANCH', branchIds: [branchId], overrides: { tenantId } }
  );
  if (denyKey) {
    await dbHarness.tenant1.models.AssignmentOverride.create({
      assignmentId: assignment.id, permissionKey: denyKey, effect: 'DENY', createdBy: user.id,
    });
  }
  await membershipService.syncUserOrgIndex(tenantId, user.id, dbHarness.tenant1);
  return { token: signToken({ sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true, tenantId }) };
};

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  app = await startTestServer();

  const tenantDb = dbHarness.tenant1;
  tenantId = personas.owner.tenantId;
  const { Branch, MembershipPlan, ExpenseCategory } = tenantDb.models;

  const listing = await GymListing.findOne({ where: { tenantId } });
  const a = await Branch.findOne({ where: { gymListingId: listing.id } });
  const b = await factories.createBranch(tenantDb, listing.id, { name: 'Branch B' });
  const c = await factories.createBranch(tenantDb, listing.id, { name: 'Branch C' });
  branches = { a, b, c };

  plans = {};
  for (const letter of LETTERS) {
    const br = branches[letter];
    plans[letter] = await MembershipPlan.create({
      gymId: br.gymId || br.id, branchId: br.id, name: `N52 Monthly ${letter}`, price: 5000, priceMinor: 500000,
      durationType: 'MONTHLY', durationValue: 1, isPublic: true, status: 'ACTIVE',
    });
  }
  categoryId = (await ExpenseCategory.create({ name: 'N52 Rent' })).id;

  managerThree = await teamMember({
    tenantDb, tenantId, email: 'mgr-three@new52.test', roleKey: 'MANAGER', scopeType: 'BRANCH',
    branchIds: [a.id, b.id, c.id],
  });
  managerOne = await teamMember({
    tenantDb, tenantId, email: 'mgr-one@new52.test', roleKey: 'MANAGER', scopeType: 'BRANCH', branchIds: [a.id],
  });
  orgAdmin = await teamMember({
    tenantDb, tenantId, email: 'org-admin@new52.test', roleKey: 'ORG_ADMIN', scopeType: 'ORG',
  });
  for (const key of KEYS) {
    denied[key] = (await makeUser(`deny-${key.replace(/\./g, '-')}@new52.test`, 'MANAGER', a.id, key)).token;
  }
  desk = await makeUser('desk@new52.test', 'DESK', a.id, null);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

// Fresh rows per test so delete routes always have something to delete.
beforeEach(async () => {
  const { Announcement, Expense } = dbHarness.tenant1.models;
  await Announcement.destroy({ where: {} });
  await Expense.destroy({ where: {} });
  announcementIds = {};
  expenseIds = {};
  for (const letter of LETTERS) {
    announcementIds[letter] = (await Announcement.create({
      branchId: branches[letter].id, title: 'Existing', message: 'Existing', tag: 'SENT TO ALL MEMBERS', status: 'sent',
    })).id;
    expenseIds[letter] = (await Expense.create({
      branchId: branches[letter].id, categoryId, title: 'Existing', amount: 10, expenseDate: '2026-01-15',
      status: 'approved', createdBy: personas.owner.user.id,
    })).id;
  }
});

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', tenantId);
const base = (letter) => `/api/v1/host/branches/${branches[letter].id}`;

const ROUTES = [
  {
    name: 'GET members', key: 'members.view', ok: 200,
    call: (t, l) => authed(request(app).get(`${base(l)}/members`), t),
  },
  {
    name: 'GET members/lookup', key: 'members.view', ok: 200,
    call: (t, l) => authed(request(app).get(`${base(l)}/members/lookup`).query({ email: 'nobody@new52.test' }), t),
  },
  {
    name: 'POST members', key: 'members.create', ok: 201,
    call: (t, l) => authed(request(app).post(`${base(l)}/members`), t).send({
      email: `enrolled-${l}-${++seq}@new52.test`, fullName: 'Enrolled', planId: plans[l].id,
      startDate: new Date().toISOString().slice(0, 10), paymentMethod: 'cash',
    }),
    wrote: async (l) => dbHarness.tenant1.models.MemberSubscription.count({ where: { branchId: branches[l].id } }),
  },
  {
    name: 'GET announcements', key: 'announcements.view', ok: 200,
    call: (t, l) => authed(request(app).get(`${base(l)}/announcements`), t),
  },
  {
    name: 'POST announcements (draft)', key: 'announcements.create', ok: 200,
    call: (t, l) => authed(request(app).post(`${base(l)}/announcements`), t)
      .send({ title: 'Hello', message: 'World', status: 'draft' }),
    wrote: async (l) => dbHarness.tenant1.models.Announcement.count({ where: { branchId: branches[l].id } }),
  },
  {
    name: 'DELETE announcements/:id', key: 'announcements.delete', ok: 200,
    call: (t, l) => authed(request(app).delete(`${base(l)}/announcements/${announcementIds[l]}`), t),
    wrote: async (l) => dbHarness.tenant1.models.Announcement.count({ where: { branchId: branches[l].id } }),
  },
  {
    name: 'GET schedule', key: 'schedule.view', ok: 200,
    call: (t, l) => authed(request(app).get(`${base(l)}/schedule`), t),
  },
  {
    name: 'POST schedule', key: 'schedule.class.create', ok: 200,
    call: (t, l) => authed(request(app).post(`${base(l)}/schedule`), t)
      .send({ name: 'Yoga', instructor: 'Sam', time: '07:00', day: 'Monday', maxCapacity: 10 }),
    wrote: async (l) => dbHarness.tenant1.models.ClassSchedule.count({ where: { branchId: branches[l].id } }),
  },
  {
    name: 'PATCH resubmit-visibility', key: 'branch.settings', ok: 200,
    call: (t, l) => authed(request(app).patch(`${base(l)}/resubmit-visibility`), t),
    wrote: async (l) => dbHarness.tenant1.models.BranchVisibilityHistory.count({ where: { branchId: branches[l].id } }),
  },
  {
    name: 'GET reports/branch/:branchId', key: 'dashboard.revenue.view', ok: 200,
    call: (t, l) => authed(request(app).get(`/api/v1/reports/branch/${branches[l].id}`), t),
  },
  // Already checked inside expenses.controller (hasExpenseAccess); locked here.
  {
    name: 'GET expenses', key: 'expenses.view', ok: 200,
    call: (t, l) => authed(request(app).get(`${base(l)}/expenses`), t),
  },
  {
    name: 'GET expenses/summary', key: 'expenses.view', ok: 200,
    call: (t, l) => authed(request(app).get(`${base(l)}/expenses/summary`), t),
  },
  {
    name: 'GET expenses/:id', key: 'expenses.view', ok: 200,
    call: (t, l) => authed(request(app).get(`${base(l)}/expenses/${expenseIds[l]}`), t),
  },
  {
    name: 'POST expenses', key: 'expenses.create', ok: 201,
    call: (t, l) => authed(request(app).post(`${base(l)}/expenses`), t)
      .send({ categoryId, title: 'Mop', amount: 25, expenseDate: '2026-02-01' }),
    wrote: async (l) => dbHarness.tenant1.models.Expense.count({ where: { branchId: branches[l].id } }),
  },
  {
    name: 'PATCH expenses/:id', key: 'expenses.delete', ok: 200,
    call: (t, l) => authed(request(app).patch(`${base(l)}/expenses/${expenseIds[l]}`), t).send({ title: 'Renamed' }),
  },
  {
    name: 'DELETE expenses/:id', key: 'expenses.delete', ok: 200,
    call: (t, l) => authed(request(app).delete(`${base(l)}/expenses/${expenseIds[l]}`), t),
    wrote: async (l) => dbHarness.tenant1.models.Expense.count({ where: { branchId: branches[l].id } }),
  },
];

describe.each(ROUTES)('NEW-52: $name', (route) => {
  test.each(LETTERS)('manager of three branches works at branch %s', async (letter) => {
    const res = await route.call(managerThree.token, letter);
    expect(res.status).toBe(route.ok);
  });

  test('manager of one works at their own branch (positive control)', async () => {
    const res = await route.call(managerOne.token, 'a');
    expect(res.status).toBe(route.ok);
  });

  test.each(['b', 'c'])('manager of one gets 403 at branch %s and nothing changes', async (letter) => {
    const before = route.wrote ? await route.wrote(letter) : null;
    const res = await route.call(managerOne.token, letter);
    expect(res.status).toBe(403);
    if (route.wrote) expect(await route.wrote(letter)).toBe(before);
  });

  test(`a manager with ${route.key} DENIED gets 403 at their own branch`, async () => {
    const before = route.wrote ? await route.wrote('a') : null;
    const res = await route.call(denied[route.key], 'a');
    expect(res.status).toBe(403);
    if (route.wrote) expect(await route.wrote('a')).toBe(before);
  });

  test.each(LETTERS)('org-wide Gym Admin works at branch %s', async (letter) => {
    const res = await route.call(orgAdmin.token, letter);
    expect(res.status).toBe(route.ok);
  });

  test.each(LETTERS)('owner works at branch %s', async (letter) => {
    const res = await route.call(personas.owner.token, letter);
    expect(res.status).toBe(route.ok);
  });
});

describe('NEW-52: POST announcements — publishing needs announcements.publish', () => {
  const post = (token, letter, status) => authed(request(app).post(`${base(letter)}/announcements`), token)
    .send({ title: 'Hello', message: 'World', ...(status ? { status } : {}) });

  test('manager of one publishes (default status sent) at their own branch', async () => {
    expect((await post(managerOne.token, 'a')).status).toBe(200);
  });

  test('manager of one gets 403 publishing at another branch', async () => {
    expect((await post(managerOne.token, 'b')).status).toBe(403);
  });

  test('Front Desk (create on Request tier, no publish) can draft but not publish', async () => {
    expect((await post(desk.token, 'a', 'draft')).status).toBe(200);
    const res = await post(desk.token, 'a');
    expect(res.status).toBe(403);
    expect(res.body.message || res.body.error?.message).toMatch(/publish/i);
  });
});
