/**
 * P5b item 1 (R-81 revised) — can a GYM_HOST of tenant A reach the delete routes of tenant B?
 *
 * authorize.js:16 passes on `roles.includes(req.user.role)`, and the token's role is the
 * account role (GYM_HOST for anyone who owns a gym). The question is whether any host
 * route lets that account-level role act inside a gym the caller does not own.
 *
 * Persona: host A owns tenant 2 (persona otherTenantOwner) and is also a branch MANAGER
 * at tenant 1. Host C owns a gym and has no role at tenant 1 at all. The token is the
 * one auth.service issues (role GYM_HOST, tenantId = the gym the caller owns).
 *
 * Routes behind tenantContext get their role rewritten per tenant (applyLegacyRoleShim:
 * GYM_HOST only where the caller is the owner), and routes without it act on the token's
 * tenant, which for a GYM_HOST is always their own (auth.service.js _buildTokenPayload).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');

let dbHarness;
let personas;
let ctx;

const PASSWORD = 'Test@12345';

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  const { personaManager } = require('../harness/personas');
  ctx = personaManager.context;

  // Host A (owner of tenant 2) is also a branch manager at tenant 1.
  const hostA = personas.otherTenantOwner.user;
  await factories.createRoleAssignment(dbHarness.tenant1, {
    userId: hostA.id,
    roleKey: 'BRANCH_MANAGER',
    scopeType: 'BRANCH',
    scopeId: ctx.branch1.id,
    branchIds: [ctx.branch1.id],
    overrides: { tenantId: ctx.tenant1.id },
  });

  // A token for host A that names tenant 1 (stale, or edited by hand): the role in it is
  // still the account role GYM_HOST.
  personas.hostAAtTenant1Token = {
    user: hostA,
    token: signToken({ sub: hostA.id, id: hostA.id, email: hostA.email, role: 'GYM_HOST', isVerified: true, tenantId: ctx.tenant1.id }),
  };

  // Host C owns a gym of their own and has no role at tenant 1.
  const hostC = await factories.createUser({ role: 'GYM_HOST', email: 'host-c@p5b.test', fullName: 'Host C' });
  const tenantC = await factories.createTenant({
    tenantCode: 'GYM-P5BC',
    gymName: 'Host C Gym',
    ownerUserId: hostC.id,
    connectionStringEncrypted: dbHarness.tenant2.encryptedConnStr,
  });
  personas.hostC = {
    user: hostC,
    tenantId: tenantC.id,
    token: signToken({ sub: hostC.id, id: hostC.id, email: hostC.email, role: 'GYM_HOST', isVerified: true, tenantId: tenantC.id }),
  };
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const branch1Status = async () => (await dbHarness.tenant1.models.Branch.findByPk(ctx.branch1.id)).status;
const listing1Status = async () => {
  const { GymListing } = require('../../src/models/platform');
  return (await GymListing.findByPk(ctx.listing1.id)).status;
};

describe('P5b item 1: a GYM_HOST of another tenant cannot delete tenant 1 branches or organizations', () => {
  test('host A (manager at tenant 1) with X-Tenant-Id tenant 1: DELETE branch is 403', async () => {
    const res = await asPersona('otherTenantOwner', { 'X-Tenant-Id': ctx.tenant1.id })
      .delete(`/gyms/branches/${ctx.branch1.id}`, { password: PASSWORD, confirmOrganizationDeletion: true });
    expect(res.status).toBe(403);
    expect(await branch1Status()).toBe('ACTIVE');
  });

  test('host A with a token that names tenant 1 and no header: DELETE branch is 403', async () => {
    const res = await asPersona('hostAAtTenant1Token')
      .delete(`/gyms/branches/${ctx.branch1.id}`, { password: PASSWORD, confirmOrganizationDeletion: true });
    expect(res.status).toBe(403);
    expect(await branch1Status()).toBe('ACTIVE');
  });

  test('host A in their own tenant: tenant 1 branch is not found there (404)', async () => {
    const res = await asPersona('otherTenantOwner')
      .delete(`/gyms/branches/${ctx.branch1.id}`, { password: PASSWORD, confirmOrganizationDeletion: true });
    expect(res.status).toBe(404);
    expect(await branch1Status()).toBe('ACTIVE');
  });

  test('host A with X-Tenant-Id tenant 1: DELETE organization is 403', async () => {
    const res = await asPersona('otherTenantOwner', { 'X-Tenant-Id': ctx.tenant1.id })
      .delete(`/host/listings/${ctx.listing1.id}`, { password: PASSWORD });
    expect(res.status).toBe(403);
    expect(await listing1Status()).toBe('ACTIVE');
  });

  test('host C (no role at tenant 1) with X-Tenant-Id tenant 1: 404, existence not leaked', async () => {
    const branch = await asPersona('hostC', { 'X-Tenant-Id': ctx.tenant1.id })
      .delete(`/gyms/branches/${ctx.branch1.id}`, { password: PASSWORD, confirmOrganizationDeletion: true });
    expect(branch.status).toBe(404);
    const org = await asPersona('hostC', { 'X-Tenant-Id': ctx.tenant1.id })
      .delete(`/host/listings/${ctx.listing1.id}`, { password: PASSWORD });
    expect(org.status).toBe(404);
    expect(await branch1Status()).toBe('ACTIVE');
    expect(await listing1Status()).toBe('ACTIVE');
  });
});

describe('P5b item 1: host routes without tenantContext act on the caller\'s own tenant only', () => {
  test('GET /host/subscription/current with X-Tenant-Id tenant 1 answers for host A\'s own plan', async () => {
    const res = await asPersona('otherTenantOwner', { 'X-Tenant-Id': ctx.tenant1.id }).get('/host/subscription/current');
    expect(res.status).toBe(200);
    expect(res.body.data.tenantId).toBe(ctx.tenant2.id);
  });

  test('reserved-slot transfer out of a tenant 1 organization is 404', async () => {
    const { GymListing } = require('../../src/models/platform');
    const before = (await GymListing.findByPk(ctx.listing1.id)).reservedSlots;
    const res = await asPersona('otherTenantOwner', { 'X-Tenant-Id': ctx.tenant1.id })
      .post(`/host/listings/${ctx.listing1.id}/reserved-slots/transfer`, { toListingId: ctx.listing2.id, count: 1 });
    expect(res.status).toBe(404);
    expect((await GymListing.findByPk(ctx.listing1.id)).reservedSlots).toBe(before);
  });
});

describe('P5b item 1: the real owner still gets through authorization', () => {
  test('owner of tenant 1 reaches the password check (401 on a wrong password, branch kept)', async () => {
    const res = await asPersona('owner').delete(`/gyms/branches/${ctx.branch1.id}`, { password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(await branch1Status()).toBe('ACTIVE');
  });

  test('branch manager of tenant 1 is refused delete (owner only)', async () => {
    const res = await asPersona('manager').delete(`/gyms/branches/${ctx.branch1.id}`, { password: PASSWORD });
    expect(res.status).toBe(403);
    expect(await branch1Status()).toBe('ACTIVE');
  });
});
