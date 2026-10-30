/**
 * Phase 7 P8, owner decision R-78 (BUG-07): the host intro shows real numbers from the API.
 *
 * Before: Become a Host showed "12k+ active users", "98% growth rate" and "24/7 support
 * response", typed into the app (become_host_landing_screen.dart:326-397), and no endpoint
 * could give a real number. Now `GET /discovery/stats` (public, cached) answers counts the
 * platform can prove: gyms live for travellers (the R-77 snapshot every list uses), cities with
 * a live gym, and active user accounts (platform administrators and closed accounts excluded).
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { makeBranchLive, createUser } = require('../harness/factories');
const cache = require('../../src/services/discovery-cache.service');
const { City, GymListing, User } = require('../../src/models/platform');

describe('R-78: GET /discovery/stats', () => {
  let server; let ctx;

  const stats = async () => {
    const res = await request(server).get('/api/v1/discovery/stats');
    expect(res.status).toBe(200);
    return res.body.data;
  };

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    server = await startTestServer();
    ctx = require('../harness/personas').personaManager.context;
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  beforeEach(() => cache._resetForTests());

  test('no live gym: zero gyms and zero cities, never an invented number', async () => {
    const s = await stats();
    expect(s).toMatchObject({ liveGyms: 0, cities: 0 });
    expect(Number.isInteger(s.activeUsers)).toBe(true);
  });

  test('counts follow the data: a live branch adds a gym and its city', async () => {
    const city = await City.create({ name: 'R78 City', isActive: true });
    await GymListing.update({ status: 'ACTIVE', cityId: city.id }, { where: { id: ctx.listing1.id } });
    await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
    await ctx.tenant1Db.models.Branch.update({ cityId: city.id }, { where: { id: ctx.branch1.id } });
    await ctx.tenant1Db.models.MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'Monthly', price: 2000,
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
    });
    const s = await stats();
    expect(s.liveGyms).toBe(1);
    expect(s.cities).toBe(1);
  });

  test('active users: ACTIVE accounts, not administrators or closed accounts', async () => {
    const { Op } = require('sequelize');
    const expected = await User.count({ where: { status: 'ACTIVE', role: { [Op.ne]: 'PLATFORM_ADMIN' } } });
    expect((await stats()).activeUsers).toBe(expected);
    await createUser({ email: 'r78.closed@gymsera.test', role: 'MEMBER', status: 'DELETED' });
    await createUser({ email: 'r78.new@gymsera.test', role: 'MEMBER' });
    expect((await stats()).activeUsers).toBe(expected + 1);
  });

  test('public and cacheable, no personal data', async () => {
    const res = await request(server).get('/api/v1/discovery/stats');
    expect(res.headers['cache-control']).toMatch(/^public/);
    expect(Object.keys(res.body.data).sort()).toEqual(['activeUsers', 'cities', 'liveGyms']);
  });
});
