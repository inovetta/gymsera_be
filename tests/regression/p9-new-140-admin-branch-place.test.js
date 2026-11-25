/**
 * Phase 7 P9, NEW-140: the CMS admin branch form picks the address from Google through our API,
 * like the host forms (P3).
 *
 * Before: POST and PATCH /admin/organizations/:id/branches[/:branchId] did not take `googlePlaceId`
 * (admin.routes.js:247-248 allow-lists; `updateAdminTenantBranch` fields, admin.service.js), and
 * neither checked the coordinate ranges P3 added to the host routes (latitude 123 was stored).
 * After: both take `googlePlaceId`; latitude / longitude out of range answer 422.
 * Also: POST /host/businesses (New Organization with its first branch) dropped `googlePlaceId`
 * (host.routes.js allow-list; host.controller.js createListing); the first branch now keeps it.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { firstBranchInput } = require('../harness/first-branch-input');
const { personaManager } = require('../harness/personas');

let h;
const organizationId = '11111111-1111-4111-8111-111111111111';
const PLACE = 'ChIJ2QeB5YMEGTkRYiR-zGy-OsI';

beforeAll(async () => {
  h = await setupTestDatabases();
  await setupPersonas(h);
  const { City } = require('../../src/models/platform');
  await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const firstBranch = () => h.tenant1.models.Branch.findOne({ order: [['createdAt', 'ASC']] });

describe('NEW-140: admin branch create / edit keep the Google place', () => {
  test('PATCH stores googlePlaceId with the picked coordinates', async () => {
    const branch = await firstBranch();
    const res = await asPersona('platformAdmin')
      .patch(`/admin/organizations/${organizationId}/branches/${branch.id}`)
      .send({ address: 'Shahrah-e-Faisal, Karachi', latitude: 24.86, longitude: 67.0, googlePlaceId: PLACE });
    expect(res.status).toBe(200);
    await branch.reload();
    expect(branch.googlePlaceId).toBe(PLACE);
    expect(Number(branch.latitude)).toBeCloseTo(24.86);
  });

  test.each([
    ['latitude', 123],
    ['longitude', -190],
  ])('PATCH refuses %s %s (422) and keeps the branch as it was', async (field, value) => {
    const branch = await firstBranch();
    const before = branch[field];
    const res = await asPersona('platformAdmin')
      .patch(`/admin/organizations/${organizationId}/branches/${branch.id}`)
      .send({ [field]: value });
    expect(res.status).toBe(422);
    await branch.reload();
    expect(branch[field]).toEqual(before);
  });

  test('PATCH refuses a googlePlaceId that is not a place id', async () => {
    const branch = await firstBranch();
    const res = await asPersona('platformAdmin')
      .patch(`/admin/organizations/${organizationId}/branches/${branch.id}`)
      .send({ googlePlaceId: 'not a place id; drop table' });
    expect(res.status).toBe(422);
  });

  test('POST creates the branch with its googlePlaceId', async () => {
    const res = await asPersona('platformAdmin')
      .post(`/admin/organizations/${organizationId}/branches`)
      .send({ branchName: 'Clifton', address: 'Clifton Block 5', cityId: 1, latitude: 24.81, longitude: 67.03, googlePlaceId: PLACE });
    expect(res.status).toBe(201);
    const branch = await h.tenant1.models.Branch.findByPk(res.body.data.branch.id);
    expect(branch.googlePlaceId).toBe(PLACE);
  });

  test('POST refuses latitude out of range', async () => {
    const res = await asPersona('platformAdmin')
      .post(`/admin/organizations/${organizationId}/branches`)
      .send({ branchName: 'Nowhere', address: 'x', cityId: 1, latitude: 99 });
    expect(res.status).toBe(422);
  });

  test('New Organization (POST /host/businesses) keeps the first branch\'s googlePlaceId', async () => {
    const res = await asPersona('owner')
      .post('/host/businesses')
      .send({
        businessName: 'Second Org', businessDescription: 'x', genderType: 'MIXED',
        firstBranch: await firstBranchInput({ address: 'MM Alam Road', latitude: 31.51, longitude: 74.34, googlePlaceId: PLACE,
          packages: [{ name: 'Monthly', price: 3000, durationType: 'MONTHLY', durationValue: 1 }] }), // A2 H2
      });
    expect(res.status).toBe(201);
    expect(res.body.data.branch).toBeNull();
    await require('../harness/business-proof').addProof(res.body.data.business.id);
    await require('../../src/services/admin.service').approveTenant(`${organizationId}:${res.body.data.business.id}`, personaManager.personas.platformAdmin.user.id);
    const branch = await h.tenant1.models.Branch.findOne({ where: { businessId: res.body.data.business.id } });
    expect(branch.googlePlaceId).toBe(PLACE);
  });

  test('POST /host/businesses refuses a googlePlaceId that is not a place id', async () => {
    const res = await asPersona('owner')
      .post('/host/businesses')
      .send({
        businessName: 'Bad Org', businessDescription: 'x', genderType: 'MIXED',
        firstBranch: await firstBranchInput({ googlePlaceId: 'not a place id; drop table' }), // A2 H2
      });
    expect(res.status).toBe(422);
  });
});
