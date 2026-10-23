/**
 * NEW-103: PATCH /admin/tenants/:id/branches/:branchId copied only a fixed list of fields, so the map position
 * (latitude, longitude) and the facilities the CMS sends were silently dropped: the call answered 200 and nothing changed.
 * It now saves them like the host-side update does (gym.service#updateBranch): `facilities` (array) is stored as facilitiesJson.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { GymListing } = require('../../src/models/platform');

describe('NEW-103: admin branch edit saves position and facilities', () => {
  let db;
  let tenantId;
  let branch;

  beforeAll(async () => {
    const h = await setupTestDatabases();
    const personas = await setupPersonas(h);
    db = h.tenant1;
    tenantId = personas.owner.tenantId;
    const listing = await GymListing.findOne({ where: { tenantId } });
    branch = await db.models.Branch.findOne({ where: { gymListingId: listing.id } });
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  const patch = (body) => asPersona('platformAdmin').patch(`/admin/tenants/${tenantId}/branches/${branch.id}`, body);

  test('latitude and longitude are saved', async () => {
    const res = await patch({ latitude: 24.8607, longitude: 67.0011 });
    expect(res.status).toBe(200);
    await branch.reload();
    expect(Number(branch.latitude)).toBeCloseTo(24.8607, 4);
    expect(Number(branch.longitude)).toBeCloseTo(67.0011, 4);
  });

  test('null clears the position', async () => {
    const res = await patch({ latitude: null, longitude: null });
    expect(res.status).toBe(200);
    await branch.reload();
    expect(branch.latitude).toBeNull();
    expect(branch.longitude).toBeNull();
  });

  test('facilities (the array the CMS sends) is stored as facilitiesJson', async () => {
    const res = await patch({ facilities: ['Sauna', 'Showers'] });
    expect(res.status).toBe(200);
    await branch.reload();
    expect(branch.facilitiesJson).toEqual(['Sauna', 'Showers']);
  });

  test('facilitiesJson still works and a field that is not sent is left alone', async () => {
    await patch({ phone: '+923001112233' });
    const res = await patch({ facilitiesJson: ['Parking'] });
    expect(res.status).toBe(200);
    await branch.reload();
    expect(branch.facilitiesJson).toEqual(['Parking']);
    expect(branch.phone).toBe('+923001112233');
  });
});
