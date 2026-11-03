/**
 * NEW-187 (P10 item 7): the host lists name the member's real plan, or say nothing.
 *
 * Before (host.controller.js getBranchDashboard recentCheckins, getBranchMembers,
 * getBranchCheckins): a check-in with no memberSubscriptionId (device / iClock events save
 * none when their lookup finds no ACTIVE subscription) was labelled "Daily Pass", a plan that
 * does not exist, and the app showed it. Each row also looked its subscription up one by one.
 *
 * Now: the plan of the check-in's subscription (a plan the host deleted keeps its name: plans
 * are soft-deleted); for a device check-in without one, the member's subscription at that branch
 * that covered the check-in day; otherwise null (the app shows "—"). Never "Daily Pass".
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { GymListing } = require('../../src/models/platform');

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

describe('NEW-187: host lists send the real plan name or null, never an invented one', () => {
  let app; let h; let personas; let branch; let plan; let goneplan;
  let withSub; let deviceCovered; let noPlanAtAll; let planGone;

  beforeAll(async () => {
    h = await setupTestDatabases();
    personas = await setupPersonas(h);
    app = await startTestServer();
    const { Branch, MembershipPlan, MemberSubscription, AttendanceLog } = h.tenant1.models;
    const listing = await GymListing.findOne({ where: { tenantId: personas.owner.tenantId } });
    branch = await Branch.findOne({ where: { gymListingId: listing.id } });
    plan = await MembershipPlan.create({
      gymId: branch.gymId, branchId: branch.id, name: 'Gold Monthly', price: 3000,
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
    });
    goneplan = await MembershipPlan.create({
      gymId: branch.gymId, branchId: branch.id, name: 'Retired Plan', price: 1000,
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
    });
    const member = (n) => factories.createUser({ email: `new187-${n}@gymsera.test`, fullName: `NEW187 ${n}`, role: 'MEMBER' });
    withSub = await member('a');
    deviceCovered = await member('b');
    noPlanAtAll = await member('c');
    planGone = await member('d');
    const subscribe = (user, planId) => MemberSubscription.create({
      userId: user.id, membershipPlanId: planId, branchId: branch.id, status: 'ACTIVE',
      startDate: day(-10), endDate: day(20), subscribedAt: new Date(),
    });
    const subA = await subscribe(withSub, plan.id);
    await subscribe(deviceCovered, plan.id);
    const subD = await subscribe(planGone, goneplan.id);
    await goneplan.update({ status: 'INACTIVE', isPublic: false }); // deleted by the host (soft)

    const checkIn = (user, memberSubscriptionId, minutesAgo, entryMethod = 'QR_SCAN') => AttendanceLog.create({
      branchId: branch.id, userId: user.id, memberSubscriptionId, attendanceType: 'CHECK_IN',
      checkInAt: new Date(Date.now() - minutesAgo * 60000), entryMethod,
    });
    await checkIn(withSub, subA.id, 4);
    await checkIn(deviceCovered, null, 3, 'DEVICE');
    await checkIn(noPlanAtAll, null, 2, 'DEVICE');
    await checkIn(planGone, subD.id, 1);
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  const get = async (path) => {
    const res = await request(app).get(`/api/v1/host/branches/${branch.id}${path}`)
      .set('Authorization', `Bearer ${personas.owner.token}`).set('X-Tenant-Id', personas.owner.tenantId);
    expect(res.status).toBe(200);
    return res.body.data;
  };
  const byUser = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r]));

  test('check-ins: the subscription plan, the covering plan for a device event, the kept name, else null', async () => {
    const { logs } = await get('/checkins?page=1&limit=20');
    const rows = byUser(logs, 'userName');
    expect(rows['NEW187 a'].planName).toBe('Gold Monthly');
    expect(rows['NEW187 b'].planName).toBe('Gold Monthly');
    expect(rows['NEW187 c'].planName).toBeNull();
    expect(rows['NEW187 d'].planName).toBe('Retired Plan');
    expect(JSON.stringify(logs)).not.toContain('Daily Pass');
  });

  test('dashboard recent check-ins: the same names (passType)', async () => {
    const { recentCheckins } = await get('/dashboard');
    const rows = byUser(recentCheckins, 'name');
    expect(rows['NEW187 a'].passType).toBe('Gold Monthly');
    expect(rows['NEW187 b'].passType).toBe('Gold Monthly');
    expect(rows['NEW187 c'].passType).toBeNull();
    expect(rows['NEW187 d'].passType).toBe('Retired Plan');
    expect(JSON.stringify(recentCheckins)).not.toContain('Daily Pass');
  });

  test('members: the plan name, also for a plan the host deleted', async () => {
    const { users } = await get('/members?page=1&limit=20');
    const rows = byUser(users, 'fullName');
    expect(rows['NEW187 a'].planName).toBe('Gold Monthly');
    expect(rows['NEW187 d'].planName).toBe('Retired Plan');
    expect(JSON.stringify(users)).not.toContain('Daily Pass');
  });
});
