/**
 * P5b item 8 (R-81 revised) — "Move branch" is removed, not frozen.
 *
 * Moving a branch between organizations had no password, accepted a deleted target
 * organization, ran without a transaction or lock, wrote nothing to the capacity ledger,
 * and left the branch's plans, reviews, saved gyms and the members' platform copies on
 * the old organization. The owner removed it: no route, no service function, no
 * "delete organization and move its branches" strategy. A future "transfer branch" is a
 * post-launch item (spec §14 R-81).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const walk = require('../harness/route-walk');
const gymService = require('../../src/services/gym.service');

let dbHarness;
let ctx;

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  await setupPersonas(dbHarness);
  ctx = require('../harness/personas').personaManager.context;
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('P5b item 8: Move branch is gone', () => {
  test('no move route is mounted', () => {
    const keys = walk(require('../../app')._router.stack).map((r) => r.key);
    expect(keys.filter((k) => /\/move$/.test(k))).toEqual([]);
  });

  test('POST /host/branches/:branchId/move answers 404 and the branch stays in its organization', async () => {
    const { GymListing } = require('../../src/models/platform');
    const target = await GymListing.create({ tenantId: ctx.tenant1.id, title: 'P5b Move Target', status: 'ACTIVE', cityId: 1 });
    const res = await asPersona('owner').post(`/host/branches/${ctx.branch1.id}/move`, { targetListingId: target.id });
    expect(res.status).toBe(404);
    const branch = await dbHarness.tenant1.models.Branch.findByPk(ctx.branch1.id);
    expect(branch.gymListingId).toBe(ctx.listing1.id);
  });

  test('the service has no moveBranch', () => {
    expect(gymService.moveBranch).toBeUndefined();
  });

  test('deleting an organization with strategy moveBranches is refused (400) and nothing moves', async () => {
    const { GymListing } = require('../../src/models/platform');
    const source = await factories.createGymListing(ctx.tenant1.id, { title: 'P5b Move Source' });
    const branch = await factories.createBranch(dbHarness.tenant1, source.id, { name: 'P5b Source Branch' });
    const res = await asPersona('owner').delete(`/host/listings/${source.id}`, {
      password: 'Test@12345',
      strategy: 'moveBranches',
      targetListingId: ctx.listing1.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_strategy');
    expect((await GymListing.findByPk(source.id)).status).toBe('ACTIVE');
    const reloaded = await dbHarness.tenant1.models.Branch.findByPk(branch.id);
    expect(reloaded.gymListingId).toBe(source.id);
    expect(reloaded.status).toBe('ACTIVE');
  });
});
