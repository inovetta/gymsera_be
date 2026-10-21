/**
 * NEW-06 (P0) — POST /host/subscription/upgrade must never give a host a paid plan.
 *
 * It used to cancel the ACTIVE rows and create an ACTIVE / PAID row for any PlatformPackage with
 * no payment (host.controller.js#upgradeSubscription). Plans now come only from a verified store
 * purchase (the billing sync routes and webhooks) or from an admin who has seen the money
 * (admin assign / pay-later verify). The route answers 410 and writes nothing.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { City, Tenant, TenantSubscription, PlatformPackage } = require('../../src/models/platform');
const quota = require('../../src/services/subscription-quota.service');

describe('NEW-06: POST /host/subscription/upgrade grants nothing', () => {
  let app;
  let dbHarness;
  let tenant;
  let pkg;
  let token;

  beforeAll(async () => {
    app = await startTestServer();
    dbHarness = await setupTestDatabases();
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    pkg = await PlatformPackage.create({
      name: 'Pro 50',
      price: 9000,
      billingCycle: 'MONTHLY',
      maxBranches: 50,
      maxOrganizations: 5,
      maxTrainers: 50,
      maxMembers: 5000,
    });
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    token = signToken({
      sub: tenant.ownerUserId,
      id: tenant.ownerUserId,
      role: 'GYM_HOST',
      isVerified: true,
      tenantId: tenant.id,
    });
  });

  const upgrade = () =>
    request(app).post('/api/v1/host/subscription/upgrade').set('Authorization', `Bearer ${token}`).send({ planId: pkg.id });
  const snapshot = async () => ({
    rows: (await TenantSubscription.findAll({ where: { tenantId: tenant.id }, order: [['id', 'ASC']] })).map(
      (r) => `${r.id}:${r.status}:${r.paymentStatus}`
    ),
    maxBranches: await quota.resolveMaxBranches(await Tenant.findByPk(tenant.id), await quota.getActiveSubscription(tenant.id)),
    selectedPackageId: (await Tenant.findByPk(tenant.id)).selectedPackageId,
  });

  test('a host with no plan who posts a package id is denied and nothing changes', async () => {
    const before = await snapshot();
    const res = await upgrade();
    expect(res.status).toBe(410);
    expect(res.body.success).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(before.rows).toEqual([]);
  });

  test('a host on a lapsed or pending-payment plan cannot replace it with a PAID one', async () => {
    await TenantSubscription.create({
      tenantId: tenant.id,
      platformPackageId: pkg.id,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      amount: 9000,
      billingCycle: 'MONTHLY',
      status: 'ACTIVE',
      paymentStatus: 'PENDING',
    });
    const before = await snapshot();
    const res = await upgrade();
    expect(res.status).toBe(410);
    expect(await snapshot()).toEqual(before);
  });

  test('a non-host and an anonymous caller are still refused', async () => {
    const anon = await request(app).post('/api/v1/host/subscription/upgrade').send({ planId: pkg.id });
    expect(anon.status).toBe(401);
  });
});
