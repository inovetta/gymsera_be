/**
 * Phase 7 P6: traveller discovery (BUG-26, BUG-27, BUG-28, BUG-29, NEW-145).
 *
 * BUG-26: `/discovery/cities` listed every active city (21 of 30 on production with no
 * gym), and the snapshot never checked the subscription. A live gym (R-77) is: tenant
 * ACTIVE, subscription entitled (ACTIVE or GRACE), branch approved and visible, at least
 * one plan travellers can see. Only cities with a live gym are listed.
 * BUG-27: rating and review count come from approved reviews only; no review = count 0.
 * BUG-28: an organization card had only the organization's own cover (null for 23 of 28
 * on production) while its branches had photos.
 * BUG-29: "heist - heist": the title is the name once when organization and branch match,
 * otherwise "Organization · Branch".
 * NEW-145: every listing says which currency its price is in.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const cache = require('../../src/services/discovery-cache.service');
const { GymListing, City, GymReview, TenantSubscription, User } = require('../../src/models/platform');

const PHOTO_1 = 'https://cdn.example.test/branches/p6-1.jpg';
const PHOTO_2 = 'https://cdn.example.test/branches/p6-2.jpg';

describe('Phase 7 P6: traveller discovery', () => {
  let server; let h; let personas;
  let t1; let t2; // { tenantId, branch, gym, listing }
  let liveCity; let emptyCity; let otherCity;

  const get = async (path) => {
    const res = await request(server).get(`/api/v1/discovery${path}`);
    expect(res.status).toBe(200);
    return res.body.data;
  };
  const listed = async () => (await get('/gyms?page=1&limit=50')).gyms;
  const cityIds = async () => (await get('/cities')).cities.map((c) => c.id);
  const orgs = async () => (await get('/organizations?limit=50')).organizations;

  const makeVisible = async (tenantDb, tenantId, { cityId, gymName, branchName, imagesJson, currency }) => {
    const listing = await GymListing.findOne({ where: { tenantId } });
    await listing.update({ status: 'ACTIVE', cityId });
    const branch = await tenantDb.models.Branch.findOne({ where: { gymListingId: listing.id } });
    await branch.update({
      status: 'ACTIVE', travelerVisibilityStatus: 'active', adminSuspended: false,
      cityId, branchName, imagesJson, currency,
    });
    const gym = await tenantDb.models.Gym.findByPk(branch.gymId);
    await gym.update({ name: gymName, coverImageUrl: null, imagesJson: null, logoUrl: null, description: null });
    await tenantDb.models.MembershipPlan.create({
      gymId: gym.id, branchId: branch.id, name: 'Monthly', price: 2500,
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
    });
    return { tenantId, branch, gym, listing };
  };

  beforeAll(async () => {
    h = await setupTestDatabases();
    personas = await setupPersonas(h);
    server = await startTestServer();
    liveCity = await City.create({ name: 'P6 Live City', isActive: true });
    otherCity = await City.create({ name: 'P6 Other City', isActive: true });
    emptyCity = await City.create({ name: 'P6 Empty City', isActive: true });
    t1 = await makeVisible(h.tenant1, personas.owner.tenantId, {
      cityId: liveCity.id, gymName: 'Alpha Fitness Club', branchName: 'Downtown', imagesJson: [PHOTO_1, PHOTO_2], currency: 'USD',
    });
    t2 = await makeVisible(h.tenant2, personas.otherTenantOwner.tenantId, {
      cityId: otherCity.id, gymName: 'Beta Gym', branchName: ' beta  gym ', imagesJson: [], currency: 'PKR',
    });
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  beforeEach(() => cache._resetForTests());

  describe('BUG-26: only live gyms, only cities that have one', () => {
    afterEach(async () => {
      await TenantSubscription.update({ status: 'ACTIVE' }, { where: { tenantId: t2.tenantId } });
    });

    test('a city with no live gym is not listed; a city with one is, with its count', async () => {
      const { cities } = await get('/cities');
      const ids = cities.map((c) => c.id);
      expect(ids).not.toContain(emptyCity.id);
      expect(cities.find((c) => c.id === liveCity.id)).toMatchObject({ gymCount: 1 });
      expect(cities.every((c) => c.gymCount > 0)).toBe(true);
    });

    test('a tenant with no entitled subscription is not live: no branch, no city, no organization', async () => {
      expect((await listed()).map((g) => g.id)).toContain(t2.branch.id);
      expect(await cityIds()).toContain(otherCity.id);
      await TenantSubscription.update({ status: 'EXPIRED' }, { where: { tenantId: t2.tenantId } });
      // No wait for the TTL: a subscription write drops the snapshot.
      expect((await listed()).map((g) => g.id)).not.toContain(t2.branch.id);
      expect(await cityIds()).not.toContain(otherCity.id);
      expect((await orgs()).map((o) => o.tenantId)).not.toContain(t2.tenantId);
      const branches = await get(`/organizations/${t2.gym.id}/branches`).catch(() => null);
      expect(branches === null || branches.branches.length === 0).toBe(true);
    });

    test('a subscription in GRACE (pay later, failed renewal) is live', async () => {
      await TenantSubscription.update({ status: 'GRACE' }, { where: { tenantId: t2.tenantId } });
      expect((await listed()).map((g) => g.id)).toContain(t2.branch.id);
      expect(await cityIds()).toContain(otherCity.id);
    });

    test('an organization with no plan travellers can see is not listed', async () => {
      const { MembershipPlan } = h.tenant2.models;
      await MembershipPlan.update({ isPublic: false }, { where: { branchId: t2.branch.id } });
      try {
        expect((await orgs()).map((o) => o.tenantId)).not.toContain(t2.tenantId);
      } finally {
        await MembershipPlan.update({ isPublic: true }, { where: { branchId: t2.branch.id } });
      }
    });
  });

  describe('BUG-27: rating and count from approved reviews only', () => {
    let reviewer;
    beforeAll(async () => {
      reviewer = await User.findOne({ where: { email: 'owner@tenant2.test' } });
      await GymReview.create({ gymListingId: t1.listing.id, branchId: t1.branch.id, userId: reviewer.id, tenantId: t1.tenantId, rating: 4, title: 'ok', body: 'ok', status: 'APPROVED' });
      await GymReview.create({ gymListingId: t1.listing.id, branchId: t1.branch.id, userId: personas.member.user.id, tenantId: t1.tenantId, rating: 1, title: 'no', body: 'no', status: 'PENDING' });
    });

    test('list, detail and organization carry averageRating and reviewCount of approved reviews', async () => {
      const g1 = (await listed()).find((g) => g.id === t1.branch.id);
      expect(g1).toMatchObject({ averageRating: 4, reviewCount: 1 });
      const g2 = (await listed()).find((g) => g.id === t2.branch.id);
      expect(g2).toMatchObject({ averageRating: 0, reviewCount: 0 });

      const detail = await get(`/gyms/${t1.branch.id}`);
      expect(detail.gym).toMatchObject({ averageRating: 4, reviewCount: 1 });

      const o1 = (await orgs()).find((o) => o.tenantId === t1.tenantId);
      expect(o1).toMatchObject({ averageRating: 4, reviewCount: 1 });
    });

    test('top hosts carry the approved review count too', async () => {
      const res = await request(server).get('/api/v1/discovery/top-hosts');
      expect(res.status).toBe(200);
      const hosts = res.body.data.hosts || res.body.data;
      expect(hosts.find((x) => x.tenantId === t1.tenantId)).toMatchObject({ averageRating: 4, reviewCount: 1 });
      expect(hosts.find((x) => x.tenantId === t2.tenantId)).toMatchObject({ reviewCount: 0 });
    });
  });

  describe('BUG-28: photos', () => {
    test('a branch card uses its first gallery photo; none = null, never a stock photo', async () => {
      const gyms = await listed();
      expect(gyms.find((g) => g.id === t1.branch.id).coverImageUrl).toBe(PHOTO_1);
      expect(gyms.find((g) => g.id === t2.branch.id).coverImageUrl).toBeNull();
    });

    test('an organization without its own cover shows its first branch photo', async () => {
      const list = await orgs();
      expect(list.find((o) => o.tenantId === t1.tenantId).coverImageUrl).toBe(PHOTO_1);
      expect(list.find((o) => o.tenantId === t2.tenantId).coverImageUrl).toBeNull();
    });

    test('no invented tagline for an organization without a description', async () => {
      const o = (await orgs()).find((x) => x.tenantId === t1.tenantId);
      expect(o.tagline).toBeNull();
    });
  });

  describe('BUG-29: display name', () => {
    const { displayName } = require('../../src/services/discovery.service');

    test('the name once when organization and branch match, otherwise "Organization · Branch"', () => {
      expect(displayName('heist', 'heist')).toBe('heist');
      expect(displayName('Gold fitness', ' gold  FITNESS ')).toBe('Gold fitness');
      expect(displayName('king', 'iron')).toBe('king · iron');
      expect(displayName('king', '')).toBe('king');
      expect(displayName('', 'iron')).toBe('iron');
    });

    test('list, detail and organization branches use the rule', async () => {
      const gyms = await listed();
      expect(gyms.find((g) => g.id === t1.branch.id).title).toBe('Alpha Fitness Club · Downtown');
      expect(gyms.find((g) => g.id === t2.branch.id).title).toBe('Beta Gym');
      expect((await get(`/gyms/${t2.branch.id}`)).gym.title).toBe('Beta Gym');
      const { branches } = await get(`/organizations/${t1.gym.id}/branches`);
      expect(branches.map((b) => b.title)).toEqual(['Alpha Fitness Club · Downtown']);
    });
  });

  describe('NEW-145: currency', () => {
    test('each listing and the detail say which currency the price is in', async () => {
      const gyms = await listed();
      expect(gyms.find((g) => g.id === t1.branch.id)).toMatchObject({ minPrice: 2500, currency: 'USD' });
      expect(gyms.find((g) => g.id === t2.branch.id)).toMatchObject({ currency: 'PKR' });
      expect((await get(`/gyms/${t1.branch.id}`)).gym.currency).toBe('USD');
    });
  });
});
