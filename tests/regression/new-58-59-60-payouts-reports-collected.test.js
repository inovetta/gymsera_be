/**
 * NEW-58, NEW-59, NEW-60 regression test suite.
 *
 * NEW-60: /reports/monthly, /reports/monthly/export-pdf, /reports/monthly/print-layout,
 *         and /reports/monthly/export require dashboard.revenue.view via can.atAnyBranch.
 *         Branch scoped via resolveBranchScope:
 *         - Manager of 3 branches works at each (?branchId=) and without branchId (scoped to the 3).
 *         - Manager of 1 branch gets 200 at their branch (positive control) and 403 at another branch.
 *         - User with dashboard.revenue.view OFF gets 403.
 *         - Owner works across all branches.
 *
 * NEW-59: /host/payouts/balance and /host/payouts require payouts.view (PERMISSIONS.md:171, orgOnly).
 *         - Owner works (200).
 *         - Manager / Front Desk / user without payouts.view gets 403.
 *
 * NEW-58: GET /payments?status=STAFF_COLLECTED accepted by validator and service.
 *         - Returns 200 with matching payment records.
 *         - Invalid status (e.g. status=INVALID) still rejected with 422 (validation not weakened).
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { teamMember } = require('../harness/two-branch-team');
const { GymListing } = require('../../src/models/platform');
const { PaymentStatus } = require('../../src/constants/payment-status');

let app;
let dbHarness;
let personas;
let tenantId;
let branches; // { a, b, c }
let managerThree;
let managerOne;
let frontDeskOff;
let orgAdmin;
let ownerToken;

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  app = await startTestServer();

  const tenantDb = dbHarness.tenant1;
  tenantId = personas.owner.tenantId;
  ownerToken = personas.owner.token;
  const { Branch } = tenantDb.models;

  const listing = await GymListing.findOne({ where: { tenantId } });
  const a = await Branch.findOne({ where: { gymListingId: listing.id } });
  const b = await factories.createBranch(tenantDb, listing.id, { name: 'Branch B' });
  const c = await factories.createBranch(tenantDb, listing.id, { name: 'Branch C' });
  branches = { a, b, c };

  const now = new Date();
  // Create payments at branches:
  // Branch A: COMPLETED 1000, STAFF_COLLECTED 500
  // Branch B: COMPLETED 2000
  // Branch C: COMPLETED 3000
  await factories.createPayment(tenantDb, a.id, { amount: 1000, status: PaymentStatus.COMPLETED, paidAt: now });
  await factories.createPayment(tenantDb, a.id, {
    amount: 500,
    status: PaymentStatus.STAFF_COLLECTED,
    staffCollectedBy: personas.owner.id,
    collectedAt: now,
  });
  await factories.createPayment(tenantDb, b.id, { amount: 2000, status: PaymentStatus.COMPLETED, paidAt: now });
  await factories.createPayment(tenantDb, c.id, { amount: 3000, status: PaymentStatus.COMPLETED, paidAt: now });

  // Manager of 3 branches (A, B, C)
  managerThree = await teamMember({
    tenantDb,
    tenantId,
    email: 'mgr-three@new585960.test',
    roleKey: 'MANAGER',
    scopeType: 'BRANCH',
    branchIds: [a.id, b.id, c.id],
  });

  // Manager of 1 branch (A only)
  managerOne = await teamMember({
    tenantDb,
    tenantId,
    email: 'mgr-one@new585960.test',
    roleKey: 'MANAGER',
    scopeType: 'BRANCH',
    branchIds: [a.id],
  });

  // Front Desk at A with revenue OFF (default DESK has revenue OFF)
  frontDeskOff = await teamMember({
    tenantDb,
    tenantId,
    email: 'fd-off@new585960.test',
    roleKey: 'DESK',
    scopeType: 'BRANCH',
    branchIds: [a.id],
  });

  // Org Admin (ORG scope) - no payouts.view by default
  orgAdmin = await teamMember({
    tenantDb,
    tenantId,
    email: 'org-admin@new585960.test',
    roleKey: 'ORG_ADMIN',
    scopeType: 'ORG',
    branchIds: [],
  });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const get = (path, token) =>
  request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', tenantId);

describe('NEW-60: monthly report and exports require dashboard.revenue.view and scope by branch', () => {
  const routes = [
    '/reports/monthly',
    '/reports/monthly/export-pdf',
    '/reports/monthly/print-layout',
    '/reports/monthly/export',
  ];

  test.each(routes)('key OFF gets 403 on %s', async (route) => {
    const res = await get(route, frontDeskOff.token);
    expect(res.status).toBe(403);
  });

  test.each(routes)('manager of 1 branch gets 200 at own branch (positive control) and 403 at another branch on %s', async (route) => {
    const sep = route.includes('?') ? '&' : '?';
    // Positive control: own branch works
    const resOwn = await get(`${route}${sep}branchId=${branches.a.id}`, managerOne.token);
    expect(resOwn.status).toBe(200);

    // Another branch: refused with 403
    const resOtherB = await get(`${route}${sep}branchId=${branches.b.id}`, managerOne.token);
    expect(resOtherB.status).toBe(403);

    const resOtherC = await get(`${route}${sep}branchId=${branches.c.id}`, managerOne.token);
    expect(resOtherC.status).toBe(403);
  });

  test.each(routes)('manager of 3 branches works on %s with and without branchId', async (route) => {
    const sep = route.includes('?') ? '&' : '?';
    // With branchId for each branch
    for (const letter of ['a', 'b', 'c']) {
      const res = await get(`${route}${sep}branchId=${branches[letter].id}`, managerThree.token);
      expect(res.status).toBe(200);
    }
    // Unscoped request works and aggregates permitted branches
    const resAll = await get(route, managerThree.token);
    expect(resAll.status).toBe(200);
  });

  test.each(routes)('owner works on %s with whole organization', async (route) => {
    const res = await get(route, ownerToken);
    expect(res.status).toBe(200);
  });

  test('GET /reports/monthly figures are scoped to permitted branches', async () => {
    // Manager 1 (Branch A only): sees only Branch A's 1000 revenue
    const resOne = await get('/reports/monthly', managerOne.token);
    expect(resOne.status).toBe(200);
    const revOne = resOne.body.data.revenueByDay.reduce((sum, r) => sum + parseFloat(r.totalRevenue || 0), 0);
    expect(revOne).toBe(1000);

    // Manager 3 (A, B, C): sees 1000 + 2000 + 3000 = 6000 revenue
    const resThree = await get('/reports/monthly', managerThree.token);
    expect(resThree.status).toBe(200);
    const revThree = resThree.body.data.revenueByDay.reduce((sum, r) => sum + parseFloat(r.totalRevenue || 0), 0);
    expect(revThree).toBe(6000);

    // Owner: sees 6000
    const resOwner = await get('/reports/monthly', ownerToken);
    expect(resOwner.status).toBe(200);
    const revOwner = resOwner.body.data.revenueByDay.reduce((sum, r) => sum + parseFloat(r.totalRevenue || 0), 0);
    expect(revOwner).toBe(6000);
  });
});

describe('NEW-59: payouts routes require payouts.view', () => {
  const payoutRoutes = [
    '/host/payouts/balance',
    '/host/payouts',
  ];

  test.each(payoutRoutes)('owner works on %s (positive control)', async (route) => {
    const res = await get(route, ownerToken);
    expect(res.status).toBe(200);
  });

  test.each(payoutRoutes)('manager without payouts.view gets 403 on %s', async (route) => {
    const res = await get(route, managerThree.token);
    expect(res.status).toBe(403);
  });

  test.each(payoutRoutes)('front desk without payouts.view gets 403 on %s', async (route) => {
    const res = await get(route, frontDeskOff.token);
    expect(res.status).toBe(403);
  });

  test.each(payoutRoutes)('org admin without payouts.view gets 403 on %s', async (route) => {
    const res = await get(route, orgAdmin.token);
    expect(res.status).toBe(403);
  });
});

describe('NEW-58: GET /payments list accepts status=STAFF_COLLECTED', () => {
  test('returns 200 and matches STAFF_COLLECTED payments', async () => {
    const res = await get(`/payments?branchId=${branches.a.id}&status=STAFF_COLLECTED`, ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.data.payments.length).toBeGreaterThan(0);
    for (const p of res.body.data.payments) {
      expect(p.status).toBe('STAFF_COLLECTED');
    }
  });

  test('manager of branch A can filter status=STAFF_COLLECTED', async () => {
    const res = await get(`/payments?branchId=${branches.a.id}&status=STAFF_COLLECTED`, managerOne.token);
    expect(res.status).toBe(200);
    expect(res.body.data.payments.length).toBeGreaterThan(0);
    for (const p of res.body.data.payments) {
      expect(p.status).toBe('STAFF_COLLECTED');
    }
  });

  test('invalid status is still rejected with 422 (validation integrity preserved)', async () => {
    const res = await get(`/payments?branchId=${branches.a.id}&status=INVALID_STATUS`, ownerToken);
    expect(res.status).toBe(422);
  });
});
