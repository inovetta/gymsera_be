/**
 * P5b item 7 (R-81 revised) — deleting an organization (directly, or by deleting its last
 * branch) never touches the GymsEra plan. When that plan bills through the App Store or
 * Google Play, the response says so and where to cancel it, so the app can tell the host.
 * The server never cancels the store subscription. Before: the response carried nothing
 * and the host was not told the plan keeps renewing.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');

let dbHarness;
let ctx;
let plan;

const PASSWORD = 'Test@12345';

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  await setupPersonas(dbHarness);
  ctx = require('../harness/personas').personaManager.context;
  const { TenantSubscription } = require('../../src/models/platform');
  plan = await TenantSubscription.findOne({ where: { tenantId: ctx.tenant1.id } });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const usePlatform = (platform) => plan.update({ platform, status: 'ACTIVE', autoRenew: true });

const orgWith = async (title, count) => {
  const listing = await factories.createGymListing(ctx.tenant1.id, { title });
  const branches = [];
  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    branches.push(await factories.createBranch(dbHarness.tenant1, listing.id, { name: `${title} ${i + 1}` }));
  }
  return { listing, branches };
};

describe('P5b item 7: the plan still bills in the store after an organization goes', () => {
  test('deleting an organization\'s last branch (iOS plan) → organizationDeleted and the App Store notice', async () => {
    await usePlatform('IOS');
    const { branches: [branch] } = await orgWith('Store Last Branch', 1);
    const res = await asPersona('owner').delete(`/gyms/branches/${branch.id}`, { password: PASSWORD, confirmOrganizationDeletion: true });
    expect(res.status).toBe(200);
    expect(res.body.data.organizationDeleted).toBe(true);
    expect(res.body.data.storePlanNotice).toEqual({
      platform: 'IOS',
      manageUrl: 'https://apps.apple.com/account/subscriptions',
      message: expect.stringContaining('App Store'),
    });
  });

  test('deleting an organization (Android plan) → the Google Play notice', async () => {
    await usePlatform('ANDROID');
    const { listing } = await orgWith('Store Org', 2);
    const res = await asPersona('owner').delete(`/host/listings/${listing.id}`, { password: PASSWORD, strategy: 'deleteBranches' });
    expect(res.status).toBe(200);
    expect(res.body.data.storePlanNotice).toEqual({
      platform: 'ANDROID',
      manageUrl: 'https://play.google.com/store/account/subscriptions',
      message: expect.stringContaining('Google Play'),
    });
  });

  test('deleting a branch that is not the organization\'s last → no notice', async () => {
    await usePlatform('IOS');
    const { branches: [branch] } = await orgWith('Store Not Last', 2);
    const res = await asPersona('owner').delete(`/gyms/branches/${branch.id}`, { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.organizationDeleted).toBe(false);
    expect(res.body.data.storePlanNotice).toBeNull();
  });

  test('a plan that does not bill through a store (bank transfer) → no notice', async () => {
    await usePlatform('MANUAL');
    const { listing } = await orgWith('Store Manual', 1);
    const res = await asPersona('owner').delete(`/host/listings/${listing.id}`, { password: PASSWORD, strategy: 'deleteBranches' });
    expect(res.status).toBe(200);
    expect(res.body.data.storePlanNotice).toBeNull();
  });

  test('the server never changes the store subscription', async () => {
    await usePlatform('IOS');
    const { listing } = await orgWith('Store Untouched', 1);
    await asPersona('owner').delete(`/host/listings/${listing.id}`, { password: PASSWORD, strategy: 'deleteBranches' });
    await plan.reload();
    expect(plan.status).toBe('ACTIVE');
    expect(plan.autoRenew).toBe(true);
    expect(plan.platform).toBe('IOS');
  });
});
