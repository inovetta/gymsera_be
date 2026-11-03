/**
 * NEW-196 (P10b): the CMS Gym Profile lists the organizations (GET /host/listings) and edits each
 * one through GET / PATCH /host/listings/:id and uploads photos through POST /host/listings/staging-images, as the mobile
 * Edit Organization does. /gyms/profile edits only the tenant's first organization.
 *
 * Owner decision 2026-11-03 (§14 R-89): those routes accept the owner (as before, including the
 * onboarding upload that has no tenant context yet) and a team member with listing.manage
 * organization-wide (the rule /gyms/profile already uses, NEW-45). Persona matrix: owner and Org
 * Admin pass; Branch Manager and Front Desk (no listing.manage) get 403; another tenant's owner
 * cannot read or change this tenant's organization; no token is 401.
 *
 * Photo uploads are called with no file: past the permission check the answer is 422 (nothing
 * stored), so 403 is the only refusal.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam } = require('../harness/two-branch-team');
const { GymListing } = require('../../src/models/platform');

let app;
let team;
let personas;
let dbHarness;
let firstOrg;
let secondOrg;
let secondGym;

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  team = await buildTwoBranchTeam(dbHarness, personas);
  firstOrg = await GymListing.findOne({ where: { tenantId: team.tenantId }, order: [['createdAt', 'ASC']] });
  secondOrg = await factories.createGymListing(team.tenantId, { title: 'Second Organization' });
  secondGym = await dbHarness.tenant1.models.Gym.create({ name: 'Second Organization', gymListingId: secondOrg.id, genderType: 'MIXED' });
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const call = (method, path, token, body, tenantId = team.tenantId) => {
  let r = request(app)[method](`/api/v1${path}`).set('X-Tenant-Id', tenantId);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};

describe('NEW-196 organization profile routes: who may use them', () => {
  const allowed = () => [['owner', team.ownerToken], ['Org Admin', team.orgAdmin.token]];
  const refused = () => [['Branch Manager', team.managerA.token], ['Front Desk', team.frontDeskOff.token]];

  test('owner and Org Admin list the organizations to choose from; Branch Manager and Front Desk cannot', async () => {
    for (const [, token] of allowed()) {
      const res = await call('get', '/host/listings', token);
      expect(res.status).toBe(200);
      expect(res.body.data.map((l) => l.id)).toEqual(expect.arrayContaining([firstOrg.id, secondOrg.id]));
    }
    for (const [, token] of refused()) {
      expect((await call('get', '/host/listings', token)).status).toBe(403);
    }
  });

  test('owner and Org Admin read any organization of the tenant', async () => {
    for (const [, token] of allowed()) {
      for (const org of [firstOrg, secondOrg]) {
        const res = await call('get', `/host/listings/${org.id}`, token);
        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe(org.id);
      }
    }
    const second = await call('get', `/host/listings/${secondOrg.id}`, team.orgAdmin.token);
    expect(second.body.data.gym.id).toBe(secondGym.id);
  });

  test('owner and Org Admin save the second organization; the first is not touched', async () => {
    const before = (await GymListing.findByPk(firstOrg.id)).toJSON();
    for (const [who, token] of allowed()) {
      const res = await call('patch', `/host/listings/${secondOrg.id}`, token, {
        gymName: `Second Organization (${who})`,
        gymDescription: 'Edited from the CMS',
        contactEmail: 'second@gymsera.test',
        website: 'https://second.gymsera.test',
        genderType: 'FEMALE_ONLY',
        imagesJson: ['https://cdn.gymsera.test/a.jpg'],
      });
      expect(res.status).toBe(200);
    }
    const after = await GymListing.findByPk(secondOrg.id);
    expect(after.title).toBe('Second Organization (Org Admin)');
    await secondGym.reload();
    expect(secondGym.contactEmail).toBe('second@gymsera.test');
    expect(secondGym.genderType).toBe('FEMALE_ONLY');
    const first = (await GymListing.findByPk(firstOrg.id)).toJSON();
    expect({ title: first.title, shortDescription: first.shortDescription, genderType: first.genderType })
      .toEqual({ title: before.title, shortDescription: before.shortDescription, genderType: before.genderType });
  });

  test('owner and Org Admin get past the check on the photo upload (422: no file, nothing stored)', async () => {
    for (const [, token] of allowed()) {
      expect((await call('post', '/host/listings/staging-images', token)).status).toBe(422);
    }
  });

  test.each([
    ['get', 'read'],
    ['patch', 'save'],
  ])('Branch Manager and Front Desk cannot %s an organization (403)', async (method) => {
    for (const [, token] of refused()) {
      const res = await call(method, `/host/listings/${secondOrg.id}`, token, method === 'patch' ? { gymDescription: 'x' } : undefined);
      expect(res.status).toBe(403);
    }
  });

  test('Branch Manager and Front Desk cannot upload organization photos (403)', async () => {
    for (const [, token] of refused()) {
      expect((await call('post', '/host/listings/staging-images', token)).status).toBe(403);
    }
  });

  test("another tenant's owner cannot read or change this tenant's organization", async () => {
    const other = personas.otherTenantOwner;
    for (const tenantId of [other.tenantId, team.tenantId]) {
      const read = await call('get', `/host/listings/${secondOrg.id}`, other.token, undefined, tenantId);
      expect([403, 404]).toContain(read.status);
      const write = await call('patch', `/host/listings/${secondOrg.id}`, other.token, { gymDescription: 'hijack' }, tenantId);
      expect([403, 404]).toContain(write.status);
    }
    await secondGym.reload();
    expect(secondGym.description).not.toBe('hijack');
  });

  test('no token is 401', async () => {
    expect((await call('get', `/host/listings/${secondOrg.id}`)).status).toBe(401);
    expect((await call('patch', `/host/listings/${secondOrg.id}`, null, { gymDescription: 'x' })).status).toBe(401);
    expect((await call('post', '/host/listings/staging-images')).status).toBe(401);
  });
});
