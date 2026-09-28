/**
 * NEW-15 — GET /host/subscription/current must not hand a lapsed tenant a free plan
 * (spec §12.13 NEW-15, §7.5.7, §7.5.8).
 *
 * The endpoint used to create a 30-day ACTIVE/PAID row whenever the tenant had
 * no ACTIVE row — including right after a refund revoked it (undoing BILL-02).
 * Owner decision R-21 (spec §14): the endpoint is read-only and never creates
 * a plan, for any tenant. Every call below runs under a write spy.
 */
const request = require('supertest');
const { Sequelize } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
  resetTestDatabases,
  factories,
} = require('../harness');
const fakes = require('../harness/billing-fakes');
// supertest calls a server already listening on 127.0.0.1 (TEST-FLAKE-1B).
const { startTestServer } = require('../harness/test-server');

let app;
beforeAll(async () => {
  app = await startTestServer();
});
const { signToken } = require('../../src/utils/jwt.utils');
const {
  City,
  Tenant,
  TenantSubscription,
  PlatformPackage,
  GymListing,
} = require('../../src/models/platform');
const quota = require('../../src/services/subscription-quota.service');

describe('NEW-15: GET /host/subscription/current never grants a plan to a tenant whose plan ended', () => {
  let dbHarness;
  let tenant;
  let legacyPackage;
  let token;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestDatabases();
    await City.findOrCreate({
      where: { id: 1 },
      defaults: { id: 1, name: 'Karachi', isActive: true },
    });
    // Registration picked a legacy package — the one the old code re-granted.
    legacyPackage = await PlatformPackage.create({
      name: 'Legacy 10',
      price: 1000,
      billingCycle: 'MONTHLY',
      maxBranches: 10,
      maxOrganizations: 3,
      maxTrainers: 10,
      maxMembers: 1000,
    });
    tenant = await factories.createTenant({
      connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr,
      selectedPackageId: legacyPackage.id,
    });
    token = signToken({
      sub: tenant.ownerUserId,
      id: tenant.ownerUserId,
      role: 'GYM_HOST',
      isVerified: true,
      tenantId: tenant.id,
    });
  });

  // Calls the endpoint and fails the test if it issued any write
  // (same query-spy pattern as tests/regression/get-connection-side-effects.test.js).
  const getCurrent = async () => {
    const writes = [];
    const originalQuery = Sequelize.prototype.query;
    const spy = jest.spyOn(Sequelize.prototype, 'query').mockImplementation(function (sql) {
      const sqlString = typeof sql === 'string' ? sql : sql?.query || '';
      if (/^\s*(UPDATE|INSERT|DELETE|ALTER|CREATE|DROP|REPLACE|TRUNCATE)\b/i.test(sqlString))
        writes.push(sqlString);
      return originalQuery.apply(this, arguments);
    });
    try {
      const res = await request(app)
        .get('/api/v1/host/subscription/current')
        .set('Authorization', `Bearer ${token}`);
      expect(writes).toEqual([]);
      return res;
    } finally {
      spy.mockRestore();
    }
  };
  const maxBranches = async () => {
    const t = await Tenant.findByPk(tenant.id);
    return quota.resolveMaxBranches(t, await quota.getActiveSubscription(tenant.id));
  };
  const rows = async () =>
    (
      await TenantSubscription.findAll({
        where: { tenantId: tenant.id },
        order: [['createdAt', 'ASC']],
      })
    ).map((r) => `${r.id}:${r.status}`);

  test('after a refund (REVOKED, 0 branches) it answers "no active plan" and creates nothing', async () => {
    const listing = await factories.createGymListing(tenant.id, { reservedSlots: 3 });
    await factories.createBranch(dbHarness.tenant1, listing.id);
    const plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5 });

    // Buy, then refund — the BILL-02 path (webhook → refetch → applyVerifiedSubscription → REVOKED).
    const tx = fakes.appleTransaction({
      originalTransactionId: '4000001',
      productId: plan5.iosMonthlyProductId,
    });
    const { truth } = fakes.installAppleFakes({ 4000001: tx });
    await request(app)
      .post('/api/v1/billing/ios/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({ transactionId: '4000001' });
    expect(await maxBranches()).toBe(5);
    truth['4000001'] = { ...tx, revocationDate: Date.now(), revocationReason: 0 };
    await request(app)
      .post('/api/v1/billing/webhooks/apple')
      .send(
        fakes.appleNotificationBody({
          notificationUUID: 'uuid-new15',
          notificationType: 'REFUND',
          transaction: truth['4000001'],
        })
      );
    expect(
      (await TenantSubscription.findOne({ where: { externalOriginalTransactionId: '4000001' } }))
        .status
    ).toBe('REVOKED');
    expect(await maxBranches()).toBe(0);
    const before = await rows();

    const res = await getCurrent();

    expect(res.status).toBe(404);
    expect(
      await TenantSubscription.count({ where: { tenantId: tenant.id, status: 'ACTIVE' } })
    ).toBe(0);
    expect(await rows()).toEqual(before);
    expect(await maxBranches()).toBe(0);
    expect((await GymListing.findByPk(listing.id)).reservedSlots).toBe(0);

    // Calling it again (the app polls it) still grants nothing.
    expect((await getCurrent()).status).toBe(404);
    expect(await rows()).toEqual(before);
  });

  test.each(['CANCELLED', 'EXPIRED', 'REVOKED'])(
    'a tenant whose only plan is %s gets no free plan',
    async (status) => {
      await factories.createTenantSubscription(tenant.id, {
        status,
        platform: 'MANUAL',
        platformPackageId: legacyPackage.id,
        branchCount: null,
      });
      const before = await rows();

      const res = await getCurrent();

      expect(res.status).toBe(404);
      expect(await rows()).toEqual(before);
    }
  );

  test('a tenant with no plan history but a selected package gets 404 and nothing is written (R-21)', async () => {
    expect(await TenantSubscription.count({ where: { tenantId: tenant.id } })).toBe(0);

    const res = await getCurrent();

    expect(res.status).toBe(404);
    expect(await TenantSubscription.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect((await getCurrent()).status).toBe(404);
    expect(await TenantSubscription.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  test('a tenant with no plan history and no selected package gets 404 and nothing is written', async () => {
    await Tenant.update({ selectedPackageId: null }, { where: { id: tenant.id } });

    const res = await getCurrent();

    expect(res.status).toBe(404);
    expect(await TenantSubscription.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  test('a tenant with an ACTIVE plan gets that plan and nothing is created', async () => {
    const active = await factories.createTenantSubscription(tenant.id, {
      status: 'ACTIVE',
      platform: 'IOS',
      branchCount: 3,
    });

    const res = await getCurrent();

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(active.id);
    expect(await TenantSubscription.count({ where: { tenantId: tenant.id } })).toBe(1);
  });
});
