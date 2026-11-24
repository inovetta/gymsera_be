/**
 * R-120 NEW-308 (option S): one id per business.
 * The tenant `businesses` row has the id of its platform `business_listings` row, and every branch points at it with
 * `branches.business_id`. The two link columns (`businesses.gym_listing_id`, `branches.gym_listing_id`) are gone
 * (tenant migration 031), so no copy can drift (G11).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { GymListing, TenantSubscription } = require('../../src/models/platform');
const rename = require('../../src/database/rename-helpers');

let h;
let personas;

beforeAll(async () => {
  h = await setupTestDatabases();
  personas = await setupPersonas(h);
  await TenantSubscription.update({ branchCount: 50 }, { where: { organizationId: personas.owner.organizationId } });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const approvePending = () =>
  GymListing.update({ status: 'ACTIVE' }, { where: { organizationId: personas.owner.organizationId, status: 'PENDING' } });

describe('NEW-308: the business id is the listing id', () => {
  test('tenant migration 031 left no gym_listing_id column on businesses or branches (and the models do not map one)', async () => {
    const seq = h.tenant1.sequelize || h.tenant1.models.Gym.sequelize;
    expect(await rename.columnInfo(seq, 'businesses', 'gym_listing_id')).toBeFalsy();
    expect(await rename.columnInfo(seq, 'branches', 'gym_listing_id')).toBeFalsy();
    const attrs = (m) => Object.entries(m.rawAttributes).filter(([, a]) => a.field === 'gym_listing_id' && a.type.key !== 'VIRTUAL');
    expect(attrs(h.tenant1.models.Gym)).toEqual([]);
    expect(attrs(h.tenant1.models.Branch)).toEqual([]);
  });

  test('031 is idempotent: dropping a column that is already gone changes nothing', async () => {
    const seq = h.tenant1.sequelize || h.tenant1.models.Gym.sequelize;
    expect(await rename.dropColumn(seq, { table: 'branches', column: 'gym_listing_id' })).toEqual({ statements: [] });
  });

  test('POST /host/listings builds the business with the listing id, and its branch under it', async () => {
    await approvePending();
    const res = await asPersona('owner').post('/host/listings', {
      gymName: 'N308 Org', branchSource: 'new', cityId: 1,
      packages: [{ name: 'Monthly', price: 1500, durationType: 'MONTHLY', durationValue: 1 }],
    });
    expect(res.status).toBe(201);
    const listingId = res.body.data.id;
    const { Gym, Branch } = h.tenant1.models;
    const gym = await Gym.findByPk(listingId);
    expect(gym).not.toBeNull();
    const branches = await Branch.findAll({ where: { gymId: listingId } });
    expect(branches).toHaveLength(1);
    expect(branches[0].toJSON().gymListingId).toBe(listingId); // the read-only alias (until NEW-309)
  });

  test('guard: every tenant business has the id of a platform listing of that organization, every branch a business', async () => {
    const { Gym, Branch } = h.tenant1.models;
    const listings = await GymListing.findAll({ where: { organizationId: personas.owner.organizationId }, attributes: ['id'], raw: true });
    const listingIds = new Set(listings.map((l) => l.id));
    const gyms = await Gym.findAll({ attributes: ['id'], raw: true });
    expect(gyms.length).toBeGreaterThan(0);
    for (const g of gyms) expect(listingIds.has(g.id)).toBe(true);
    const gymIds = new Set(gyms.map((g) => g.id));
    const branches = await Branch.findAll({ attributes: ['id', 'gymId'], raw: true });
    for (const b of branches) expect(gymIds.has(b.gymId)).toBe(true);
  });

  test('listing the branches of one business returns only its own (a branch is never listed under every business, G11)', async () => {
    const { Gym, Branch } = h.tenant1.models;
    const gyms = await Gym.findAll({ attributes: ['id'], raw: true });
    for (const g of gyms) {
      const own = await Branch.findAll({ where: { gymId: g.id }, attributes: ['id'], raw: true });
      const res = await asPersona('owner').get(`/host/listings/${g.id}/branches`);
      expect(res.status).toBe(200);
      const body = res.body.data;
      const rows = Array.isArray(body) ? body : body.branches || [];
      expect(rows.map((r) => r.id).sort()).toEqual(own.map((r) => r.id).sort());
    }
  });
});
