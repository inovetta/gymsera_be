/**
 * P7c item 5 (NEW-174, P1; owner decision R-82).
 *
 * GET /host/subscription/current answered 404 whenever no row entitled, so after a
 * lapse the app said "You don't have a subscription on this account yet". Now it
 * answers 200 with the latest ended row (EXPIRED, ON_HOLD, PAUSED, REVOKED),
 * `entitled: false` and a `lapse` block: status, reason, provider, the store page,
 * when entitlement ended, when branches lock. Read-only: it writes nothing.
 * A tenant that never had a plan still gets 404; an entitling plan says `entitled: true`.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { City, TenantSubscription } = require('../../src/models/platform');

const DAY = 24 * 60 * 60 * 1000;

let app;
beforeAll(async () => {
  app = await startTestServer();
});

describe('P7c item 5: the current subscription after a lapse', () => {
  let dbHarness;
  let tenant;
  let token;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.gymsera.test';
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    const listing = await factories.createGymListing(tenant.id);
    await factories.createBranch(dbHarness.tenant1, listing.id);
    await factories.createBranch(dbHarness.tenant1, listing.id);
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
  });

  const current = () => request(app).get('/api/v1/host/subscription/current').set('Authorization', `Bearer ${token}`);

  test.each([
    ['EXPIRED', 'MANUAL', 'expired', null],
    ['ON_HOLD', 'ANDROID', 'on_hold', 'https://play.google.com/store/account/subscriptions?sku=plan_3b&package=com.gymsera.test'],
    ['PAUSED', 'ANDROID', 'paused', 'https://play.google.com/store/account/subscriptions?sku=plan_3b&package=com.gymsera.test'],
    ['REVOKED', 'IOS', 'refunded', 'https://apps.apple.com/account/subscriptions'],
  ])('%s (%s) → 200, entitled false, reason %s, the store page, the lock date', async (status, platform, reason, manageUrl) => {
    const endedAt = new Date(Math.floor((Date.now() - 2 * DAY) / 1000) * 1000); // DATETIME keeps whole seconds
    const row = await factories.createTenantSubscription(tenant.id, {
      status, platform, branchCount: 3, productId: 'plan_3b', externalOriginalTransactionId: `ext-${status}`,
    });
    await row.update({ entitlementEndedAt: endedAt });
    const before = JSON.stringify(await TenantSubscription.findAll({ raw: true }));

    const res = await current();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: row.id, status, entitled: false });
    expect(res.body.data.lapse).toMatchObject({
      status, reason, provider: platform, manageUrl,
      endedAt: endedAt.toISOString(),
      branchesLockAt: new Date(endedAt.getTime() + 7 * DAY).toISOString(),
      inGrace: true,
      remainingDays: 5,
    });
    expect(JSON.stringify(await TenantSubscription.findAll({ raw: true }))).toBe(before);
  });

  test('a lapsed row from before p026 (no entitlementEndedAt) is read without writing', async () => {
    const row = await factories.createTenantSubscription(tenant.id, { status: 'EXPIRED', platform: 'MANUAL' });
    await TenantSubscription.update({ entitlementEndedAt: null }, { where: { id: row.id }, hooks: false });
    const res = await current();
    expect(res.status).toBe(200);
    expect(res.body.data.entitled).toBe(false);
    expect((await row.reload()).entitlementEndedAt).toBeNull();
  });

  test('never had a plan → 404, as before', async () => {
    expect((await current()).status).toBe(404);
  });

  test('an entitling plan → entitled true, lapse null', async () => {
    await factories.createTenantSubscription(tenant.id, { status: 'ACTIVE', platform: 'MANUAL' });
    const res = await current();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ entitled: true, lapse: null });
  });
});
