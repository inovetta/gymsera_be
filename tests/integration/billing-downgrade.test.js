/**
 * BILL-03 — a downgrade is applied when the provider applies it, never before,
 * and the host chooses which branches to keep (spec §7.5.4, §12.1).
 *
 * 6 → 3 branches: entitlement stays 6 until the provider switches the plan at
 * renewal; then it is 3, reconcileCapacity trims reserved slots first
 * (existing behaviour) and records the overage. The host's keep-list is stored
 * with pendingChange and survives to the effective date, where the branch
 * billing lock (CAP-01, Prompt 1C) will read it. No branch is locked here.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
// supertest calls a server already listening on 127.0.0.1 (TEST-FLAKE-1B).
const { startTestServer } = require('../harness/test-server');

let app;
beforeAll(async () => {
  app = await startTestServer();
});
const { signToken } = require('../../src/utils/jwt.utils');
const { City, Tenant, TenantSubscription, GymListing } = require('../../src/models/platform');
const quota = require('../../src/services/subscription-quota.service');
const googlePlayBilling = require('../../src/services/google-play-billing.service');

describe('BILL-03: deferred downgrade with a branch choice', () => {
  let dbHarness;
  let tenant;
  let listing;
  let plan6;
  let plan3;
  let token;
  let branches;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    process.env.GOOGLE_PLAY_RTDN_TOKEN = 'test-rtdn-token';
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    // 5 real branches + 1 reserved slot = the full 6-branch plan.
    listing = await factories.createGymListing(tenant.id, { reservedSlots: 1 });
    branches = [];
    for (let i = 1; i <= 5; i++) {
      branches.push(await factories.createBranch(dbHarness.tenant1, listing.id, { branchName: `Branch ${i}` }));
    }
    plan6 = await factories.createBillingPlan({ branchCount: 6, sortOrder: 6 });
    plan3 = await factories.createBillingPlan({ branchCount: 3, sortOrder: 3 });
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
  });

  const maxBranches = async () => {
    const t = await Tenant.findByPk(tenant.id);
    return quota.resolveMaxBranches(t, await quota.getActiveSubscription(tenant.id));
  };
  const rowFor = (externalId) => TenantSubscription.findOne({ where: { externalOriginalTransactionId: externalId } });
  const reservedSlots = async () => (await GymListing.findByPk(listing.id)).reservedSlots;
  const activeBranchCount = () => dbHarness.tenant1.models.Branch.count({ where: { status: 'ACTIVE' } });
  const auth = (r) => r.set('Authorization', `Bearer ${token}`);
  const preview = (planId) => auth(request(app).get(`/api/v1/billing/downgrade-preview?billingPlanId=${planId}`));
  const choose = (body) => auth(request(app).put('/api/v1/billing/downgrade-choice')).send(body);

  describe('Apple (in-group downgrade applies at renewal)', () => {
    let truth;
    const notify = (uuid, notificationType, subtype) =>
      request(app).post('/api/v1/billing/webhooks/apple')
        .send(fakes.appleNotificationBody({ notificationUUID: uuid, notificationType, subtype, transaction: truth['6000001'] }));

    beforeEach(async () => {
      ({ truth } = fakes.installAppleFakes({
        6000001: { ...fakes.appleTransaction({ originalTransactionId: '6000001', productId: plan6.iosMonthlyProductId }), subscriptionStatus: 1 },
      }));
      await auth(request(app).post('/api/v1/billing/ios/sync')).send({ transactionId: '6000001' });
      expect(await maxBranches()).toBe(6);
    });

    test('6 → 3: preview asks for a choice; keep-list stored; entitlement stays 6 until renewal, then 3 with the keep-list', async () => {
      const p = await preview(plan3.id);
      expect(p.status).toBe(200);
      expect(p.body.data).toMatchObject({
        currentBranchCount: 6, newBranchCount: 3, activeBranches: 5, reservedSlots: 1, mustChooseBranches: true, keepCount: 3,
      });
      expect(p.body.data.branches.map((b) => b.id).sort()).toEqual(branches.map((b) => b.id).sort());

      const keep = [branches[0].id, branches[2].id, branches[4].id];
      const c = await choose({ billingPlanId: plan3.id, keepBranchIds: keep });
      expect(c.status).toBe(200);
      let row = await rowFor('6000001');
      expect(row.pendingChange).toMatchObject({ billingPlanId: plan3.id, branchCount: 3, keepBranchIds: keep, confirmedByProvider: false });
      expect(row.branchCount).toBe(6);
      // The owner's choice is audited in the tenant's own trail.
      const audit = await dbHarness.tenant1.models.AuditLog.findOne({ where: { action: 'billing.downgrade_choice' } });
      expect(audit).not.toBeNull();
      expect(audit.actorUserId).toBe(tenant.ownerUserId);

      // The host downgrades at the App Store: Apple keeps the current product
      // until renewal and reports the next one in renewalInfo.
      truth['6000001'] = {
        ...truth['6000001'],
        renewalInfo: { autoRenewStatus: 1, autoRenewProductId: plan3.iosMonthlyProductId },
      };
      await notify('dg-pref', 'DID_CHANGE_RENEWAL_PREF', 'DOWNGRADE');
      row = await rowFor('6000001');
      expect(row.branchCount).toBe(6);
      expect(row.billingPlanId).toBe(plan6.id);
      expect(row.pendingChange).toMatchObject({
        billingPlanId: plan3.id, branchCount: 3, productId: plan3.iosMonthlyProductId,
        keepBranchIds: keep, confirmedByProvider: true, appliedAt: null,
      });
      expect(row.pendingChange.effectiveAt).toBeTruthy();
      expect(await maxBranches()).toBe(6);
      expect(await reservedSlots()).toBe(1);

      const current = await auth(request(app).get('/api/v1/host/subscription/current'));
      expect(current.body.data.pendingChange).toMatchObject({ branchCount: 3, keepBranchIds: keep });

      // Renewal: Apple now reports the 3-branch product as current.
      truth['6000001'] = {
        ...fakes.appleTransaction({ originalTransactionId: '6000001', transactionId: '6000001-2', productId: plan3.iosMonthlyProductId }),
        subscriptionStatus: 1,
        renewalInfo: { autoRenewStatus: 1, autoRenewProductId: plan3.iosMonthlyProductId },
      };
      await notify('dg-renew', 'DID_RENEW');
      row = await rowFor('6000001');
      expect(row.branchCount).toBe(3);
      expect(await maxBranches()).toBe(3);
      // Reserved slot trimmed first; the 2 real branches beyond the plan are
      // only recorded — never deleted or deactivated here (lock = CAP-01).
      expect(await reservedSlots()).toBe(0);
      expect(row.overQuotaCount).toBe(2);
      expect(await activeBranchCount()).toBe(5);
      expect(row.pendingChange).toMatchObject({ billingPlanId: plan3.id, keepBranchIds: keep });
      expect(row.pendingChange.appliedAt).toBeTruthy();
      // The hook CAP-01 will use.
      expect(await quota.getBranchesToKeep(tenant.id)).toEqual(keep);
    });

    test('the host cancels the downgrade at the store → the confirmed pending change is cleared', async () => {
      truth['6000001'] = { ...truth['6000001'], renewalInfo: { autoRenewStatus: 1, autoRenewProductId: plan3.iosMonthlyProductId } };
      await notify('dg-1', 'DID_CHANGE_RENEWAL_PREF', 'DOWNGRADE');
      expect((await rowFor('6000001')).pendingChange).toMatchObject({ branchCount: 3 });

      truth['6000001'] = { ...truth['6000001'], renewalInfo: { autoRenewStatus: 1, autoRenewProductId: plan6.iosMonthlyProductId } };
      await notify('dg-2', 'DID_CHANGE_RENEWAL_PREF');
      expect((await rowFor('6000001')).pendingChange).toBeNull();
      expect(await maxBranches()).toBe(6);
    });

    test('a store-confirmed downgrade without a keep-list reports that a choice is still needed', async () => {
      truth['6000001'] = { ...truth['6000001'], renewalInfo: { autoRenewStatus: 1, autoRenewProductId: plan3.iosMonthlyProductId } };
      await notify('dg-nochoice', 'DID_CHANGE_RENEWAL_PREF', 'DOWNGRADE');
      const row = await rowFor('6000001');
      expect(row.pendingChange).toMatchObject({ keepBranchIds: null, confirmedByProvider: true });
      const p = await preview(plan3.id);
      expect(p.body.data.pendingChange).toMatchObject({ confirmedByProvider: true, keepBranchIds: null });

      // Choosing after the store confirmed attaches the list to the confirmed change.
      const keep = [branches[1].id, branches[2].id, branches[3].id];
      expect((await choose({ billingPlanId: plan3.id, keepBranchIds: keep })).status).toBe(200);
      expect((await rowFor('6000001')).pendingChange).toMatchObject({ confirmedByProvider: true, keepBranchIds: keep });
    });
  });

  describe('keep-list validation', () => {
    beforeEach(async () => {
      fakes.installAppleFakes({
        6000002: { ...fakes.appleTransaction({ originalTransactionId: '6000002', productId: plan6.iosMonthlyProductId }), subscriptionStatus: 1 },
      });
      await auth(request(app).post('/api/v1/billing/ios/sync')).send({ transactionId: '6000002' });
    });

    test('wrong number of branches → 400', async () => {
      const res = await choose({ billingPlanId: plan3.id, keepBranchIds: [branches[0].id] });
      expect(res.status).toBe(400);
      expect((await rowFor('6000002')).pendingChange).toBeNull();
    });

    test('a branch that is not one of the tenant\'s active branches → 400', async () => {
      const res = await choose({ billingPlanId: plan3.id, keepBranchIds: [branches[0].id, branches[1].id, '00000000-0000-0000-0000-000000000000'] });
      expect(res.status).toBe(400);
    });

    test('duplicates → 400', async () => {
      const res = await choose({ billingPlanId: plan3.id, keepBranchIds: [branches[0].id, branches[0].id, branches[1].id] });
      expect(res.status).toBe(400);
    });

    test('not a downgrade → 400', async () => {
      const plan8 = await factories.createBillingPlan({ branchCount: 8, sortOrder: 8 });
      expect((await preview(plan8.id)).status).toBe(400);
      expect((await choose({ billingPlanId: plan8.id, keepBranchIds: [] })).status).toBe(400);
    });

    test('no choice needed when the active branches fit the new plan', async () => {
      const plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5 });
      const p = await preview(plan5.id);
      expect(p.body.data).toMatchObject({ mustChooseBranches: false, keepCount: 0 });
      expect((await choose({ billingPlanId: plan5.id })).status).toBe(200);
      expect((await rowFor('6000002')).pendingChange).toMatchObject({ billingPlanId: plan5.id, keepBranchIds: null });
    });

    test('only the account owner can choose (a staff token is refused)', async () => {
      const staffToken = signToken({ sub: 'staff-1', id: 'staff-1', role: 'STAFF', isVerified: true, tenantId: tenant.id });
      const res = await request(app).put('/api/v1/billing/downgrade-choice').set('Authorization', `Bearer ${staffToken}`)
        .send({ billingPlanId: plan3.id, keepBranchIds: branches.slice(0, 3).map((b) => b.id) });
      expect(res.status).toBe(403);
    });
  });

  describe('Google Play (downgrade with DEFERRED replacement)', () => {
    test('the current plan stays until Play switches it; the keep-list moves to the replacement row', async () => {
      const { truth } = fakes.installGoogleFakes({ 'tok-6': fakes.googlePurchase({ productId: plan6.androidProductId }) });
      await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-6', tenantId: tenant.id });
      const keep = [branches[0].id, branches[1].id, branches[2].id];
      await choose({ billingPlanId: plan3.id, keepBranchIds: keep });

      // Play records the deferred replacement on the current purchase.
      const withDeferred = fakes.googlePurchase({ productId: plan6.androidProductId });
      withDeferred.lineItems[0].deferredItemReplacement = { productId: plan3.androidProductId };
      truth['tok-6'] = withDeferred;
      await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-6', tenantId: tenant.id });
      let old = await rowFor('tok-6');
      expect(old.branchCount).toBe(6);
      expect(old.pendingChange).toMatchObject({ billingPlanId: plan3.id, branchCount: 3, keepBranchIds: keep, confirmedByProvider: true });

      // If Play hands the app a new token for the replacement before it starts,
      // it is not applied early.
      const future = fakes.googlePurchase({ productId: plan3.androidProductId, latestOrderId: 'GPA.3' });
      future.startTime = new Date(Date.now() + 20 * fakes.DAY).toISOString();
      future.linkedPurchaseToken = 'tok-6';
      truth['tok-3'] = future;
      await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-3', tenantId: tenant.id });
      expect(await rowFor('tok-3')).toBeNull();
      expect(await maxBranches()).toBe(6);

      // At renewal Play switches: the replacement is in effect.
      truth['tok-3'] = { ...future, startTime: new Date(Date.now() - 1000).toISOString() };
      truth['tok-6'] = fakes.googlePurchase({ productId: plan6.androidProductId, state: 'SUBSCRIPTION_STATE_EXPIRED', expiresInDays: 0 });
      await googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok-3', tenantId: tenant.id });
      const replacement = await rowFor('tok-3');
      expect(replacement.status).toBe('ACTIVE');
      expect(replacement.branchCount).toBe(3);
      expect(await maxBranches()).toBe(3);
      expect(replacement.pendingChange).toMatchObject({ billingPlanId: plan3.id, keepBranchIds: keep });
      expect(replacement.pendingChange.appliedAt).toBeTruthy();
      expect(await quota.getBranchesToKeep(tenant.id)).toEqual(keep);
      old = await rowFor('tok-6');
      expect(old.status).toBe('CANCELLED');
    });
  });
});
