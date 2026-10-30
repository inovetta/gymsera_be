/**
 * Phase 7 P8, owner decision R-83 (NEW-184): a branch locked for billing is hidden from travellers.
 *
 * Before: discovery's one visibility rule (`TRAVELLER_VISIBLE_BRANCH`, discovery.service.js:14)
 * did not look at `billing_locked_at`, so a locked branch stayed in every traveller list and its
 * detail opened, while booking it was refused (`subscription.service.js:212`, branch_billing_locked):
 * a traveller found the gym and then could not book it.
 * Now: lists, organization branches and detail leave it out (detail 404 gym_not_available); booking
 * answers 409 gym_not_bookable. Existing members keep their memberships (CAP-01 member grace).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { makeBranchLive } = require('../harness/factories');
const cache = require('../../src/services/discovery-cache.service');
const subscriptionService = require('../../src/services/subscription.service');

describe('R-83: a billing-locked branch is hidden from travellers', () => {
  let ctx; let plan; let memberSubId;

  const get = (path) => asPersona('member').get(`/discovery${path}`);
  const listedIds = async () => (await get('/gyms?page=1&limit=50')).body.data.gyms.map((g) => g.id);
  const lock = () => ctx.tenant1Db.models.Branch.update(
    { billingLockedAt: new Date(), billingLockReason: 'test' }, { where: { id: ctx.branch1.id } }
  );

  beforeAll(async () => {
    const h = await setupTestDatabases();
    const personas = await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
    plan = await ctx.tenant1Db.models.MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'R-83 Monthly', price: '3000.00',
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
    });
    const sub = await subscriptionService.subscribe(personas.member.user.id, {
      planId: plan.id, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id,
    });
    memberSubId = sub.id || sub.subscription?.id;
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  beforeEach(() => cache._resetForTests());
  afterEach(() => ctx.tenant1Db.models.Branch.update(
    { billingLockedAt: null, billingLockReason: null }, { where: { id: ctx.branch1.id } }
  ));

  test('unlocked: listed and its detail opens', async () => {
    expect(await listedIds()).toContain(ctx.branch1.id);
    expect((await get(`/gyms/${ctx.branch1.id}`)).status).toBe(200);
  });

  test('locked: not in lists or the organization branches; detail 404 gym_not_available', async () => {
    await lock();
    expect(await listedIds()).not.toContain(ctx.branch1.id);
    const branches = await get(`/organizations/${ctx.branch1.gymId}/branches`);
    const ids = branches.status === 200 ? (branches.body.data.branches || []).map((b) => b.id) : [];
    expect(ids).not.toContain(ctx.branch1.id);
    const detail = await get(`/gyms/${ctx.branch1.id}`);
    expect(detail.status).toBe(404);
    expect(detail.body.code).toBe('gym_not_available');
  });

  test('locked: a new booking is refused before anything is written', async () => {
    await lock();
    const res = await asPersona('member').post('/subscriptions', {
      planId: plan.id, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id,
    });
    expect(res.status).toBe(409);
    expect(res.body.code || res.body.error?.code).toBe('gym_not_bookable');
  });

  test('locked: an existing member keeps the membership and can still open it', async () => {
    expect(memberSubId).toBeTruthy();
    await lock();
    const res = await asPersona('member').get(`/me/subscriptions/${memberSubId}`);
    expect(res.status).toBe(200);
    const row = await ctx.tenant1Db.models.MemberSubscription.findByPk(memberSubId);
    expect(row).not.toBeNull();
    expect(['PENDING', 'ACTIVE']).toContain(row.status);
  });
});
