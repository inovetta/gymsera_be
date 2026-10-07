/**
 * NEW-44 (1) — GET /reports/dashboard and GET /reports/yearly are gated by
 * dashboard.revenue.view and add up only the branches the caller holds it at.
 *
 * Before: authorize('GYM_HOST','BRANCH_MANAGER') only. The legacy role shim gives any
 * team member the BRANCH_MANAGER role, so a Front Desk clerk with revenue switched
 * off got the whole tenant's takings.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam } = require('../harness/two-branch-team');

let app;
let team;
let personas;

beforeAll(async () => {
  const dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  team = await buildTwoBranchTeam(dbHarness, personas);
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const get = (path, token) =>
  request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', team.tenantId);

const thisMonth = () => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][new Date().getMonth()];
const monthRevenue = (res) => res.body.data.data.find((m) => m.month === thisMonth()).revenue;

describe('NEW-44: report routes require dashboard.revenue.view', () => {
  test.each(['/reports/dashboard', '/reports/yearly'])('Front Desk with revenue OFF gets 403 on %s', async (path) => {
    const res = await get(path, team.frontDeskOff.token);
    expect(res.status).toBe(403);
    expect(res.body.data?.revenue).toBeUndefined();
  });

  test('Front Desk with revenue ON at branch A sees only branch A (dashboard)', async () => {
    const res = await get('/reports/dashboard', team.frontDeskOn.token);
    expect(res.status).toBe(200);
    expect(res.body.data.revenue.allTime).toBe(1000);
    expect(res.body.data.revenue.thisMonth).toBe(1000);
    expect(res.body.data.branches.active).toBe(1);
  });

  test('Front Desk with revenue ON at branch A sees only branch A (yearly)', async () => {
    const res = await get('/reports/yearly', team.frontDeskOn.token);
    expect(res.status).toBe(200);
    expect(monthRevenue(res)).toBe(1000);
  });

  test('a Branch Manager of A sees only A on both routes', async () => {
    const dash = await get('/reports/dashboard', team.managerA.token);
    const year = await get('/reports/yearly', team.managerA.token);
    expect(dash.status).toBe(200);
    expect(dash.body.data.revenue.allTime).toBe(1000);
    expect(dash.body.data.branches.active).toBe(1);
    expect(year.status).toBe(200);
    expect(monthRevenue(year)).toBe(1000);
  });

  test('the filtered dashboard (?month=) is scoped the same way', async () => {
    const m = new Date().getMonth() + 1;
    const res = await get(`/reports/dashboard?year=${new Date().getFullYear()}&month=${m}`, team.managerA.token);
    expect(res.status).toBe(200);
    expect(res.body.data.periodRevenue).toBe(1000);
  });

  test('an Org Admin (organization-wide) sees both branches', async () => {
    const dash = await get('/reports/dashboard', team.orgAdmin.token);
    const year = await get('/reports/yearly', team.orgAdmin.token);
    expect(dash.body.data.revenue.allTime).toBe(8000);
    expect(dash.body.data.branches.active).toBe(2);
    expect(monthRevenue(year)).toBe(8000);
  });

  test('the owner sees everything, unchanged', async () => {
    const dash = await get('/reports/dashboard', team.ownerToken);
    const year = await get('/reports/yearly', team.ownerToken);
    expect(dash.status).toBe(200);
    expect(dash.body.data.revenue.allTime).toBe(8000);
    expect(dash.body.data.branches.active).toBe(2);
    expect(monthRevenue(year)).toBe(8000);
  });

  test('a platform admin is unchanged (still refused by the role guard)', async () => {
    const res = await get('/reports/yearly', personas.platformAdmin.token);
    expect(res.status).toBe(403);
  });
});
