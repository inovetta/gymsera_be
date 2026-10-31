/**
 * Phase 7 P8, NEW-146 (P2): no membership plan is invented for a host.
 *
 * Before:
 * - Approval provisioned a gym even when the submitted data had no plan travellers can see:
 *   `_createBranchRecord` got `allowDefaultPackage` and made "<branch> Membership" at 0
 *   (gym.service.js:340), and provisioning then added "Standard Membership" at 5,000, visible
 *   to travellers, when no ACTIVE plan existed (tenant-provisioning.service.js:605-626).
 * - An administrator adding a branch from the CMS (no plan fields) got the same free
 *   "<branch> Membership" plan, visible to travellers (admin.service.js createAdminTenantBranch).
 * After: approval refuses before anything changes (422 visible_plan_required); provisioning
 * creates only the host's own plans; an administrator's branch starts with no plan and is not
 * live until the host adds one (R-77).
 */
const { setupTestDatabases, teardownTestDatabases, getAdminConnection, factories } = require('../harness');
const { City, Tenant } = require('../../src/models/platform');
const adminService = require('../../src/services/admin.service');
const TenantDbManager = require('../../src/database/TenantDbManager');

const dbNames = [];
let admin;

const pendingTenant = async (key, mainBranchDataJson) => {
  const tenantCode = `test_p8n146_${key}_${Date.now().toString(36)}`;
  dbNames.push(`gymsera_${tenantCode}`);
  return factories.createTenant({
    tenantCode, status: 'PENDING_REVIEW', connectionStringEncrypted: null, paymentMethod: 'BANK_TRANSFER',
    mainBranchDataJson,
  });
};

beforeAll(async () => {
  await setupTestDatabases();
  await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
  admin = await factories.createUser({ email: 'admin-p8n146@gymsera.test', role: 'PLATFORM_ADMIN' });
});

afterAll(async () => {
  const conn = await getAdminConnection();
  for (const db of dbNames) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('NEW-146: no invented membership plan', () => {
  test.each([
    ['no plan at all', { name: 'Main', plans: [] }],
    ['only plans hidden from travellers', { name: 'Main', plans: [{ name: 'Staff only', price: 1000, isPublic: false }] }],
  ])('approval with %s: 422 visible_plan_required, nothing changes', async (_label, data) => {
    const tenant = await pendingTenant(_label.length, data);
    await expect(adminService.approveTenant(tenant.id, admin.id)).rejects.toMatchObject({
      statusCode: 422, code: 'visible_plan_required',
    });
    const after = await Tenant.findByPk(tenant.id);
    expect(after.status).toBe('PENDING_REVIEW');
    expect(after.connectionStringEncrypted).toBeNull();
  });

  test("approval with the host's plan creates exactly that plan, nothing else", async () => {
    const tenant = await pendingTenant('ok', { name: 'Main', plans: [{ name: 'Monthly', price: 3000 }] });
    await adminService.approveTenant(tenant.id, admin.id);
    await tenant.reload();
    expect(tenant.status).toBe('ACTIVE');
    const db = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
    const names = (await db.models.MembershipPlan.findAll()).map((p) => p.name);
    expect(names).toEqual(['Monthly']);

    // An administrator's branch (the CMS form sends no plan) starts with no plan.
    await factories.createTenantSubscription(tenant.id, { status: 'ACTIVE', branchCount: 5 });
    const { branch } = await adminService.createAdminTenantBranch(tenant.id, { branchName: 'Admin Branch', address: 'Somewhere 1', cityId: 1 }, admin.id);
    expect(await db.models.MembershipPlan.count({ where: { branchId: branch.id } })).toBe(0);
    expect((await db.models.MembershipPlan.findAll()).map((p) => p.name)).not.toContain('Admin Branch Membership');
  });
});
