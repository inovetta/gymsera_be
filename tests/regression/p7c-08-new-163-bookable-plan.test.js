/**
 * P7c item 8 — NEW-163 (P1; owner decision R-82).
 *
 * POST /subscriptions and GET /subscriptions/quote looked the plan up by id and
 * status only (subscription.service.js#subscribe, #quoteFirstPayment), so a
 * traveller could book a plan the host hid from travellers (isPublic false) or a
 * plan that belongs to another branch, by sending its id.
 *
 * Now a plan is bookable at a branch only when it is ACTIVE, shown to travellers,
 * and either that branch's own plan or a gym-wide plan (branchId null) of the
 * same gym. Anything else answers 404 `plan_not_available`, and nothing is created.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { makeBranchLive, createBranch } = require('../harness/factories');
const cache = require('../../src/services/discovery-cache.service');

describe('P7c item 8 (NEW-163): booking refuses a hidden plan or another branch\'s plan', () => {
  let ctx;
  let models;
  let visible;
  let hidden;
  let otherBranchPlan;
  let gymWide;

  const book = (planId) => asPersona('member').post('/subscriptions', { planId, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id });
  const quote = (planId) =>
    asPersona('member').get(`/subscriptions/quote?planId=${planId}&gymListingId=${ctx.listing1.id}&branchId=${ctx.branch1.id}`);
  const plan = (fields) =>
    models.MembershipPlan.create({
      gymId: ctx.branch1.gymId, name: 'Plan', price: '1000.00', durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE',
      ...fields,
    });

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    models = ctx.tenant1Db.models;
    await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
    const sibling = await createBranch(ctx.tenant1Db, ctx.listing1.id, { gymId: ctx.branch1.gymId, branchName: 'Sibling' });
    await makeBranchLive(ctx.tenant1Db, sibling);
    visible = await plan({ branchId: ctx.branch1.id, name: 'Visible', isPublic: true });
    hidden = await plan({ branchId: ctx.branch1.id, name: 'Staff only', isPublic: false });
    otherBranchPlan = await plan({ branchId: sibling.id, name: 'Sibling plan', isPublic: true });
    gymWide = await plan({ branchId: null, name: 'Gym-wide', isPublic: true });
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    cache._resetForTests();
    await models.MemberSubscription.destroy({ where: {} });
  });

  const expectRefused = async (res) => {
    expect(res.status).toBe(404);
    expect(res.body.code || res.body.error?.code).toBe('plan_not_available');
    expect(await models.MemberSubscription.count()).toBe(0);
  };

  test('a plan hidden from travellers: quote and booking refused, nothing created', async () => {
    await expectRefused(await quote(hidden.id));
    await expectRefused(await book(hidden.id));
  });

  test('a plan of another branch: quote and booking refused, nothing created', async () => {
    await expectRefused(await quote(otherBranchPlan.id));
    await expectRefused(await book(otherBranchPlan.id));
  });

  test('the branch\'s own visible plan and a visible gym-wide plan are bookable', async () => {
    expect((await quote(visible.id)).status).toBe(200);
    expect((await book(visible.id)).status).toBe(201);
    await models.MemberSubscription.destroy({ where: {} });
    expect((await quote(gymWide.id)).status).toBe(200);
    expect((await book(gymWide.id)).status).toBe(201);
  });
});
