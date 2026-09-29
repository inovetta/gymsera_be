const request = require('supertest');
const fs = require('fs');
const path = require('path');
const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
  asPersona,
} = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { Tenant, TenantSubscription, PlatformInvoice } = require('../../src/models/platform');
const { TenantStatus } = require('../../src/constants/subscription-status');
const { safeRedisGet, safeRedisSetex, safeRedisDel } = require('../../src/config/redis.config');
const adminService = require('../../src/services/admin.service');
const subscriptionMigrationService = require('../../src/services/subscription-migration.service');
const { runExpiryCheck } = require('../../src/jobs/subscription-expiry.cron');
const TenantDbManager = require('../../src/database/TenantDbManager');

describe('NEW-26: Suspended Tenant Full Blocking and Admin Exception', () => {
  let dbHarness;
  let personas;
  let tenant1Record;
  let server;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenant1Record = personas.owner.tenantId;
    server = await startTestServer();
    await safeRedisDel(`tenant:${tenant1Record}:connStr`);
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('1. Source Code Guard against future bypasses', () => {
    const srcDir = path.resolve(__dirname, '../../src');

    test('tenantContext.js must require status: ACTIVE only and must not accept SUSPENDED', () => {
      const tenantContextPath = path.join(srcDir, 'middleware/tenantContext.js');
      const content = fs.readFileSync(tenantContextPath, 'utf8');

      // Must NOT include SUSPENDED in status query
      expect(content).not.toMatch(/status:\s*\[['"]ACTIVE['"],\s*['"]SUSPENDED['"]\]/);
      expect(content).not.toMatch(/status:\s*\[['"]SUSPENDED['"],\s*['"]ACTIVE['"]\]/);

      // Must require status: 'ACTIVE' or status: TenantStatus.ACTIVE
      const hasActiveOnly =
        /where:\s*\{[^}]*status:\s*['"]ACTIVE['"][^}]*\}/s.test(content) ||
        /where:\s*\{[^}]*status:\s*TenantStatus\.ACTIVE[^}]*\}/s.test(content);
      expect(hasActiveOnly).toBe(true);
    });

    test('tenant.service.js#updateMyTenant must check that tenant status is ACTIVE', () => {
      const tenantServicePath = path.join(srcDir, 'services/tenant.service.js');
      const content = fs.readFileSync(tenantServicePath, 'utf8');

      // updateMyTenant must have an ACTIVE status check
      const updateMyTenantBlock = content.slice(content.indexOf('updateMyTenant = async'));
      const fnEnd = updateMyTenantBlock.indexOf('finalizeApplication = async');
      const fnBody = updateMyTenantBlock.slice(0, fnEnd);

      expect(fnBody).toMatch(/status.*ACTIVE/);
    });

    test('subscription-expiry.cron.js must skip non-ACTIVE tenants in reconciliation and iteration', () => {
      const cronPath = path.join(srcDir, 'jobs/subscription-expiry.cron.js');
      const content = fs.readFileSync(cronPath, 'utf8');

      // Must check tenant status when reconciling capacity or iterating DBs
      expect(content).toMatch(/tenant\.status !== ['"]ACTIVE['"]/);
    });

    test('All tenant-scoped mutating routers must mount tenantContext middleware', () => {
      const routesDir = path.join(srcDir, 'routes');
      const tenantScopedRouters = [
        'gyms.routes.js',
        'payments.routes.js',
        'invoices.routes.js',
        'actions.routes.js',
        'approvals.routes.js',
        'team.routes.js',
        'ledger.routes.js',
        'trainers.routes.js',
        'reports.routes.js',
        'member.routes.js',
      ];

      for (const routeFile of tenantScopedRouters) {
        const filePath = path.join(routesDir, routeFile);
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).toContain('tenantContext');
      }
    });
  });

  describe('2. Suspended tenant blocked on tenant-scoped routes with 404', () => {
    let tenant;

    beforeEach(async () => {
      tenant = await Tenant.findByPk(tenant1Record);
      await tenant.update({ status: TenantStatus.ACTIVE });
      await safeRedisDel(`tenant:${tenant1Record}:connStr`);
    });

    test('A SUSPENDED tenant hitting members, payments, branches, team, ledger, approvals -> 404', async () => {
      // Suspend tenant via admin service
      await adminService.suspendTenant(tenant1Record, personas.platformAdmin.user.id, 'Policy violation test');

      const expectedBody = {
        success: false,
        message: 'Tenant not found or not active',
      };

      // 1. Members
      const membersRes = await asPersona('owner').get('/gyms/members');
      expect(membersRes.status).toBe(404);
      expect(membersRes.body).toEqual(expectedBody);

      // 2. Payments
      const paymentsRes = await asPersona('owner').get('/payments');
      expect(paymentsRes.status).toBe(404);
      expect(paymentsRes.body).toEqual(expectedBody);

      // 3. Branches (gyms)
      const branchesRes = await asPersona('owner').get('/gyms/branches');
      expect(branchesRes.status).toBe(404);
      expect(branchesRes.body).toEqual(expectedBody);

      // 4. Team & Access
      const teamRes = await asPersona('owner').get('/team/meta/roles');
      expect(teamRes.status).toBe(404);
      expect(teamRes.body).toEqual(expectedBody);

      // 5. Ledger
      const ledgerRes = await asPersona('owner').get('/ledger/today');
      expect(ledgerRes.status).toBe(404);
      expect(ledgerRes.body).toEqual(expectedBody);

      // 6. Approvals
      const approvalsRes = await asPersona('owner').get('/approvals');
      expect(approvalsRes.status).toBe(404);
      expect(approvalsRes.body).toEqual(expectedBody);
    });

    test('Suspending an ACTIVE tenant with warm cached connection -> very next request is blocked immediately', async () => {
      // 1. Warm the cache while ACTIVE
      await tenant.update({ status: TenantStatus.ACTIVE });
      const warmRes = await asPersona('owner').get('/gyms/branches');
      expect(warmRes.status).toBe(200);

      // Verify connection string is in Redis
      const cacheKey = `tenant:${tenant1Record}:connStr`;
      const cached = await safeRedisGet(cacheKey);
      expect(cached).toBeTruthy();

      // 2. Suspend tenant via adminService
      await adminService.suspendTenant(tenant1Record, personas.platformAdmin.user.id, 'Immediate suspension');

      // 3. Verify Redis key is invalidated immediately
      const cachedAfterSuspend = await safeRedisGet(cacheKey);
      expect(cachedAfterSuspend).toBeNull();

      // 4. Very next request must return 404 (not after 1 hour)
      const nextRes = await asPersona('owner').get('/gyms/branches');
      expect(nextRes.status).toBe(404);
      expect(nextRes.body).toEqual({
        success: false,
        message: 'Tenant not found or not active',
      });
    });

    test('updateMyTenant (PATCH /tenants/me) is blocked for a suspended tenant', async () => {
      // Ensure suspended
      await tenant.update({ status: TenantStatus.SUSPENDED });

      const res = await asPersona('owner').patch('/tenants/me', {
        businessName: 'Illegal Suspended Update',
      });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        success: false,
        message: 'Tenant not found or not active',
      });

      // Verify name in DB was NOT changed
      await tenant.reload();
      expect(tenant.businessName).not.toBe('Illegal Suspended Update');
    });
  });

  describe('3. Renewal webhooks for suspended tenant: record but do not entitle', () => {
    let tenant;

    beforeEach(async () => {
      tenant = await Tenant.findByPk(tenant1Record);
      await tenant.update({ status: TenantStatus.SUSPENDED });
    });

    test('Renewal webhook updates TenantSubscription for audit/history but does not entitle or unlock', async () => {
      // Create initial subscription for this tenant
      const initialSub = await factories.createTenantSubscription(tenant1Record, {
        platform: 'IOS',
        status: 'ACTIVE',
        branchCount: 3,
        externalOriginalTransactionId: 'orig-tx-suspended-1',
        externalTransactionId: 'tx-suspended-1',
        endDate: '2026-09-01T00:00:00.000Z',
      });

      // Provider sends renewal: new transaction ID, pushed end date
      const renewed = await subscriptionMigrationService.applyVerifiedSubscription(
        tenant1Record,
        {
          platform: 'IOS',
          externalOriginalTransactionId: 'orig-tx-suspended-1',
          externalTransactionId: 'tx-suspended-renewed-2',
          billingPlanId: initialSub.billingPlanId,
          branchCount: 3,
          status: 'ACTIVE',
          endDate: '2026-10-01T00:00:00.000Z',
          chargedAmount: 15000,
          chargedCurrency: 'PKR',
        },
        { idempotencyPrefix: 'apple-renewal-test' }
      );

      // 1. Subscription row IS updated (recorded for audit/history)
      expect(renewed.externalTransactionId).toBe('tx-suspended-renewed-2');
      expect(new Date(renewed.endDate).getTime()).toBe(new Date('2026-10-01T00:00:00.000Z').getTime());

      // 2. But tenant MUST remain SUSPENDED (no reactivation or unearned entitlement)
      await tenant.reload();
      expect(tenant.status).toBe(TenantStatus.SUSPENDED);

      // 3. Requests remain blocked 404
      const res = await asPersona('owner').get('/gyms/branches');
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Tenant not found or not active');
    });
  });

  describe('4. Nightly cron skips suspended tenants', () => {
    test('Nightly cron does not touch suspended tenant connections or revive status', async () => {
      const tenant = await Tenant.findByPk(tenant1Record);
      await tenant.update({ status: TenantStatus.SUSPENDED });

      // Warm pool with an entry for tenant1
      await TenantDbManager.getConnection(tenant1Record, tenant.connectionStringEncrypted);
      expect(TenantDbManager.getAllEntries().some(([id]) => id === tenant1Record)).toBe(true);

      // Run nightly expiry check
      await runExpiryCheck();

      // Tenant remains SUSPENDED
      await tenant.reload();
      expect(tenant.status).toBe(TenantStatus.SUSPENDED);

      // Requests remain blocked 404
      const res = await asPersona('owner').get('/gyms/branches');
      expect(res.status).toBe(404);
    });
  });

  describe('5. Reactivation restores normal access', () => {
    test('Reactivating a tenant restores access on the very next request', async () => {
      const tenant = await Tenant.findByPk(tenant1Record);
      await tenant.update({ status: TenantStatus.SUSPENDED });

      // Verify blocked
      const blockedRes = await asPersona('owner').get('/gyms/branches');
      expect(blockedRes.status).toBe(404);

      // Admin reactivates
      await adminService.reactivateTenant(tenant1Record, personas.platformAdmin.user.id);

      // Next request succeeds
      const restoredRes = await asPersona('owner').get('/gyms/branches');
      expect(restoredRes.status).toBe(200);
      expect(restoredRes.body.success).toBe(true);
    });
  });

  describe('6. Platform admin routes work for suspended tenants', () => {
    test('Platform admin can still read suspended tenant details, branches, and members', async () => {
      const tenant = await Tenant.findByPk(tenant1Record);
      await tenant.update({ status: TenantStatus.ACTIVE });
      await adminService.suspendTenant(tenant1Record, personas.platformAdmin.user.id, 'Admin read test');

      // 1. Admin reads tenant details
      const tenantRes = await asPersona('platformAdmin').get(`/admin/tenants/${tenant1Record}`);
      expect(tenantRes.status).toBe(200);
      expect(tenantRes.body.success).toBe(true);
      expect(tenantRes.body.data.tenant.id).toBe(tenant1Record);
      expect(tenantRes.body.data.tenant.status).toBe(TenantStatus.SUSPENDED);

      // 2. Admin reads tenant branches
      const branchesRes = await asPersona('platformAdmin').get(`/admin/tenants/${tenant1Record}/branches`);
      expect(branchesRes.status).toBe(200);
      expect(branchesRes.body.success).toBe(true);
      expect(Array.isArray(branchesRes.body.data.branches)).toBe(true);

      // 3. Admin reads tenant members
      const membersRes = await asPersona('platformAdmin').get(`/admin/tenants/${tenant1Record}/members`);
      expect(membersRes.status).toBe(200);
      expect(membersRes.body.success).toBe(true);
      expect(Array.isArray(membersRes.body.data.members)).toBe(true);
    });
  });
});
