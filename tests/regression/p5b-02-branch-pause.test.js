/**
 * P5b item 2 (R-81 revised) — pause and resume a branch.
 *
 * Pausing hides a branch from travellers and loses nothing: it stays ACTIVE, its members,
 * plans, staff and payments are untouched, and its review state (travelerVisibilityStatus)
 * is kept, so resuming shows it again exactly as it was. Always allowed, also when the
 * branch has members or money in progress (that is what a host does instead of deleting).
 * Who: whoever may change the branch's settings (branch.settings: owner, organization
 * admin, manager of that branch). Before: no pause existed; the app's "Pause this listing"
 * switch only changed a local variable.
 */
const { v4: uuidv4 } = require('uuid');
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const cache = require('../../src/services/discovery-cache.service');

let dbHarness;
let ctx;
let models;
let server;
let branch;
let member;

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  await setupPersonas(dbHarness);
  server = await startTestServer();
  ctx = require('../harness/personas').personaManager.context;
  models = dbHarness.tenant1.models;

  // The persona branch, live for travellers: a public plan and a paid-up member.
  branch = await models.Branch.findByPk(ctx.branch1.id);
  await branch.update({ status: 'ACTIVE', travelerVisibilityStatus: 'active', adminSuspended: false });
  const plan = await models.MembershipPlan.create({
    gymId: branch.gymId, branchId: branch.id, name: 'Public', price: 2500,
    durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
  });
  const user = await factories.createUser({ role: 'MEMBER', email: `m-${uuidv4().slice(0, 8)}@p5b.test` });
  member = await models.MemberSubscription.create({
    userId: user.id, branchId: branch.id, membershipPlanId: plan.id,
    startDate: '2026-01-01', endDate: '2099-01-01', status: 'ACTIVE', subscribedAt: new Date(),
  });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

beforeEach(() => cache._resetForTests());

const listedIds = async () => {
  const res = await request(server).get('/api/v1/discovery/gyms?page=1&limit=50');
  expect(res.status).toBe(200);
  const d = res.body.data;
  return (Array.isArray(d) ? d : d.branches || d.gyms || []).map((r) => r.id);
};

const reload = () => models.Branch.findByPk(ctx.branch1.id);

describe('P5b item 2: pause and resume', () => {
  test('the live branch is listed for travellers before the pause', async () => {
    expect(await listedIds()).toContain(ctx.branch1.id);
  });

  test('owner pauses a branch that has a paid-up member: 200, hidden from travellers, nothing else changes', async () => {
    const res = await asPersona('owner').post(`/host/branches/${ctx.branch1.id}/pause`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.branch.pausedAt).toBeTruthy();

    const b = await reload();
    expect(b.pausedAt).toBeTruthy();
    expect(b.status).toBe('ACTIVE');
    expect(b.travelerVisibilityStatus).toBe('active');
    expect((await models.MemberSubscription.findByPk(member.id)).status).toBe('ACTIVE');
    expect(await listedIds()).not.toContain(ctx.branch1.id);
  });

  test('pausing again is harmless (200, the first pause time is kept)', async () => {
    const before = (await reload()).pausedAt;
    const res = await asPersona('owner').post(`/host/branches/${ctx.branch1.id}/pause`, {});
    expect(res.status).toBe(200);
    expect((await reload()).pausedAt.getTime()).toBe(before.getTime());
  });

  test('resume shows it to travellers again, as it was', async () => {
    const res = await asPersona('owner').post(`/host/branches/${ctx.branch1.id}/resume`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.branch.pausedAt).toBeNull();
    const b = await reload();
    expect(b.pausedAt).toBeNull();
    expect(b.pausedBy).toBeNull();
    expect(b.travelerVisibilityStatus).toBe('active');
    expect(await listedIds()).toContain(ctx.branch1.id);
  });

  test('the branch manager of that branch may pause and resume it', async () => {
    const p = await asPersona('manager').post(`/host/branches/${ctx.branch1.id}/pause`, {});
    expect(p.status).toBe(200);
    const r = await asPersona('manager').post(`/host/branches/${ctx.branch1.id}/resume`, {});
    expect(r.status).toBe(200);
    expect((await reload()).pausedAt).toBeNull();
  });

  test.each([['frontDesk'], ['trainer'], ['cleaner']])('%s is refused (403), branch not paused', async (persona) => {
    const res = await asPersona(persona).post(`/host/branches/${ctx.branch1.id}/pause`, {});
    expect(res.status).toBe(403);
    expect((await reload()).pausedAt).toBeNull();
  });

  test('a traveller who is a member of this gym is refused (403), branch not paused', async () => {
    const { UserGymMembership } = require('../../src/models/platform');
    const { personaManager } = require('../harness/personas');
    await UserGymMembership.create({
      userId: personaManager.personas.member.user.id,
      tenantId: ctx.tenant1.id,
      gymListingId: ctx.listing1.id,
      subscriptionId: uuidv4(),
      gymName: 'Alpha Fitness Club',
      planName: 'Public',
      status: 'ACTIVE',
    });
    const res = await asPersona('member', { 'X-Tenant-Id': ctx.tenant1.id }).post(`/host/branches/${ctx.branch1.id}/pause`, {});
    expect(res.status).toBe(403);
    expect((await reload()).pausedAt).toBeNull();
  });

  test('another tenant\'s owner cannot reach it (404), branch not paused', async () => {
    const res = await asPersona('otherTenantOwner', { 'X-Tenant-Id': ctx.tenant1.id }).post(`/host/branches/${ctx.branch1.id}/pause`, {});
    expect(res.status).toBe(404);
    expect((await reload()).pausedAt).toBeNull();
  });

  test('a deleted branch cannot be paused (404)', async () => {
    const closed = await factories.createBranch(dbHarness.tenant1, ctx.listing1.id, { name: 'Closed', status: 'INACTIVE' });
    const res = await asPersona('owner').post(`/host/branches/${closed.id}/pause`, {});
    expect(res.status).toBe(404);
  });

  test('the routes take no body fields', async () => {
    const res = await asPersona('owner').post(`/host/branches/${ctx.branch1.id}/pause`, { travelerVisibilityStatus: 'active' });
    expect(res.status).toBe(200); // log mode: an unknown field is logged, never applied
    expect((await reload()).travelerVisibilityStatus).toBe('active');
    await asPersona('owner').post(`/host/branches/${ctx.branch1.id}/resume`, {});
  });
});
