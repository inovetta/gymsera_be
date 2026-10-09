/**
 * NEW-56: GET /host/branches/:branchId/members/lookup also returns the member's ACTIVE,
 * check-in-valid subscriptions at that branch, so a team member with checkins.manual.create
 * but not subscriptions.view (403 on GET /subscriptions/staff) can still pick a subscription id.
 *
 * Validity is the one POST /attendance/manual uses (attendance.service _validateSubscription):
 * status ACTIVE, endDate not before today, remainingVisits null or > 0.
 *
 *  1. Manager of 3 branches gets the list at each.
 *  2. Manager of 1: own branch works (positive control), another branch is 403.
 *  3. Front Desk (members.view, subscriptions.view DENIED) gets the ids; /subscriptions/staff stays 403.
 *  4. Owner works. Member with no subscription gets []. Unknown email gets exists:false and [].
 *  5. Expired, zero-visit, frozen and other-branch subscriptions are left out.
 *  6. Each item carries only id, planName, endDate, remainingVisits.
 *  7. An id from the lookup is accepted by POST /attendance/manual.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { teamMember } = require('../harness/two-branch-team');
const { GymListing } = require('../../src/models/platform');

let app;
let dbHarness;
let personas;
let tenantId;
let branches; // { a, b, c }
let members; // letter -> { user, subscription } (one valid subscription each)
let mixed; // member at A with valid, expired, zero-visit, frozen and unlimited subscriptions
let bare; // member known to the platform, no subscription anywhere
let managerThree;
let managerOne;
let desk;

const LETTERS = ['a', 'b', 'c'];
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  app = await startTestServer();

  const tenantDb = dbHarness.tenant1;
  tenantId = personas.owner.tenantId;
  const { Branch, MembershipPlan, MemberSubscription } = tenantDb.models;

  const listing = await GymListing.findOne({ where: { tenantId } });
  const a = await Branch.findOne({ where: { gymListingId: listing.id } });
  const b = await factories.createBranch(tenantDb, listing.id, { name: 'Branch B' });
  const c = await factories.createBranch(tenantDb, listing.id, { name: 'Branch C' });
  branches = { a, b, c };

  const plans = {};
  for (const letter of LETTERS) {
    const br = branches[letter];
    plans[letter] = await MembershipPlan.create({
      gymId: br.gymId || br.id, branchId: br.id, name: `N56 Monthly ${letter}`, price: 5000, priceMinor: 500000,
      durationType: 'MONTHLY', durationValue: 1, isPublic: true, status: 'ACTIVE',
    });
  }

  let n = 0;
  const sub = (userId, letter, over = {}) => MemberSubscription.create({
    userId, branchId: branches[letter].id, membershipPlanId: plans[letter].id,
    startDate: day(-5), endDate: day(20), status: 'ACTIVE', qrCode: `GE-N56-${++n}`, ...over,
  });

  members = {};
  for (const letter of LETTERS) {
    const user = await factories.createUser({ email: `member-${letter}@new56.test`, fullName: `Member ${letter}`, role: 'MEMBER' });
    members[letter] = { user, subscription: await sub(user.id, letter) };
  }

  mixed = await factories.createUser({ email: 'mixed@new56.test', fullName: 'Mixed', role: 'MEMBER' });
  mixed.valid = await sub(mixed.id, 'a', { remainingVisits: 3 });
  mixed.unlimited = await sub(mixed.id, 'a', { remainingVisits: null });
  mixed.expired = await sub(mixed.id, 'a', { endDate: day(-1) });
  mixed.noVisits = await sub(mixed.id, 'a', { remainingVisits: 0 });
  mixed.frozen = await sub(mixed.id, 'a', { status: 'FROZEN' });
  mixed.elsewhere = await sub(mixed.id, 'b', { remainingVisits: 9 });

  bare = await factories.createUser({ email: 'bare@new56.test', fullName: 'Bare', role: 'MEMBER' });

  managerThree = await teamMember({
    tenantDb, tenantId, email: 'mgr-three@new56.test', roleKey: 'MANAGER', scopeType: 'BRANCH',
    branchIds: [a.id, b.id, c.id],
  });
  managerOne = await teamMember({
    tenantDb, tenantId, email: 'mgr-one@new56.test', roleKey: 'MANAGER', scopeType: 'BRANCH', branchIds: [a.id],
  });
  // Front Desk keeps members.view and checkins.manual.create but has subscriptions.view DENIED,
  // which is the reported case: GET /subscriptions/staff answers 403.
  desk = await teamMember({
    tenantDb, tenantId, email: 'desk@new56.test', roleKey: 'DESK', scopeType: 'BRANCH', branchIds: [a.id],
  });
  await tenantDb.models.AssignmentOverride.create({
    assignmentId: desk.assignment.id, permissionKey: 'subscriptions.view', effect: 'DENY', createdBy: desk.user.id,
  });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', tenantId);
const lookup = (token, letter, email) => authed(
  request(app).get(`/api/v1/host/branches/${branches[letter].id}/members/lookup`).query({ email }), token
);

describe('NEW-56 member lookup returns check-in subscriptions', () => {
  test.each(LETTERS)('manager of 3 branches gets the subscription at branch %s', async (letter) => {
    const res = await lookup(managerThree.token, letter, `member-${letter}@new56.test`);
    expect(res.status).toBe(200);
    expect(res.body.data.exists).toBe(true);
    expect(res.body.data.subscriptions).toHaveLength(1);
    expect(res.body.data.subscriptions[0].id).toBe(members[letter].subscription.id);
    expect(res.body.data.subscriptions[0].planName).toBe(`N56 Monthly ${letter}`);
  });

  test('manager of 1 works at own branch (positive control) and gets 403 at another', async () => {
    const own = await lookup(managerOne.token, 'a', 'member-a@new56.test');
    expect(own.status).toBe(200);
    expect(own.body.data.subscriptions[0].id).toBe(members.a.subscription.id);

    const other = await lookup(managerOne.token, 'b', 'member-b@new56.test');
    expect(other.status).toBe(403);
    expect(other.body.data).toBeUndefined();
  });

  test('Front Desk with members.view (subscriptions.view denied) gets subscription ids although /subscriptions/staff is 403', async () => {
    const staff = await authed(request(app).get('/api/v1/subscriptions/staff'), desk.token);
    expect(staff.status).toBe(403);

    const res = await lookup(desk.token, 'a', 'member-a@new56.test');
    expect(res.status).toBe(200);
    expect(res.body.data.subscriptions.map((s) => s.id)).toEqual([members.a.subscription.id]);
  });

  test('Front Desk is 403 at a branch they do not belong to', async () => {
    const res = await lookup(desk.token, 'b', 'member-b@new56.test');
    expect(res.status).toBe(403);
  });

  test('owner works at all branches', async () => {
    for (const letter of LETTERS) {
      const res = await lookup(personas.owner.token, letter, `member-${letter}@new56.test`);
      expect(res.status).toBe(200);
      expect(res.body.data.subscriptions[0].id).toBe(members[letter].subscription.id);
    }
  });

  test('only subscriptions POST /attendance/manual would accept are returned, at this branch only', async () => {
    const res = await lookup(managerOne.token, 'a', 'mixed@new56.test');
    expect(res.status).toBe(200);
    const ids = res.body.data.subscriptions.map((s) => s.id).sort();
    expect(ids).toEqual([mixed.valid.id, mixed.unlimited.id].sort());

    const byId = Object.fromEntries(res.body.data.subscriptions.map((s) => [s.id, s]));
    expect(byId[mixed.valid.id].remainingVisits).toBe(3);
    expect(byId[mixed.unlimited.id].remainingVisits).toBeNull();
    expect(byId[mixed.valid.id].endDate).toBe(day(20));
  });

  test('items carry only id, planName, endDate, remainingVisits (nothing financial)', async () => {
    const res = await lookup(managerOne.token, 'a', 'mixed@new56.test');
    for (const item of res.body.data.subscriptions) {
      expect(Object.keys(item).sort()).toEqual(['endDate', 'id', 'planName', 'remainingVisits']);
    }
  });

  test('member known to the platform with no subscription gets an empty list', async () => {
    const res = await lookup(managerOne.token, 'a', 'bare@new56.test');
    expect(res.status).toBe(200);
    expect(res.body.data.exists).toBe(false);
    expect(res.body.data.user.id).toBe(bare.id);
    expect(res.body.data.subscriptions).toEqual([]);
  });

  test('unknown email gets exists:false and an empty list', async () => {
    const res = await lookup(managerOne.token, 'a', 'nobody@new56.test');
    expect(res.status).toBe(200);
    expect(res.body.data.exists).toBe(false);
    expect(res.body.data.subscriptions).toEqual([]);
  });

  test('a subscription id from the lookup is accepted by POST /attendance/manual', async () => {
    const res = await lookup(managerOne.token, 'a', 'member-a@new56.test');
    const subscriptionId = res.body.data.subscriptions[0].id;
    const checkin = await authed(request(app).post('/api/v1/attendance/manual'), managerOne.token).send({
      userId: members.a.user.id, branchId: branches.a.id, subscriptionId,
    });
    expect(checkin.status).toBe(201);
  });
});
