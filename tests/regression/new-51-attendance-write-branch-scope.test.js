/**
 * NEW-51: branch scoping on the attendance WRITE routes, GET /reports/weekly-attendance,
 * and the two host.controller attendance reads that carried no branch guard.
 *
 * Write routes: POST /attendance/qr-scan, /manual, /check-in and PATCH /attendance/:id/check-out.
 * Per route, with three branches A, B, C and one member subscribed at each:
 *  1. Manager of all 3 records at each of the 3.
 *  2. Manager of 1 records at their own branch (positive control) and gets 403 at another.
 *  3. Front Desk with the key on records at their own branch only.
 *  4. A role with the key DENIED gets 403 (and a Front Desk without the override succeeds,
 *     so the 403 is the permission and not the role gate).
 *  5. The owner records at all 3.
 *
 * Keys: qr-scan and check-out -> checkins.qr.scan; manual and check-in -> checkins.manual.create.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { teamMember } = require('../harness/two-branch-team');
const { GymListing } = require('../../src/models/platform');
const { signToken } = require('../../src/utils/jwt.utils');
const membershipService = require('../../src/services/membership.service');
const { generateAttendanceQrToken, _clearInMemoryNonces } = require('../../src/utils/qr.utils');

let app;
let dbHarness;
let personas;
let tenantId;
let branches; // { a, b, c }
let subs; // letter -> { user, subscription }
let logIds; // letter -> an open attendance log id (for check-out)
let managerThree;
let managerOne;
let deskOn;
let deskNoQr; // Front Desk, checkins.qr.scan DENIED
let deskNoManual; // Front Desk, checkins.manual.create DENIED
let trainerOn;

const LETTERS = ['a', 'b', 'c'];

const makeDesk = async (tenantDb, email, branchId, denyKey, roleKey = 'DESK') => {
  const user = await factories.createUser({ email, role: 'MEMBER', fullName: email });
  const assignment = await factories.createRoleAssignment(
    { ...tenantDb, tenantId },
    { userId: user.id, roleKey, scopeType: 'BRANCH', branchIds: [branchId], overrides: { tenantId } }
  );
  if (denyKey) {
    await tenantDb.models.AssignmentOverride.create({
      assignmentId: assignment.id, permissionKey: denyKey, effect: 'DENY', createdBy: user.id,
    });
  }
  await membershipService.syncUserOrgIndex(tenantId, user.id, tenantDb);
  return { token: signToken({ sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true, tenantId }) };
};

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

  const plan = await MembershipPlan.create({
    gymId: a.gymId || a.id, branchId: a.id, name: 'N51 Monthly', price: 5000, priceMinor: 500000,
    durationType: 'MONTHLY', durationValue: 1, isPublic: true, status: 'ACTIVE',
  });

  const start = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  subs = {};
  for (const letter of LETTERS) {
    const user = await factories.createUser({ email: `member-${letter}@new51.test`, fullName: `Member ${letter}`, role: 'MEMBER' });
    const subscription = await MemberSubscription.create({
      userId: user.id, branchId: branches[letter].id, membershipPlanId: plan.id,
      startDate: start, endDate: end, status: 'ACTIVE', qrCode: `GE-N51-${letter}`,
    });
    subs[letter] = { user, subscription };
  }

  managerThree = await teamMember({
    tenantDb, tenantId, email: 'mgr-three@new51.test', roleKey: 'MANAGER', scopeType: 'BRANCH',
    branchIds: [a.id, b.id, c.id],
  });
  managerOne = await teamMember({
    tenantDb, tenantId, email: 'mgr-one@new51.test', roleKey: 'MANAGER', scopeType: 'BRANCH',
    branchIds: [a.id],
  });
  deskOn = await makeDesk(tenantDb, 'fd-on@new51.test', a.id, null);
  deskNoQr = await makeDesk(tenantDb, 'fd-noqr@new51.test', a.id, 'checkins.qr.scan');
  deskNoManual = await makeDesk(tenantDb, 'fd-nomanual@new51.test', a.id, 'checkins.manual.create');
  trainerOn = await makeDesk(tenantDb, 'trainer@new51.test', a.id, null, 'TRAINER');
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

// Fresh state per test: no duplicate-window hits, one open log per branch, QR replay cache empty.
beforeEach(async () => {
  _clearInMemoryNonces();
  const { AttendanceLog } = dbHarness.tenant1.models;
  await AttendanceLog.destroy({ where: {} });
  logIds = {};
  for (const letter of LETTERS) {
    const log = await AttendanceLog.create({
      branchId: branches[letter].id, userId: subs[letter].user.id,
      memberSubscriptionId: subs[letter].subscription.id,
      attendanceType: 'CHECK_IN', checkInAt: new Date(), entryMethod: 'MANUAL',
    });
    logIds[letter] = log.id;
  }
});

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', tenantId);

// Each route: how to record at branch `letter`, the success status, and the key it needs.
const ROUTES = [
  {
    name: 'POST /attendance/qr-scan', key: 'checkins.qr.scan', ok: 201,
    call: (token, letter) => {
      // qr-scan rejects a duplicate within the window, so the open log from beforeEach is cleared first.
      const { user, subscription } = subs[letter];
      const qrCode = generateAttendanceQrToken({
        subscriptionId: subscription.id, userId: user.id, tenantId, branchId: branches[letter].id,
      });
      return authed(request(app).post('/api/v1/attendance/qr-scan'), token)
        .send({ qrCode, branchId: branches[letter].id });
    },
    clearLogs: true,
    deskOffToken: () => deskNoQr.token,
  },
  {
    name: 'POST /attendance/manual', key: 'checkins.manual.create', ok: 201,
    call: (token, letter) => authed(request(app).post('/api/v1/attendance/manual'), token).send({
      userId: subs[letter].user.id, branchId: branches[letter].id, subscriptionId: subs[letter].subscription.id,
    }),
    deskOffToken: () => deskNoManual.token,
  },
  {
    name: 'POST /attendance/check-in', key: 'checkins.manual.create', ok: 201,
    call: (token, letter) => authed(request(app).post('/api/v1/attendance/check-in'), token).send({
      userId: subs[letter].user.id, branchId: branches[letter].id, subscriptionId: subs[letter].subscription.id,
    }),
    deskOffToken: () => deskNoManual.token,
  },
  {
    name: 'PATCH /attendance/:id/check-out', key: 'checkins.qr.scan', ok: 200,
    call: (token, letter) => authed(request(app).patch(`/api/v1/attendance/${logIds[letter]}/check-out`), token),
    deskOffToken: () => deskNoQr.token,
  },
];

describe.each(ROUTES)('NEW-51: $name', (route) => {
  const run = async (token, letter) => {
    if (route.clearLogs) await dbHarness.tenant1.models.AttendanceLog.destroy({ where: {} });
    return route.call(token, letter);
  };

  test.each(LETTERS)('manager of three branches records at branch %s', async (letter) => {
    const res = await run(managerThree.token, letter);
    expect(res.status).toBe(route.ok);
  });

  test('manager of one records at their own branch (positive control)', async () => {
    const res = await run(managerOne.token, 'a');
    expect(res.status).toBe(route.ok);
  });

  test.each(['b', 'c'])('manager of one gets 403 at branch %s, and nothing is written', async (letter) => {
    const { AttendanceLog } = dbHarness.tenant1.models;
    const before = await AttendanceLog.count();
    const res = await run(managerOne.token, letter);
    expect(res.status).toBe(403);
    expect(res.body.message || res.body.error?.message).toMatch(/permission/i);
    // check-out must not have closed the other branch's log either
    if (route.name.startsWith('PATCH')) {
      const log = await AttendanceLog.findByPk(logIds[letter]);
      expect(log.checkOutAt).toBeNull();
    } else {
      expect(await AttendanceLog.count()).toBe(route.clearLogs ? 0 : before);
    }
  });

  test('Front Desk with the key on records at their own branch', async () => {
    const res = await run(deskOn.token, 'a');
    expect(res.status).toBe(route.ok);
  });

  test.each(['b', 'c'])('Front Desk with the key on gets 403 at branch %s', async (letter) => {
    const res = await run(deskOn.token, letter);
    expect(res.status).toBe(403);
    expect(res.body.message || res.body.error?.message).toMatch(/permission/i);
  });

  test('Front Desk with the key DENIED gets 403 at their own branch', async () => {
    const res = await run(route.deskOffToken(), 'a');
    expect(res.status).toBe(403);
    expect(res.body.message || res.body.error?.message).toMatch(/permission/i);
  });

  test.each(LETTERS)('owner records at branch %s', async (letter) => {
    const res = await run(personas.owner.token, letter);
    expect(res.status).toBe(route.ok);
  });
});

describe('NEW-51: role without the key at all', () => {
  test('Trainer (no checkins.manual.create) gets 403 on manual at own branch, while qr-scan works', async () => {
    const manual = await ROUTES[1].call(trainerOn.token, 'a');
    expect(manual.status).toBe(403);
    expect(manual.body.message || manual.body.error?.message).toMatch(/permission/i);
    await dbHarness.tenant1.models.AttendanceLog.destroy({ where: {} });
    const qr = await ROUTES[0].call(trainerOn.token, 'a');
    expect(qr.status).toBe(201);
  });
});

describe('NEW-51: check-out of an unknown log', () => {
  test('owner gets 404 for a log that does not exist', async () => {
    const res = await authed(
      request(app).patch('/api/v1/attendance/00000000-0000-4000-8000-000000000000/check-out'),
      personas.owner.token
    );
    expect(res.status).toBe(404);
  });

  test('manager of one gets 404 (not a 500) for a log that does not exist', async () => {
    const res = await authed(
      request(app).patch('/api/v1/attendance/00000000-0000-4000-8000-000000000000/check-out'),
      managerOne.token
    );
    expect(res.status).toBe(404);
  });
});

// ── GET /reports/weekly-attendance ─────────────────────────────────────────────
describe('NEW-51: GET /reports/weekly-attendance', () => {
  const total = (body) => body.data.data.reduce((n, d) => n + d.count, 0);
  const get = (token, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return authed(request(app).get(`/api/v1/reports/weekly-attendance${qs ? `?${qs}` : ''}`), token);
  };

  // beforeEach seeds one CHECK_IN per branch; add 2 more at B and 4 more at C -> 1 / 3 / 5.
  beforeEach(async () => {
    const { AttendanceLog } = dbHarness.tenant1.models;
    const extra = { b: 2, c: 4 };
    for (const [letter, n] of Object.entries(extra)) {
      for (let i = 0; i < n; i += 1) {
        await AttendanceLog.create({
          branchId: branches[letter].id, userId: subs[letter].user.id, attendanceType: 'CHECK_IN',
          checkInAt: new Date(), entryMethod: 'MANUAL',
        });
      }
    }
  });

  test('manager of three branches sees all three (1+3+5)', async () => {
    const res = await get(managerThree.token);
    expect(res.status).toBe(200);
    expect(total(res.body)).toBe(9);
  });

  test('manager of one sees only their branch', async () => {
    const res = await get(managerOne.token);
    expect(res.status).toBe(200);
    expect(total(res.body)).toBe(1);
  });

  test('manager of one can filter to their own branch', async () => {
    const res = await get(managerOne.token, { branchId: branches.a.id });
    expect(res.status).toBe(200);
    expect(total(res.body)).toBe(1);
  });

  test('manager of one requesting a branch they lack gets 403', async () => {
    const res = await get(managerOne.token, { branchId: branches.c.id });
    expect(res.status).toBe(403);
  });

  test('manager of three can filter to one branch they hold', async () => {
    const res = await get(managerThree.token, { branchId: branches.c.id });
    expect(res.status).toBe(200);
    expect(total(res.body)).toBe(5);
  });

  test('Front Desk with checkins.view on sees only their branch (positive control)', async () => {
    const res = await get(deskOn.token);
    expect(res.status).toBe(200);
    expect(total(res.body)).toBe(1);
  });

  test('Front Desk with checkins.view DENIED gets 403', async () => {
    const tenantDb = dbHarness.tenant1;
    const denied = await makeDesk(tenantDb, 'fd-noview@new51.test', branches.a.id, 'checkins.view');
    const res = await get(denied.token);
    expect(res.status).toBe(403);
  });

  test('owner sees all three, or filters to one', async () => {
    const all = await get(personas.owner.token);
    expect(all.status).toBe(200);
    expect(total(all.body)).toBe(9);
    const one = await get(personas.owner.token, { branchId: branches.b.id });
    expect(one.status).toBe(200);
    expect(total(one.body)).toBe(3);
  });
});

// ── host.controller attendance reads ───────────────────────────────────────────
describe.each([
  { name: 'GET /host/branches/:branchId/checkins', path: (id) => `/api/v1/host/branches/${id}/checkins` },
  { name: 'GET /host/branches/:branchId/dashboard', path: (id) => `/api/v1/host/branches/${id}/dashboard` },
])('NEW-51: $name', ({ path }) => {
  const get = (token, id) => authed(request(app).get(path(id)), token);

  test('manager of one reads their own branch (positive control)', async () => {
    const res = await get(managerOne.token, branches.a.id);
    expect(res.status).toBe(200);
  });

  test('manager of one gets 403 for another branch', async () => {
    const res = await get(managerOne.token, branches.b.id);
    expect(res.status).toBe(403);
  });

  test('manager of three reads each of their branches', async () => {
    for (const letter of LETTERS) {
      const res = await get(managerThree.token, branches[letter].id);
      expect(res.status).toBe(200);
    }
  });

  test('owner reads every branch', async () => {
    for (const letter of LETTERS) {
      const res = await get(personas.owner.token, branches[letter].id);
      expect(res.status).toBe(200);
    }
  });
});
