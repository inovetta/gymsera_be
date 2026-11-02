/**
 * Phase 7 P9b, the backend half of two CMS items.
 *
 * R-80 / BUG-09 (item 2): GET /admin/tenants/:id/membership-plans returned plans without `currency`
 * (admin.service.js getTenantMembershipPlans skipped membership-plan.service#withCurrency), so the
 * CMS admin Plans tab could only print every plan as PKR.
 *
 * BUG-29 (item 5): GET /admin/reviews returned `gym: { id, title }` only (discovery.service.js
 * adminListReviews); a review is for a branch, so the CMS could not name the gym by the traveller
 * rule ("Organization · Branch", or the name once when they match). It now sends `gymTitle`, the
 * snapshot's displayName for a live branch, else the organization's title.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const discoveryCache = require('../../src/services/discovery-cache.service');

let h;
let personas;
let app;
let tenantId;
let adminToken;
let branch;
let listing;

beforeAll(async () => {
  h = await setupTestDatabases();
  personas = await setupPersonas(h);
  tenantId = personas.owner.tenantId;
  const admin = personas.platformAdmin.user;
  adminToken = signToken({ sub: admin.id, id: admin.id, email: admin.email, role: 'PLATFORM_ADMIN', isVerified: true });

  const { Branch, MembershipPlan } = h.tenant1.models;
  branch = await Branch.findOne({ where: { status: 'ACTIVE' }, order: [['createdAt', 'ASC']] });
  await branch.update({ currency: 'USD' });
  await MembershipPlan.create({
    gymId: branch.gymId || branch.id, branchId: branch.id, name: 'Quarter Pass', price: 99, priceMinor: 9900,
    durationType: 'QUARTERLY', durationValue: 1, isPublic: false, status: 'ACTIVE',
  });

  const { GymListing } = require('../../src/models/platform');
  listing = await GymListing.findOne({ where: { tenantId } });
  app = await startTestServer();
});

afterAll(async () => {
  jest.restoreAllMocks();
  await stopTestServer();
  await teardownTestDatabases();
});

const asAdmin = (path) => request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${adminToken}`);

describe('R-80: admin tenant plans carry their currency', () => {
  test('each plan has the currency of its branch', async () => {
    const res = await asAdmin(`/admin/tenants/${tenantId}/membership-plans`);
    expect(res.status).toBe(200);
    const plan = res.body.data.plans.find((p) => p.name === 'Quarter Pass');
    expect(plan).toBeDefined();
    expect(plan.currency).toBe('USD');
  });

  test('a non-admin cannot read them', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/tenants/${tenantId}/membership-plans`)
      .set('Authorization', `Bearer ${personas.owner.token}`);
    expect([401, 403]).toContain(res.status);
  });
});

describe('BUG-29: admin reviews name the gym by the traveller rule', () => {
  let liveReview;
  let hiddenReview;

  beforeAll(async () => {
    const { GymReview } = require('../../src/models/platform');
    const { createUser } = require('../harness/factories');
    const a = await createUser({ role: 'MEMBER', email: 'p9b.reviewer.a@gymsera.test', fullName: 'Reviewer A' });
    const b = await createUser({ role: 'MEMBER', email: 'p9b.reviewer.b@gymsera.test', fullName: 'Reviewer B' });
    liveReview = await GymReview.create({ gymListingId: listing.id, tenantId, userId: a.id, branchId: branch.id, rating: 5, status: 'PENDING' });
    hiddenReview = await GymReview.create({ gymListingId: listing.id, tenantId, userId: b.id, branchId: '99999999-9999-4999-8999-999999999999', rating: 4, status: 'PENDING' });
  });

  test('a review of a live branch gets the snapshot title (Organization · Branch)', async () => {
    jest.spyOn(discoveryCache, 'getSnapshot').mockResolvedValue([{ branchId: branch.id, title: 'Iron Gym · Uptown' }]);
    const res = await asAdmin('/admin/reviews');
    expect(res.status).toBe(200);
    const r = res.body.data.reviews.find((x) => x.id === liveReview.id);
    expect(r.gymTitle).toBe('Iron Gym · Uptown');
  });

  test('a review of a branch travellers cannot see falls back to the organization title', async () => {
    jest.spyOn(discoveryCache, 'getSnapshot').mockResolvedValue([]);
    const res = await asAdmin('/admin/reviews');
    const r = res.body.data.reviews.find((x) => x.id === hiddenReview.id);
    expect(r.gymTitle).toBe(listing.title);
  });

  test('a failed snapshot never fails the list', async () => {
    jest.spyOn(discoveryCache, 'getSnapshot').mockRejectedValue(new Error('db down'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await asAdmin('/admin/reviews');
    expect(res.status).toBe(200);
    expect(res.body.data.reviews.find((x) => x.id === liveReview.id).gymTitle).toBe(listing.title);
  });
});
