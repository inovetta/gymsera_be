/**
 * Phase 7 P5 — BUG-22 L8 (Listings tab: Edit Organization), backend half.
 *
 * L8 Edit Organization edited the wrong organization. The app has no per-organization read, so it
 * used GET/PATCH /gyms/profile: gym.service.js#updateProfile edits Gym.findOne() (whichever gym row
 * comes first), and #_syncGymListing then wrote name, description, logo, cover, phone, website and
 * photos onto EVERY GymListing of the tenant. A host with two organizations who edited one renamed
 * both. After: GET /host/listings/:id and PUT/PATCH /host/listings/:id read and write that organization
 * and its own gym only, and the profile sync touches only the edited gym's own listing.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { GymListing, TenantSubscription } = require('../../src/models/platform');

let personas;
let tenantDb;
let primary; // the owner's first organization (harness)

const plan = (name, isPublic) => ({ name, price: 1500, durationType: 'MONTHLY', durationValue: 1, ...(isPublic === undefined ? {} : { isPublic }) });

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  tenantDb = h.tenant1;
  primary = await GymListing.findOne({ where: { tenantId: personas.owner.tenantId }, order: [['createdAt', 'ASC']] });
  // Room for the organizations and branches these tests build.
  // The onboarding organization and its gym are older than anything these tests build (MySQL keeps
  // whole seconds, so rows made in one test run would otherwise tie).
  const { sequelize: platformSql } = GymListing;
  await platformSql.query('UPDATE gym_listings SET created_at = ? WHERE id = ?', { replacements: ['2026-01-01 00:00:00', primary.id] });
  await tenantDb.models.Gym.sequelize.query('UPDATE gyms SET created_at = ? WHERE gym_listing_id = ?', { replacements: ['2026-01-01 00:00:00', primary.id] });
  const [updated] = await TenantSubscription.update({ branchCount: 50 }, { where: { tenantId: personas.owner.tenantId } });
  expect(updated).toBeGreaterThan(0);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

// A PENDING organization blocks creating the next one until an admin approves it.
const approvePending = () =>
  GymListing.update({ status: 'ACTIVE' }, { where: { tenantId: personas.owner.tenantId, status: 'PENDING' } });

const newOrg = async (gymName, packages = [plan(`${gymName} Monthly`)]) => {
  await approvePending();
  const res = await asPersona('owner').post('/host/listings', { gymName, branchSource: 'new', cityId: 1, packages });
  expect(res.status).toBe(201);
  await approvePending();
  return res.body.data;
};


describe('BUG-22 L8: Edit Organization reads and writes only that organization', () => {
  let orgA;
  let orgB;

  beforeAll(async () => {
    orgA = await newOrg('P5 Org A');
    orgB = await newOrg('P5 Org B');
  });

  test('GET /host/listings/:id answers that organization and its own gym details', async () => {
    const { Gym } = tenantDb.models;
    await Gym.update({ website: 'https://b.example.com' }, { where: { gymListingId: orgB.id } });
    await GymListing.update({ category: 'Yoga' }, { where: { id: orgB.id } });

    const res = await asPersona('owner').get(`/host/listings/${orgB.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(orgB.id);
    expect(res.body.data.category).toBe('Yoga');
    expect(res.body.data.gym).toMatchObject({ name: 'P5 Org B', website: 'https://b.example.com' });
  });

  test('PUT /host/listings/:id changes that organization and its gym, never the other one', async () => {
    const res = await asPersona('owner').put(`/host/listings/${orgB.id}`, {
      gymName: 'P5 Org B Renamed',
      gymDescription: 'B description',
      category: 'CrossFit',
      establishedYear: 2019,
      contactEmail: 'b@example.com',
      website: 'https://b2.example.com',
      imagesJson: ['https://cdn.example.com/b1.jpg'],
    });
    expect(res.status).toBe(200);

    const { Gym } = tenantDb.models;
    const gymB = await Gym.findOne({ where: { gymListingId: orgB.id } });
    expect(gymB).toMatchObject({
      name: 'P5 Org B Renamed', description: 'B description', contactEmail: 'b@example.com', website: 'https://b2.example.com',
    });
    expect(gymB.imagesJson).toEqual(['https://cdn.example.com/b1.jpg']);
    const listingB = await GymListing.findByPk(orgB.id);
    expect(listingB).toMatchObject({ title: 'P5 Org B Renamed', category: 'CrossFit', establishedYear: 2019, website: 'https://b2.example.com' });

    // Organization A and its gym are untouched.
    expect((await GymListing.findByPk(orgA.id)).title).toBe('P5 Org A');
    const gymA = await Gym.findOne({ where: { gymListingId: orgA.id } });
    expect(gymA.name).toBe('P5 Org A');
    expect(gymA.website).not.toBe('https://b2.example.com');
    expect((await GymListing.findByPk(orgA.id)).category).not.toBe('CrossFit');
  });

  test('PUT /host/listings/:id validates the new fields (bad website / year: 422)', async () => {
    const bad = await asPersona('owner').put(`/host/listings/${orgB.id}`, { website: 'not a url', establishedYear: 3000 });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('validation_error');
  });

  test('PATCH /gyms/profile renames only its own organization (the first one), not every one of the tenant', async () => {
    const res = await asPersona('owner').patch('/gyms/profile', { name: 'P5 Profile Name' });
    expect(res.status).toBe(200);
    const titles = (await GymListing.findAll({ where: { tenantId: personas.owner.tenantId } })).map((l) => l.title);
    expect(titles.filter((t) => t === 'P5 Profile Name')).toHaveLength(1);
    expect((await GymListing.findByPk(primary.id)).title).toBe('P5 Profile Name');
    expect((await GymListing.findByPk(orgA.id)).title).toBe('P5 Org A');
  });

  test('personas: only the owner reads or edits; another tenant\'s owner gets 404', async () => {
    for (const who of ['manager', 'frontDesk', 'member']) {
      expect((await asPersona(who).get(`/host/listings/${orgA.id}`)).status).toBe(403);
      expect((await asPersona(who).put(`/host/listings/${orgA.id}`, { website: 'https://x.example.com' })).status).toBe(403);
    }
    expect((await asPersona('otherTenantOwner').get(`/host/listings/${orgA.id}`)).status).toBe(404);
    expect((await asPersona('otherTenantOwner').put(`/host/listings/${orgA.id}`, { website: 'https://x.example.com' })).status).toBe(404);
    const gymA = await tenantDb.models.Gym.findOne({ where: { gymListingId: orgA.id } });
    expect(gymA.website).not.toBe('https://x.example.com');
  });
});
