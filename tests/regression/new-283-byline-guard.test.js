/**
 * NEW-283 (owner, build 27) was "by <brand>" under a gym's name only for an account with exactly one live brand.
 * R-120 (owner decision D3, API contract v2 §1 rule 7) replaces it with the stricter rule: the organization's name never
 * reaches a traveller. No traveller response carries `organizationName`, an `organization` object or a `tenant` object,
 * whatever the account looks like (one live business, a pending or rejected second one, two live ones).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { makeBranchLive } = require('../harness/factories');
const cache = require('../../src/services/discovery-cache.service');
const { GymListing, Tenant } = require('../../src/models/platform');

describe('NEW-283: the brand byline only for an account with exactly one live brand', () => {
  let ctx;
  const extra = [];
  // Both detail answers: the branch detail and the business detail. Nothing of the organization's name is in either.
  const expectNoBrand = async () => {
    for (const path of [`/discovery/branches/${ctx.branch1.id}`, `/discovery/businesses/${ctx.listing1.id}`]) {
      const res = await asPersona('member').get(path);
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('Iron Brand');
      expect(text).not.toContain('"organizationName"');
      expect(text).not.toContain('"tenant"');
      expect(text).not.toContain('"organization"');
    }
  };

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
    await ctx.tenant1Db.models.MembershipPlan.create({
      businessId: ctx.branch1.businessId, branchId: ctx.branch1.id, name: 'N283 Monthly', price: '3000.00',
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
    });
    await Tenant.update({ organizationName: 'Iron Brand' }, { where: { id: ctx.tenant1.id } });
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });
  beforeEach(() => cache._resetForTests());
  afterEach(async () => {
    while (extra.length) await GymListing.destroy({ where: { id: extra.pop() } });
  });

  const addOrganisation = async (status) => {
    const l = await factories.createGymListing(ctx.tenant1.id, { status, title: `N283 ${status} ${extra.length}` });
    extra.push(l.id);
  };

  test('one live organisation: the brand is not sent', async () => {
    expect(await GymListing.count({ where: { organizationId: ctx.tenant1.id, status: 'ACTIVE' } })).toBe(1);
    await expectNoBrand();
  });

  test('a second organisation that is not live yet (pending, rejected): the brand is not sent', async () => {
    await addOrganisation('PENDING');
    await addOrganisation('REJECTED');
    await expectNoBrand();
  });

  test('two live organisations: the brand is not sent either', async () => {
    await addOrganisation('ACTIVE');
    await expectNoBrand();
  });
});
