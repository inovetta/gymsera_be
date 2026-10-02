'use strict';

/**
 * Regression tests for BILL-07 and BILL-09:
 * BILL-07: POST /billing/purchase-intent blocks cross-provider purchase if existing store sub is auto-renewing.
 * BILL-09: Flags duplicate billing on superseded subscription rows still reporting auto-renew, exposing banner to host.
 */

const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { Tenant, TenantSubscription, BillingPlan, User } = require('../../src/models/platform');
const { reconcileRenewalStatus } = require('../../src/services/subscription-migration.service');
const { signToken } = require('../../src/utils/jwt.utils');

describe('BILL-07 & BILL-09: Cross-Provider Intent & Duplicate Billing', () => {
  let appServer;
  let testHostUser;
  let hostToken;
  let testTenant;
  let plan1;
  let plan3;

  beforeAll(async () => {
    await setupTestDatabases();
    appServer = await startTestServer();

    testHostUser = await User.create({
      fullName: 'Billing Host',
      email: `billhost_${Date.now()}@example.test`,
      passwordHash: 'dummy',
      role: 'GYM_HOST',
      isHost: true,
      status: 'ACTIVE',
      isVerified: true,
      permissionVersion: 1,
    });

    testTenant = await Tenant.create({
      tenantCode: 'TEN-BILL-' + Date.now(),
      businessName: 'Billing Test Gym',
      ownerUserId: testHostUser.id,
      email: testHostUser.email,
      status: 'ACTIVE',
    });

    plan1 = await BillingPlan.create({
      branchCount: 1,
      monthlyPrice: 5000,
      annualPrice: 47999,
      currency: 'PKR',
    });

    plan3 = await BillingPlan.create({
      branchCount: 3,
      monthlyPrice: 15000,
      annualPrice: 144900,
      currency: 'PKR',
    });

    hostToken = signToken({
      sub: testHostUser.id,
      email: testHostUser.email,
      role: 'GYM_HOST',
      isVerified: true,
      isHost: true,
      tenantId: testTenant.id,
      ver: 1,
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('BILL-07: Purchase Intent Evaluation', () => {
    test('Returns action: new when tenant has no active subscription', async () => {
      const res = await request(appServer)
        .post('/api/v1/billing/purchase-intent')
        .set('Authorization', `Bearer ${hostToken}`)
        .send({
          tenantId: testTenant.id,
          targetPlatform: 'ANDROID',
          targetPlanId: plan1.id,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.action).toBe('new');
    });

    test('Blocks purchase intent when active subscription on another provider is still auto-renewing', async () => {
      // Create active IOS subscription with autoRenew = true
      const today = new Date().toISOString().split('T')[0];
      const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const iosSub = await TenantSubscription.create({
        tenantId: testTenant.id,
        billingPlanId: plan1.id,
        platform: 'IOS',
        status: 'ACTIVE',
        branchCount: 1,
        startDate: today,
        endDate: nextMonth,
        amount: 5000,
        billingCycle: 'MONTHLY',
        autoRenew: true,
        externalOriginalTransactionId: 'apple_orig_tx_123',
      });

      // Host attempts to purchase ANDROID subscription
      const res = await request(appServer)
        .post('/api/v1/billing/purchase-intent')
        .set('Authorization', `Bearer ${hostToken}`)
        .send({
          tenantId: testTenant.id,
          targetPlatform: 'ANDROID',
          targetPlanId: plan3.id,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.action).toBe('blocked');
      expect(res.body.data.reason).toBe('active_subscription_other_provider');
      expect(res.body.data.currentPlatform).toBe('IOS');
      expect(res.body.data.manageUrl).toContain('apps.apple.com');

      // Cleanup subscription for next tests
      await iosSub.destroy();
    });

    test('Allows upgrade when purchasing on same platform with higher branchCount', async () => {
      const today = new Date().toISOString().split('T')[0];
      const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const currentSub = await TenantSubscription.create({
        tenantId: testTenant.id,
        billingPlanId: plan1.id,
        platform: 'IOS',
        status: 'ACTIVE',
        branchCount: 1,
        startDate: today,
        endDate: nextMonth,
        amount: 5000,
        billingCycle: 'MONTHLY',
        autoRenew: true,
        externalOriginalTransactionId: 'apple_orig_tx_same',
      });

      const res = await request(appServer)
        .post('/api/v1/billing/purchase-intent')
        .set('Authorization', `Bearer ${hostToken}`)
        .send({
          tenantId: testTenant.id,
          targetPlatform: 'IOS',
          targetPlanId: plan3.id,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.action).toBe('upgrade');

      await currentSub.destroy();
    });
  });

  describe('BILL-09: Duplicate Billing Detection on Renewal', () => {
    test('Sets duplicateBilling=true on superseded row still reporting autoRenew', async () => {
      const pastStart = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const pastEnd = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      // Superseded old subscription row that provider reports is still auto-renewing
      const supersededSub = await TenantSubscription.create({
        tenantId: testTenant.id,
        billingPlanId: plan1.id,
        platform: 'IOS',
        status: 'CANCELLED',
        branchCount: 1,
        startDate: pastStart,
        endDate: pastEnd,
        amount: 5000,
        billingCycle: 'MONTHLY',
        autoRenew: true,
        duplicateBilling: false,
        externalOriginalTransactionId: 'apple_superseded_orig_tx',
      });

      // Active replacement subscription row
      const currentStart = new Date().toISOString().split('T')[0];
      const currentEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const activeSub = await TenantSubscription.create({
        tenantId: testTenant.id,
        billingPlanId: plan3.id,
        platform: 'ANDROID',
        status: 'ACTIVE',
        branchCount: 3,
        startDate: currentStart,
        endDate: currentEnd,
        amount: 15000,
        billingCycle: 'MONTHLY',
        autoRenew: true,
        duplicateBilling: false,
        externalOriginalTransactionId: 'google_active_orig_tx',
      });

      // Provider sync reports old subscription still renewing
      const { sequelize } = require('../../src/database/platform');
      const tx = await sequelize.transaction();
      let res;
      try {
        res = await reconcileRenewalStatus(
          testTenant.id,
          supersededSub,
          { status: 'ACTIVE', autoRenew: true },
          { transaction: tx }
        );
        await supersededSub.update(res, { transaction: tx });
        await tx.commit();
      } catch (err) {
        if (!tx.finished) await tx.rollback();
        throw err;
      }
      expect(res.duplicateBilling).toBe(true);

      await supersededSub.reload();
      expect(supersededSub.duplicateBilling).toBe(true);

      // Verify host controller reports duplicate billing banner
      const hostRes = await request(appServer)
        .get('/api/v1/host/subscription/current')
        .set('Authorization', `Bearer ${hostToken}`);

      expect(hostRes.status).toBe(200);
      expect(hostRes.body.data.duplicateBilling).toBe(true);
      expect(hostRes.body.data.duplicateBillingPlatform).toBe('IOS');
      expect(hostRes.body.data.duplicateBillingManageUrl).toContain('apps.apple.com');

      await supersededSub.destroy();
      await activeSub.destroy();
    });
  });
});
