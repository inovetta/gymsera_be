/**
 * Phase 7 P10, NEW-179 (R-87): a Sandbox entitlement serves the host, never the public.
 *
 * Before: R-82 item 4 made Apple Sandbox (TestFlight, App Review) purchases verify on the
 * production server, and a Google license-tester purchase was always accepted. Both are stored
 * with `environment = 'SANDBOX'` (apple-billing.service.js, google-play-billing.service.js), and
 * the live-gym rule (R-77, discovery.service.js `_liveTenants`) read only the status, so anyone
 * with a TestFlight build could make a gym public without paying.
 *
 * Rule (R-87): an entitling SANDBOX row still entitles the host (host area, capacity, approval
 * flow), so store review and testers can use everything. A gym is live for travellers only with
 * an entitling row whose environment is PRODUCTION or none (manual grant, pay later, bank
 * transfer). A staging server opts in with SANDBOX_PURCHASES_GO_LIVE=true (default off).
 * why-not-live names the test purchase as the failing condition and agrees with discovery.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { createTenantSubscription } = require('../harness/factories');
const cache = require('../../src/services/discovery-cache.service');
const { isLiveForTravellers, assertBranchBookable } = require('../../src/services/discovery.service');
const { getActiveSubscription } = require('../../src/services/subscription-quota.service');
const { GymListing, City, TenantSubscription } = require('../../src/models/platform');
const { whyNotLive, formatReport } = require('../../src/scripts/why-not-live');

describe('NEW-179 (R-87): a Sandbox entitlement never makes a gym public', () => {
  let server; let h; let tenantId; let branch; let city;

  const listedIds = async () => {
    const res = await request(server).get('/api/v1/discovery/gyms?page=1&limit=50');
    expect(res.status).toBe(200);
    return res.body.data.gyms.map((g) => g.id);
  };
  const cityIds = async () => {
    const res = await request(server).get('/api/v1/discovery/cities');
    expect(res.status).toBe(200);
    return res.body.data.cities.map((c) => c.id);
  };
  const detailStatus = async () => (await request(server).get(`/api/v1/discovery/gyms/${branch.id}`)).status;
  const onlySubscription = async (fields) => {
    await TenantSubscription.destroy({ where: { tenantId } });
    return createTenantSubscription(tenantId, { branchCount: 10, ...fields });
  };
  const report = async () => {
    const reports = await whyNotLive(branch.id);
    expect(reports).toHaveLength(1);
    return reports[0];
  };
  const subscriptionCheck = (r) => r.checks.find((c) => c.name === 'subscription');

  beforeAll(async () => {
    h = await setupTestDatabases();
    const personas = await setupPersonas(h);
    server = await startTestServer();
    tenantId = personas.owner.tenantId;
    city = await City.create({ name: 'P10 Sandbox City', isActive: true });
    const listing = await GymListing.findOne({ where: { tenantId } });
    await listing.update({ status: 'ACTIVE', cityId: city.id });
    branch = await h.tenant1.models.Branch.findOne({ where: { gymListingId: listing.id } });
    await branch.update({
      status: 'ACTIVE', travelerVisibilityStatus: 'active', adminSuspended: false, pausedAt: null,
      billingLockedAt: null, cityId: city.id, branchName: 'Sandbox Test Branch',
    });
    await h.tenant1.models.MembershipPlan.create({
      gymId: branch.gymId, branchId: branch.id, name: 'Monthly', price: 2500,
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
    });
  });

  afterAll(async () => {
    delete process.env.SANDBOX_PURCHASES_GO_LIVE;
    await stopTestServer();
    await teardownTestDatabases();
  });

  beforeEach(() => {
    delete process.env.SANDBOX_PURCHASES_GO_LIVE;
    cache._resetForTests();
  });

  test.each([
    ['Apple Sandbox (TestFlight, App Review)', { platform: 'IOS', environment: 'SANDBOX' }],
    ['Google license tester', { platform: 'ANDROID', environment: 'SANDBOX' }],
  ])('%s: not listed, no city, detail 404, booking 409; why-not-live names it', async (_label, fields) => {
    await onlySubscription({ status: 'ACTIVE', ...fields });

    expect(await isLiveForTravellers(branch.id, { fresh: true })).toBe(false);
    expect(await listedIds()).not.toContain(branch.id);
    expect(await cityIds()).not.toContain(city.id);
    expect(await detailStatus()).toBe(404);
    await expect(assertBranchBookable(branch.id)).rejects.toMatchObject({ statusCode: 409, code: 'gym_not_bookable' });

    const r = await report();
    expect(r.live).toBe(false);
    expect(r.failing).toEqual(['subscription']);
    expect(subscriptionCheck(r).detail).toMatch(/test purchase \(Sandbox\)/);
    expect(formatReport(r)).toMatch(/FAIL\s+subscription: .*test purchase \(Sandbox\)/);
  });

  test('the host is still entitled by the Sandbox row (store review and testers can use the host flow)', async () => {
    const sandbox = await onlySubscription({ status: 'ACTIVE', platform: 'IOS', environment: 'SANDBOX' });
    const active = await getActiveSubscription(tenantId);
    expect(active && active.id).toBe(sandbox.id);
  });

  test.each([
    ['a PRODUCTION store purchase', { status: 'ACTIVE', platform: 'IOS', environment: 'PRODUCTION' }],
    ['a manual grant (no environment)', { status: 'ACTIVE', platform: 'MANUAL', environment: null }],
    ['pay later in grace (no environment)', { status: 'GRACE', platform: 'MANUAL', environment: null }],
  ])('%s: live, and why-not-live agrees', async (_label, fields) => {
    await onlySubscription(fields);
    expect(await isLiveForTravellers(branch.id, { fresh: true })).toBe(true);
    expect(await listedIds()).toContain(branch.id);
    expect(await detailStatus()).toBe(200);
    const r = await report();
    expect(r.live).toBe(true);
    expect(subscriptionCheck(r).status).toBe('PASS');
  });

  test('a Sandbox row next to a PRODUCTION one: live (the paid row counts)', async () => {
    await onlySubscription({ status: 'ACTIVE', platform: 'IOS', environment: 'PRODUCTION' });
    await createTenantSubscription(tenantId, { branchCount: 10, status: 'ACTIVE', platform: 'IOS', environment: 'SANDBOX' });
    expect(await isLiveForTravellers(branch.id, { fresh: true })).toBe(true);
    const r = await report();
    expect(r.live).toBe(true);
    expect(subscriptionCheck(r).detail).toMatch(/PRODUCTION/);
  });

  test('an ended PRODUCTION row next to an entitling Sandbox one: not live', async () => {
    await onlySubscription({ status: 'EXPIRED', platform: 'IOS', environment: 'PRODUCTION' });
    await createTenantSubscription(tenantId, { branchCount: 10, status: 'ACTIVE', platform: 'IOS', environment: 'SANDBOX' });
    expect(await isLiveForTravellers(branch.id, { fresh: true })).toBe(false);
    expect((await report()).failing).toEqual(['subscription']);
  });

  test('staging: SANDBOX_PURCHASES_GO_LIVE=true lets a Sandbox row go live, and why-not-live agrees', async () => {
    await onlySubscription({ status: 'ACTIVE', platform: 'IOS', environment: 'SANDBOX' });
    process.env.SANDBOX_PURCHASES_GO_LIVE = 'true';
    expect(await isLiveForTravellers(branch.id, { fresh: true })).toBe(true);
    const r = await report();
    expect(r.live).toBe(true);
    expect(subscriptionCheck(r).status).toBe('PASS');
  });

  test('any other value of SANDBOX_PURCHASES_GO_LIVE keeps the production rule', async () => {
    await onlySubscription({ status: 'ACTIVE', platform: 'IOS', environment: 'SANDBOX' });
    for (const v of ['1', 'yes', 'TRUE ', 'false', '']) {
      process.env.SANDBOX_PURCHASES_GO_LIVE = v;
      cache._resetForTests();
      expect(await isLiveForTravellers(branch.id, { fresh: true })).toBe(false);
    }
  });
});
