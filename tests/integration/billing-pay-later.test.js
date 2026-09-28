/**
 * BILL-13 — "Pay later" must not give free service (spec §7.5.11, §12.1,
 * owner decisions R-17 / R-22: 14 days, one setting PAY_LATER_GRACE_DAYS).
 *
 *   submission (PAY_LATER) → no plan yet
 *   approval               → ONE MANUAL row in GRACE: 1 branch, ends approval + PAY_LATER_GRACE_DAYS
 *   admin verifies payment → ACTIVE, PAID (audited)
 *   grace ends unpaid      → the existing daily sweep makes it EXPIRED → 0 branches
 *
 * Runs a real approval (provisioning into a `gymsera_test_pl_*` database); the
 * clock is advanced by faking Date only.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, getAdminConnection, factories } = require('../harness');
const { installMailFake } = require('../harness/mail-fake');
const app = require('../../app');
const { signToken } = require('../../src/utils/jwt.utils');
const { City, Tenant, TenantSubscription, PlatformPackage, GymListing } = require('../../src/models/platform');
const quota = require('../../src/services/subscription-quota.service');
const tenantService = require('../../src/services/tenant.service');
const adminService = require('../../src/services/admin.service');
const subscriptionMigration = require('../../src/services/subscription-migration.service');
const TenantDbManager = require('../../src/database/TenantDbManager');
const { runExpiryCheck } = require('../../src/jobs/subscription-expiry.cron');

const DAY = 24 * 60 * 60 * 1000;
const createdDbs = [];

const fakeClock = (ms) =>
  jest.useFakeTimers({
    now: ms,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'queueMicrotask', 'hrtime', 'performance',
    ],
  });

describe('BILL-13: pay later is a time-limited GRACE plan', () => {
  let admin;
  let adminToken;
  let legacyPackage;
  let seq = 0;

  beforeAll(async () => {
    await setupTestDatabases();
    installMailFake();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    admin = await factories.createUser({ email: 'admin-pl@gymsera.test', role: 'PLATFORM_ADMIN' });
    adminToken = signToken({ sub: admin.id, id: admin.id, role: 'PLATFORM_ADMIN', isVerified: true });
    // A generous registration package: none of it may leak into pay-later.
    legacyPackage = await PlatformPackage.create({
      name: 'Legacy 5', price: 5000, billingCycle: 'YEARLY', maxBranches: 5, maxOrganizations: 3, maxTrainers: 10, maxMembers: 1000,
    });
    await factories.createBillingPlan({ branchCount: 1, sortOrder: 1, monthlyPrice: 2000, annualPrice: 14400 });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.PAY_LATER_GRACE_DAYS;
  });

  afterAll(async () => {
    const conn = await getAdminConnection();
    for (const db of createdDbs) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
    await teardownTestDatabases();
  });

  /** Submits an application with the chosen payment method, then approves it. */
  const submitAndApprove = async (paymentMethod = 'PAY_LATER') => {
    seq += 1;
    const tenantCode = `test_pl_${Date.now().toString(36)}_${seq}`;
    createdDbs.push(`gymsera_${tenantCode}`);
    const tenant = await factories.createTenant({
      tenantCode,
      status: 'DRAFT',
      connectionStringEncrypted: null,
      selectedPackageId: legacyPackage.id,
      mainBranchDataJson: { plans: [{ name: 'Monthly', price: 3000, durationDays: 30 }] },
    });
    await tenantService.finalizeApplication(tenant.id, tenant.ownerUserId, { paymentMethod });
    const afterSubmit = await TenantSubscription.count({ where: { tenantId: tenant.id } });
    const approvedAt = Date.now();
    await adminService.approveTenant(tenant.id, admin.id);
    return { tenant: await Tenant.findByPk(tenant.id), afterSubmit, approvedAt };
  };

  const maxBranches = async (tenantId) => {
    const t = await Tenant.findByPk(tenantId);
    return quota.resolveMaxBranches(t, await quota.getActiveSubscription(tenantId));
  };
  const plusDays = (ms, days) => new Date(ms + days * DAY).toISOString().split('T')[0];
  const hostToken = (tenant) =>
    signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });

  test('submission creates no plan; approval creates exactly one MANUAL GRACE row: 1 branch, approval + 14 days', async () => {
    const { tenant, afterSubmit, approvedAt } = await submitAndApprove();
    expect(afterSubmit).toBe(0);

    const rows = await TenantSubscription.findAll({ where: { tenantId: tenant.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: 'MANUAL', status: 'GRACE', branchCount: 1, paymentStatus: 'PENDING' });
    expect(rows[0].endDate).toBe(plusDays(approvedAt, 14));
    expect(await maxBranches(tenant.id)).toBe(1);
    // The registration package's extra branches were not handed out as slots.
    const listing = await GymListing.findOne({ where: { tenantId: tenant.id } });
    expect(listing ? listing.reservedSlots : 0).toBe(0);

    // The host sees a countdown.
    const res = await request(app).get('/api/v1/host/subscription/current').set('Authorization', `Bearer ${hostToken(tenant)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('GRACE');
    expect(res.body.data.paymentIssue).toEqual({ provider: 'MANUAL', manageUrl: null, payBy: plusDays(approvedAt, 14), daysLeft: 14 });
  });

  test('the grace length comes from PAY_LATER_GRACE_DAYS', async () => {
    process.env.PAY_LATER_GRACE_DAYS = '5';
    const { tenant, approvedAt } = await submitAndApprove();
    const row = await TenantSubscription.findOne({ where: { tenantId: tenant.id } });
    expect(row.endDate).toBe(plusDays(approvedAt, 5));
  });

  test('grace ends unpaid → the daily sweep makes it EXPIRED and the tenant is entitled to 0 branches', async () => {
    const { tenant } = await submitAndApprove();
    fakeClock(Date.now() + 16 * DAY); // past the 14 days, even with the cron's local-midnight date (a day behind east of UTC)
    await runExpiryCheck();
    jest.useRealTimers();

    const row = await TenantSubscription.findOne({ where: { tenantId: tenant.id } });
    expect(row.status).toBe('EXPIRED');
    // Never the registration package (5) or the legacy default (1).
    expect(await maxBranches(tenant.id)).toBe(0);
  });

  test('admin verifies the bank transfer → ACTIVE and PAID, audited; the grace date no longer ends it', async () => {
    const { tenant } = await submitAndApprove();
    const row = await TenantSubscription.findOne({ where: { tenantId: tenant.id } });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${tenant.id}/subscriptions/${row.id}/verify-payment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bankTransferRef: 'HBL-778899' });
    expect(res.status).toBe(200);

    await row.reload();
    expect(row).toMatchObject({ status: 'ACTIVE', paymentStatus: 'PAID', bankTransferRef: 'HBL-778899', branchCount: 1 });
    expect(new Date(row.endDate).getTime()).toBeGreaterThan(Date.now() + 27 * DAY);

    const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
    const audit = await tenantDb.models.AuditLog.findOne({ where: { action: 'billing.pay_later_verified' } });
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(admin.id);

    fakeClock(Date.now() + 16 * DAY); // past the 14 days, even with the cron's local-midnight date (a day behind east of UTC)
    await runExpiryCheck();
    jest.useRealTimers();
    expect((await TenantSubscription.findByPk(row.id)).status).toBe('ACTIVE');
    expect(await maxBranches(tenant.id)).toBe(1);
  });

  test('verify-payment refuses anything but a pay-later row in GRACE, and non-admins', async () => {
    const { tenant } = await submitAndApprove();
    const row = await TenantSubscription.findOne({ where: { tenantId: tenant.id } });
    const verify = (token) => request(app)
      .post(`/api/v1/admin/tenants/${tenant.id}/subscriptions/${row.id}/verify-payment`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect((await verify(hostToken(tenant))).status).toBe(403);
    expect((await verify(adminToken)).status).toBe(200);
    // Already ACTIVE: a second verification is refused, nothing changes.
    const again = await verify(adminToken);
    expect(again.status).toBe(409);
  });

  test('starting pay-later twice (an approval retried) keeps one row', async () => {
    const { tenant } = await submitAndApprove();
    await subscriptionMigration.startPayLaterGrace(tenant.id);
    expect(await TenantSubscription.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  test('bank transfer applications are unchanged by this fix (plan row created at submission)', async () => {
    const { afterSubmit, tenant } = await submitAndApprove('BANK_TRANSFER');
    expect(afterSubmit).toBe(1);
    const rows = await TenantSubscription.findAll({ where: { tenantId: tenant.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ACTIVE');
  });
});
