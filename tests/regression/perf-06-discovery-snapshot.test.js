/**
 * PERF-06 / API-04: discovery reads share one TTL snapshot of every visible
 * branch instead of opening every tenant database per request, and the
 * snapshot is dropped immediately when a branch / listing / tenant stops
 * being visible.
 */
const { Sequelize } = require('sequelize');
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const cache = require('../../src/services/discovery-cache.service');
const { GymListing, Tenant } = require('../../src/models/platform');

let queryCount = 0;
const origQuery = Sequelize.prototype.query;

describe('PERF-06: discovery snapshot cache', () => {
  let server; let h; let personas; let branch; let listing; let tenantId;

  const listIds = async () => {
    const res = await request(server).get('/api/v1/discovery/gyms?page=1&limit=50');
    expect(res.status).toBe(200);
    const d = res.body.data;
    const rows = Array.isArray(d) ? d : (d.branches || d.gyms || []);
    return rows.map((r) => r.id);
  };

  beforeAll(async () => {
    h = await setupTestDatabases();
    personas = await setupPersonas(h);
    server = await startTestServer();
    tenantId = personas.owner.tenantId;
    listing = await GymListing.findOne({ where: { tenantId } });
    await listing.update({ status: 'ACTIVE' });
    branch = await h.tenant1.models.Branch.findOne({ where: { gymListingId: listing.id } });
    await branch.update({ status: 'ACTIVE', travelerVisibilityStatus: 'active', adminSuspended: false });
    const MembershipPlan = h.tenant1.models.MembershipPlan;
    await MembershipPlan.create({
      gymId: branch.gymId, branchId: branch.id, name: 'Public', price: 2500,
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
    });
    Sequelize.prototype.query = async function counted(...a) { queryCount += 1; return origQuery.apply(this, a); };
  });

  afterAll(async () => {
    Sequelize.prototype.query = origQuery;
    await stopTestServer();
    await teardownTestDatabases();
  });

  beforeEach(() => cache._resetForTests());

  test('the branch is listed, and a repeat read touches no database for the branch scan', async () => {
    expect(await listIds()).toContain(branch.id);
    queryCount = 0;
    const res = await request(server).get('/api/v1/discovery/gyms?page=1&limit=50');
    expect(res.status).toBe(200);
    expect(queryCount).toBe(0);
    expect(cache.getStats().hits).toBeGreaterThan(0);
  });

  test('organizations and an organization\'s branches are memoized and rebuilt after a write', async () => {
    const orgs = await request(server).get('/api/v1/discovery/organizations');
    expect(orgs.status).toBe(200);
    queryCount = 0;
    const again = await request(server).get('/api/v1/discovery/organizations');
    expect(again.status).toBe(200);
    expect(queryCount).toBe(0);
    expect(again.body.data).toEqual(orgs.body.data);

    await branch.update({ tagline: 'changed' }); // any write to a watched model
    queryCount = 0;
    await request(server).get('/api/v1/discovery/organizations');
    expect(queryCount).toBeGreaterThan(0);
  });

  test('an organizations list built while a tenant was unreachable is kept only 10 s', async () => {
    const { factories } = require('../harness');
    const broken = await factories.createTenant({ gymName: 'Broken DB', connectionStringEncrypted: 'not-decryptable' });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout'], now: Date.now() });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const first = await request(server).get('/api/v1/discovery/organizations?limit=11');
      expect(first.status).toBe(200);
      queryCount = 0;
      await request(server).get('/api/v1/discovery/organizations?limit=11');
      expect(queryCount).toBe(0); // within 10 s: served from the memo
      jest.setSystemTime(Date.now() + 11000);
      queryCount = 0;
      await request(server).get('/api/v1/discovery/organizations?limit=11');
      expect(queryCount).toBeGreaterThan(0); // after 10 s: rebuilt, not held for 60 s
    } finally {
      errSpy.mockRestore();
      jest.useRealTimers();
      await Tenant.destroy({ where: { id: broken.id } });
    }
  });

  test('concurrent first requests share a single build', async () => {
    await Promise.all(Array.from({ length: 6 }, () => request(server).get('/api/v1/discovery/cities')));
    expect(cache.getStats().builds).toBe(1);
  });

  test('one snapshot serves gyms, cities, featured, map, top-rated and nearby', async () => {
    for (const p of ['/discovery/gyms', '/discovery/cities', '/discovery/gyms/featured', '/discovery/gyms/map',
      '/discovery/gyms/top-rated', '/discovery/gyms/nearby?lat=24.8&lng=67.0&radiusKm=50000']) {
      const r = await request(server).get(`/api/v1${p}`);
      expect(r.status).toBe(200);
    }
    expect(cache.getStats().builds).toBe(1);
  });

  describe('immediate invalidation', () => {
    afterEach(async () => {
      await branch.reload();
      await branch.update({ status: 'ACTIVE', travelerVisibilityStatus: 'active', adminSuspended: false });
      await listing.update({ status: 'ACTIVE' });
      await Tenant.update({ status: 'ACTIVE' }, { where: { id: tenantId } });
    });

    test('branch hidden from travelers disappears on the very next read', async () => {
      expect(await listIds()).toContain(branch.id);
      await branch.update({ travelerVisibilityStatus: 'deactivated' });
      expect(await listIds()).not.toContain(branch.id);
    });

    test('branch suspended by an admin (bulk update) disappears on the very next read', async () => {
      expect(await listIds()).toContain(branch.id);
      await h.tenant1.models.Branch.update({ adminSuspended: true }, { where: { id: branch.id } });
      expect(await listIds()).not.toContain(branch.id);
    });

    test('branch deleted (INACTIVE) disappears on the very next read', async () => {
      expect(await listIds()).toContain(branch.id);
      await branch.update({ status: 'INACTIVE' });
      expect(await listIds()).not.toContain(branch.id);
    });

    test('suspended tenant disappears on the very next read', async () => {
      expect(await listIds()).toContain(branch.id);
      await Tenant.update({ status: 'SUSPENDED' }, { where: { id: tenantId } });
      expect(await listIds()).not.toContain(branch.id);
    });

    test('a write inside a transaction invalidates again after commit', async () => {
      expect(await listIds()).toContain(branch.id);
      const tx = await h.tenant1.sequelize.transaction();
      await h.tenant1.models.Branch.update({ travelerVisibilityStatus: 'deactivated' }, { where: { id: branch.id }, transaction: tx });
      // A rebuild while the write is uncommitted caches the old state...
      expect(await listIds()).toContain(branch.id);
      await tx.commit();
      // ...which the commit must drop.
      expect(await listIds()).not.toContain(branch.id);
    });
  });

  describe('snapshot rules (unit)', () => {
    const mk = (id) => ({ id });

    test('a build that was in flight when invalidate() ran is not stored', async () => {
      let release;
      const gate = new Promise((r) => { release = r; });
      const slow = cache.getSnapshot(async () => { await gate; return { branches: [mk('old')], complete: true }; });
      cache.invalidate();
      release();
      await slow;
      let calls = 0;
      const next = await cache.getSnapshot(async () => { calls += 1; return { branches: [mk('new')], complete: true }; });
      expect(calls).toBe(1);
      expect(next.map((b) => b.id)).toEqual(['new']);
    });

    test('fresh: true never returns a cached value', async () => {
      await cache.getSnapshot(async () => ({ branches: [mk('a')], complete: true }));
      const fresh = await cache.getSnapshot(async () => ({ branches: [mk('b')], complete: true }), { fresh: true });
      expect(fresh.map((b) => b.id)).toEqual(['b']);
    });

    test('an incomplete snapshot is kept only briefly', async () => {
      process.env.DISCOVERY_SNAPSHOT_TTL_MS = '60000';
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'], now: Date.now() });
      try {
        await cache.getSnapshot(async () => ({ branches: [mk('partial')], complete: false }));
        let calls = 0;
        const build = async () => { calls += 1; return { branches: [mk('full')], complete: true }; };
        await cache.getSnapshot(build);
        expect(calls).toBe(0); // within 10 s: reused
        jest.setSystemTime(Date.now() + 11000);
        await cache.getSnapshot(build);
        expect(calls).toBe(1); // after 10 s: rebuilt
      } finally {
        jest.useRealTimers();
        delete process.env.DISCOVERY_SNAPSHOT_TTL_MS;
      }
    });

    test('TTL 0 turns the cache off', async () => {
      process.env.DISCOVERY_SNAPSHOT_TTL_MS = '0';
      try {
        let calls = 0;
        const build = async () => { calls += 1; return { branches: [], complete: true }; };
        await cache.getSnapshot(build);
        await cache.getSnapshot(build);
        expect(calls).toBe(2);
      } finally {
        delete process.env.DISCOVERY_SNAPSHOT_TTL_MS;
      }
    });
  });

  test('nearby distances are per request and never leak into the shared snapshot', async () => {
    const far = await request(server).get('/api/v1/discovery/gyms/nearby?lat=0&lng=0&radiusKm=100000');
    const near = await request(server).get('/api/v1/discovery/gyms/nearby?lat=24.86&lng=67.0&radiusKm=100000');
    expect(far.status).toBe(200);
    expect(near.status).toBe(200);
    const snap = await cache.getSnapshot(async () => { throw new Error('should be cached'); });
    for (const b of snap) expect(b.distanceKm).toBeUndefined();
    expect(Object.isFrozen(snap)).toBe(true);
  });

  test('public discovery answers 200 with a shared-cache header; authenticated routes do not', async () => {
    const pub = await request(server).get('/api/v1/discovery/cities');
    expect(pub.status).toBe(200);
    expect(pub.headers['cache-control']).toMatch(/public/);
    expect(pub.headers['cache-control']).toMatch(/s-maxage=60/);
    const auth = await asPersona('owner').get('/me/context');
    expect(auth.headers['cache-control'] || '').not.toMatch(/public/);
    const notFound = await request(server).get('/api/v1/discovery/gyms/00000000-0000-4000-8000-000000000000');
    expect(notFound.headers['cache-control'] || '').not.toMatch(/public/);
  });
});
