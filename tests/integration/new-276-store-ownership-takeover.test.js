/**
 * NEW-276 — a store purchase bound to a tenant that no longer exists can be taken over.
 *
 * Found on production (2026-11-19): after the launch wipe, a sandbox Apple ID that had
 * bought a plan for a wiped tenant bought again for a new tenant. Apple returns the same
 * subscription with the old appAccountToken, so POST /billing/ios/sync answered 409
 * "ownership mismatch … bound by the store to tenant <wiped>" for ever. The same happens
 * after an account deletion (the tenant row stays, status DELETED, with its store row).
 *
 * Rule (owner, 2026-11-19): when the tenant the store binds the purchase to, or the tenant
 * owning the existing row, is gone (no tenant row, or status DELETED), the caller's tenant
 * takes the subscription over and the takeover is audited. While that tenant still exists
 * (any other status, PENDING_DELETION included) the 409 stays (BILL-01).
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { City, Tenant, TenantSubscription, PlatformAuditLog } = require('../../src/models/platform');
const quota = require('../../src/services/subscription-quota.service');

const GONE_TENANT_ID = '570aba97-0000-4000-8000-000000000001';
const TAKEOVER = 'billing.store_subscription_taken_over';

let app;
beforeAll(async () => {
  app = await startTestServer();
});

describe('NEW-276: store purchase owned by a tenant that no longer exists', () => {
  let dbHarness;
  let tenantA;
  let tenantB;
  let tokenA;
  let tokenB;
  let plan5;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenantA = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    tenantB = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant2.encryptedConnStr });
    await factories.createGymListing(tenantA.id);
    await factories.createGymListing(tenantB.id);
    plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5 });
    const tokenFor = (t) => signToken({ sub: t.ownerUserId, id: t.ownerUserId, role: 'GYM_HOST', isVerified: true, organizationId: t.id });
    tokenA = tokenFor(tenantA);
    tokenB = tokenFor(tenantB);
  });

  const iosSync = (token, transactionId) =>
    request(app).post('/api/v1/billing/ios/sync').set('Authorization', `Bearer ${token}`).send({ transactionId });
  const androidSync = (token, purchaseToken) =>
    request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`)
      .send({ purchaseToken, productId: plan5.androidProductId });
  const entitlement = async (tenant) =>
    quota.resolveMaxBranches(await Tenant.findByPk(tenant.id), await quota.getActiveSubscription(tenant.id));
  const takeovers = () => PlatformAuditLog.findAll({ where: { action: TAKEOVER } });
  const appleTx = (id, appAccountToken) =>
    fakes.appleTransaction({ originalTransactionId: id, productId: plan5.iosMonthlyProductId, appAccountToken });

  test('Apple: the store token names a tenant that was wiped → the caller takes it over, audited', async () => {
    fakes.installAppleFakes({ 5000001: appleTx('5000001', GONE_TENANT_ID) });

    const res = await iosSync(tokenB, '5000001');

    expect(res.status).toBe(200);
    const row = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: '5000001' } });
    expect(row.organizationId).toBe(tenantB.id);
    expect(row.status).toBe('ACTIVE');
    expect(await entitlement(tenantB)).toBe(5);
    const audit = await takeovers();
    expect(audit).toHaveLength(1);
    expect(audit[0].targetId).toBe(row.id);
    expect(audit[0].details).toMatchObject({
      platform: 'IOS', organizationId: tenantB.id, fromTenantId: GONE_TENANT_ID, reason: 'bound_tenant_gone',
    });
    // ids only: never the store's transaction id
    expect(JSON.stringify(audit[0].details)).not.toContain('5000001');
  });

  test('Apple: the store token names a DELETED tenant (account deleted) → taken over', async () => {
    await Tenant.update({ status: 'DELETED', deletedAt: new Date() }, { where: { id: tenantA.id } });
    fakes.installAppleFakes({ 5000002: appleTx('5000002', tenantA.id) });

    expect((await iosSync(tokenB, '5000002')).status).toBe(200);
    const row = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: '5000002' } });
    expect(row.organizationId).toBe(tenantB.id);
    expect((await takeovers())[0].details).toMatchObject({ fromTenantId: tenantA.id, reason: 'bound_tenant_gone' });
  });

  test('Apple: the store token names a tenant that still exists → 409 as before, nothing written', async () => {
    fakes.installAppleFakes({ 5000003: appleTx('5000003', tenantA.id) });

    const res = await iosSync(tokenB, '5000003');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('subscription_owned_by_other_account');
    expect(await TenantSubscription.count()).toBe(0);
    expect(await takeovers()).toHaveLength(0);
  });

  test('Apple: a tenant waiting for its deletion still exists (it can cancel) → 409', async () => {
    await Tenant.update({ status: 'PENDING_DELETION' }, { where: { id: tenantA.id } });
    fakes.installAppleFakes({ 5000004: appleTx('5000004', tenantA.id) });

    expect((await iosSync(tokenB, '5000004')).status).toBe(409);
    expect(await TenantSubscription.count()).toBe(0);
  });

  test('Apple: the existing row belongs to a DELETED tenant → that row is released, the caller gets a new row', async () => {
    fakes.installAppleFakes({ 5000005: appleTx('5000005', tenantA.id) });
    expect((await iosSync(tokenA, '5000005')).status).toBe(200);
    const old = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: '5000005' } });
    await Tenant.update({ status: 'DELETED', deletedAt: new Date() }, { where: { id: tenantA.id } });

    const res = await iosSync(tokenB, '5000005');

    expect(res.status).toBe(200);
    const row = await TenantSubscription.findOne({ where: { externalOriginalTransactionId: '5000005' } });
    expect(row.id).not.toBe(old.id);
    expect(row.organizationId).toBe(tenantB.id);
    expect(row.status).toBe('ACTIVE');
    expect(await entitlement(tenantB)).toBe(5);

    await old.reload();
    expect(old.organizationId).toBe(tenantA.id); // the deleted tenant's history stays its own
    expect(old.status).toBe('CANCELLED');
    expect(old.externalOriginalTransactionId).toBe(`released:${old.id}`);
    expect(old.statusNote).toMatch(/taken over/i);

    const audit = await takeovers();
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({
      platform: 'IOS', organizationId: tenantB.id, fromTenantId: tenantA.id,
      reason: 'owner_tenant_deleted', releasedSubscriptionId: old.id,
    });
  });

  test('Apple: the existing row belongs to a tenant that still exists → 409, nothing changes', async () => {
    fakes.installAppleFakes({ 5000006: appleTx('5000006', tenantA.id) });
    expect((await iosSync(tokenA, '5000006')).status).toBe(200);
    const before = (await TenantSubscription.findAll()).map((r) => r.toJSON());

    expect((await iosSync(tokenB, '5000006')).status).toBe(409);
    expect((await TenantSubscription.findAll()).map((r) => r.toJSON())).toEqual(before);
    expect(await takeovers()).toHaveLength(0);
  });

  test('a repeated sync after the takeover is a plain renewal (no second row, no second audit)', async () => {
    fakes.installAppleFakes({ 5000007: appleTx('5000007', GONE_TENANT_ID) });
    expect((await iosSync(tokenB, '5000007')).status).toBe(200);
    expect((await iosSync(tokenB, '5000007')).status).toBe(200);

    expect(await TenantSubscription.count({ where: { externalOriginalTransactionId: '5000007' } })).toBe(1);
    expect(await takeovers()).toHaveLength(1);
  });

  test('Google: obfuscatedExternalAccountId naming a wiped tenant → taken over the same way', async () => {
    fakes.installGoogleFakes({
      'tok-gone': fakes.googlePurchase({ productId: plan5.androidProductId, obfuscatedExternalAccountId: GONE_TENANT_ID }),
    });

    expect((await androidSync(tokenB, 'tok-gone')).status).toBe(200);
    expect(await entitlement(tenantB)).toBe(5);
    expect((await takeovers())[0].details).toMatchObject({ platform: 'ANDROID', reason: 'bound_tenant_gone' });
  });
});
