/**
 * NEW-283 (owner, build 27): "by <brand>" under a gym's name only when the account has exactly one
 * live brand.
 *
 * The brand is the account's (tenants.business_name, R-112), and the app (gym_detail_screen.dart
 * brandByline) and the website (NEW-269) print it under every gym of the account. A host with two
 * brands (two live organisations) then showed the first brand's name on the second brand's gyms.
 *
 * Now the gym detail (GET /discovery/gyms/:id) sends tenant.organizationName only when the account has
 * exactly one ACTIVE organisation; otherwise null, which every client (build 26 included) already
 * reads as "no byline". The server decides, so old builds and the website are guarded too.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { makeBranchLive } = require('../harness/factories');
const cache = require('../../src/services/discovery-cache.service');
const { GymListing, Tenant } = require('../../src/models/platform');

describe('NEW-283: the brand byline only for an account with exactly one live brand', () => {
  let ctx;
  const extra = [];
  const brandOnDetail = async () => {
    const res = await asPersona('member').get(`/discovery/gyms/${ctx.branch1.id}`);
    expect(res.status).toBe(200);
    return res.body.data.gym.tenant?.organizationName ?? null;
  };

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
    await ctx.tenant1Db.models.MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'N283 Monthly', price: '3000.00',
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

  test('one live organisation: the brand is sent', async () => {
    expect(await GymListing.count({ where: { organizationId: ctx.tenant1.id, status: 'ACTIVE' } })).toBe(1);
    expect(await brandOnDetail()).toBe('Iron Brand');
  });

  test('a second organisation that is not live yet (pending, rejected) does not count', async () => {
    await addOrganisation('PENDING');
    await addOrganisation('REJECTED');
    expect(await brandOnDetail()).toBe('Iron Brand');
  });

  test('two live organisations: no brand, so the first brand is never shown on another brand\'s gyms', async () => {
    await addOrganisation('ACTIVE');
    expect(await brandOnDetail()).toBeNull();
  });
});
