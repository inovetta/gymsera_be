/**
 * FLOW-03 — card at registration + a plan created at approval must never be
 * two entitlements (spec §7.5.10, §12.3).
 *
 * At approval, before any plan is created, the tenant's provider-backed row
 * (e.g. the Stripe subscription from the card step) is looked up. If one
 * exists it is re-verified with the provider and nothing else is created;
 * otherwise the MANUAL plan for the chosen method is created. A card
 * subscription that completes AFTER approval replaces the MANUAL plan cleanly.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, getAdminConnection, factories } = require('../harness');
const { installMailFake } = require('../harness/mail-fake');
const fakes = require('../harness/billing-fakes');
// supertest calls a server already listening on 127.0.0.1 (TEST-FLAKE-1B).
const { startTestServer } = require('../harness/test-server');

let app;
beforeAll(async () => {
  app = await startTestServer();
});
const { City, TenantSubscription } = require('../../src/models/platform');
const tenantService = require('../../src/services/tenant.service');
const adminService = require('../../src/services/admin.service');
const { ENTITLING_STATUSES } = require('../../src/services/subscription-quota.service');

const createdDbs = [];

describe('FLOW-03: one entitlement across card-at-registration and approval', () => {
  let admin;
  let seq = 0;

  beforeAll(async () => {
    await setupTestDatabases();
    installMailFake();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    admin = await factories.createUser({ email: 'admin-flow03@gymsera.test', role: 'PLATFORM_ADMIN' });
    await factories.createBillingPlan({ branchCount: 1, sortOrder: 1, stripeMonthlyPriceId: 'price_1m' });
    await factories.createBillingPlan({ branchCount: 3, sortOrder: 3, stripeMonthlyPriceId: 'price_3m' });
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    const conn = await getAdminConnection();
    for (const db of createdDbs) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
    await teardownTestDatabases();
  });

  const pendingTenant = async () => {
    seq += 1;
    const tenantCode = `test_f03_${Date.now().toString(36)}_${seq}`;
    createdDbs.push(`gymsera_${tenantCode}`);
    return factories.createTenant({
      tenantCode,
      status: 'DRAFT',
      connectionStringEncrypted: null,
      mainBranchDataJson: { plans: [{ name: 'Monthly', price: 3000, durationDays: 30 }] },
    });
  };
  const stripeEvent = (id, subId) =>
    request(app).post('/api/v1/billing/webhooks/stripe')
      .send({ id, type: 'customer.subscription.updated', data: { object: { id: subId } } });
  const entitlingRows = (tenantId) =>
    TenantSubscription.findAll({ where: { tenantId, status: ENTITLING_STATUSES } });

  test('card paid at registration → approval re-verifies that Stripe row and creates nothing else', async () => {
    const tenant = await pendingTenant();
    const { truth, retrieve } = fakes.installStripeFakes({
      subscriptions: { sub_card: fakes.stripeSubscription({ id: 'sub_card', priceId: 'price_3m', tenantId: tenant.id }) },
    });
    await stripeEvent('evt_card', 'sub_card');
    await tenantService.finalizeApplication(tenant.id, tenant.ownerUserId, { paymentMethod: 'PAY_LATER' });
    retrieve.mockClear();
    truth.subscriptions.sub_card = { ...truth.subscriptions.sub_card, status: 'past_due' };

    await adminService.approveTenant(tenant.id, admin.id);

    expect(retrieve).toHaveBeenCalledWith('sub_card');
    const all = await TenantSubscription.findAll({ where: { tenantId: tenant.id } });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ platform: 'STRIPE', status: 'GRACE', branchCount: 3 });
  });

  test('a provider-backed row that is not entitling (card declined) is linked — no free pay-later plan on top', async () => {
    const tenant = await pendingTenant();
    fakes.installStripeFakes({
      subscriptions: { sub_decl: fakes.stripeSubscription({ id: 'sub_decl', priceId: 'price_3m', tenantId: tenant.id, status: 'unpaid' }) },
    });
    await stripeEvent('evt_decl', 'sub_decl');
    await tenantService.finalizeApplication(tenant.id, tenant.ownerUserId, { paymentMethod: 'PAY_LATER' });

    await adminService.approveTenant(tenant.id, admin.id);

    const all = await TenantSubscription.findAll({ where: { tenantId: tenant.id } });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ platform: 'STRIPE', status: 'ON_HOLD' });
    expect(await entitlingRows(tenant.id)).toHaveLength(0);
  });

  test('a card subscription completing after approval replaces the MANUAL plan: one entitling row, the MANUAL row closed with a clear note', async () => {
    const tenant = await pendingTenant();
    await tenantService.finalizeApplication(tenant.id, tenant.ownerUserId, { paymentMethod: 'PAY_LATER' });
    await adminService.approveTenant(tenant.id, admin.id);
    const manual = await TenantSubscription.findOne({ where: { tenantId: tenant.id, platform: 'MANUAL' } });
    expect(manual.status).toBe('GRACE');

    fakes.installStripeFakes({
      subscriptions: { sub_late: fakes.stripeSubscription({ id: 'sub_late', priceId: 'price_3m', tenantId: tenant.id }) },
    });
    await stripeEvent('evt_late', 'sub_late');

    const entitled = await entitlingRows(tenant.id);
    expect(entitled).toHaveLength(1);
    expect(entitled[0].platform).toBe('STRIPE');
    await manual.reload();
    expect(manual.status).toBe('CANCELLED');
    expect(manual.statusNote).toMatch(/Replaced by a new Stripe subscription/);
    expect(manual.statusNote).not.toMatch(/undefined/);
  });
});
