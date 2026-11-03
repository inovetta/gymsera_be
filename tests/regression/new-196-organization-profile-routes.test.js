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
 * Owner conditions (2026-11-03): deny by default; listing.manage must be organization-wide (the same
 * permission granted at one branch gives no organization edit); a user of another tenant is always
 * refused, even an Org Admin there; a platform admin gets nothing on these host routes; every edit
 * is written to the platform audit log with the actor (field names only, no values), in the same
 * transaction, so an edit that cannot be audited is not saved.
 *
 * Photo uploads are called with no file: past the permission check the answer is 422 (nothing
 * stored), so 403 is the only refusal.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam, teamMember } = require('../harness/two-branch-team');
const { GymListing, PlatformAuditLog } = require('../../src/models/platform');

let app;
let team;
let personas;
let dbHarness;
let firstOrg;
let secondOrg;
let secondGym;
let branchScoped;
let otherTenantOrgAdmin;

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  team = await buildTwoBranchTeam(dbHarness, personas);
  firstOrg = await GymListing.findOne({ where: { tenantId: team.tenantId }, order: [['createdAt', 'ASC']] });
  secondOrg = await factories.createGymListing(team.tenantId, { title: 'Second Organization' });
  secondGym = await dbHarness.tenant1.models.Gym.create({ name: 'Second Organization', gymListingId: secondOrg.id, genderType: 'MIXED' });
  // listing.manage granted at one branch only: a Front Desk at branch A with an ALLOW override.
  branchScoped = await teamMember({
    tenantDb: dbHarness.tenant1, tenantId: team.tenantId, email: 'branch-listing@new196.test',
    roleKey: 'DESK', scopeType: 'BRANCH', branchIds: [team.branchA.id], allow: ['listing.manage'],
  });
  // An Org Admin with listing.manage in the other tenant.
  otherTenantOrgAdmin = await teamMember({
    tenantDb: dbHarness.tenant2, tenantId: personas.otherTenantOwner.tenantId, email: 'other-orgadmin@new196.test',
    roleKey: 'ORG_ADMIN', scopeType: 'ORG', branchIds: [],
  });
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

  test('another tenant\'s owner cannot read or change this tenant\'s organization', async () => {
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

  test('listing.manage granted at a branch only does not edit the organization (403 everywhere)', async () => {
    const t = branchScoped.token;
    expect((await call('get', '/host/listings', t)).status).toBe(403);
    expect((await call('get', `/host/listings/${secondOrg.id}`, t)).status).toBe(403);
    expect((await call('patch', `/host/listings/${secondOrg.id}`, t, { gymDescription: 'branch scoped' })).status).toBe(403);
    expect((await call('post', '/host/listings/staging-images', t)).status).toBe(403);
    await secondGym.reload();
    expect(secondGym.description).not.toBe('branch scoped');
  });

  test('another tenant\'s Org Admin (listing.manage there) is refused here, with either tenant header', async () => {
    for (const tenantId of [personas.otherTenantOwner.tenantId, team.tenantId]) {
      const t = otherTenantOrgAdmin.token;
      expect([403, 404]).toContain((await call('get', `/host/listings/${secondOrg.id}`, t, undefined, tenantId)).status);
      expect([403, 404]).toContain((await call('patch', `/host/listings/${secondOrg.id}`, t, { gymDescription: 'cross tenant' }, tenantId)).status);
    }
    await secondGym.reload();
    expect(secondGym.description).not.toBe('cross tenant');
  });

  test('a platform admin gets nothing on these host routes (deny by default; the admin area has its own)', async () => {
    const t = personas.platformAdmin.token;
    expect((await call('get', `/host/listings/${secondOrg.id}`, t)).status).toBe(403);
    expect((await call('patch', `/host/listings/${secondOrg.id}`, t, { gymDescription: 'platform admin' })).status).toBe(403);
    await secondGym.reload();
    expect(secondGym.description).not.toBe('platform admin');
  });
});

describe('NEW-196 every organization edit is in the audit log with its actor', () => {
  const auditRows = () =>
    PlatformAuditLog.findAll({ where: { action: 'organization.profile_updated', targetId: secondOrg.id }, order: [['createdAt', 'ASC']] });

  test('owner and Org Admin edits each write a row: actor, organization, tenant, changed fields, no values', async () => {
    const seen = new Set((await auditRows()).map((r) => r.id));
    await call('patch', `/host/listings/${secondOrg.id}`, team.ownerToken, { website: 'https://owner.example.test' }).expect(200);
    await call('put', `/host/listings/${secondOrg.id}`, team.orgAdmin.token, { contactEmail: 'audit@gymsera.test', gymDescription: 'by org admin' }).expect(200);
    const rows = (await auditRows()).filter((r) => !seen.has(r.id));
    expect(rows).toHaveLength(2);
    const byOwner = rows.find((r) => r.actorUserId === personas.owner.user.id);
    const byOrgAdmin = rows.find((r) => r.actorUserId === team.orgAdmin.user.id);
    expect(byOwner.targetType).toBe('GymListing');
    expect(byOwner.details).toMatchObject({ tenantId: team.tenantId, fields: ['website'], asOwner: true });
    expect(byOrgAdmin.targetType).toBe('GymListing');
    expect(byOrgAdmin.details).toMatchObject({ tenantId: team.tenantId, asOwner: false });
    expect([...byOrgAdmin.details.fields].sort()).toEqual(['contactEmail', 'gymDescription']);
    expect(JSON.stringify(rows.map((r) => r.details))).not.toContain('audit@gymsera.test');
  });

  test('an edit that cannot be audited is not saved', async () => {
    const spy = jest.spyOn(PlatformAuditLog, 'create').mockRejectedValueOnce(new Error('audit table down'));
    try {
      const res = await call('patch', `/host/listings/${secondOrg.id}`, team.ownerToken, { gymName: 'Not audited' });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await GymListing.findByPk(secondOrg.id)).title).not.toBe('Not audited');
    await secondGym.reload();
    expect(secondGym.name).not.toBe('Not audited');
  });
});
