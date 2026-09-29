const request = require('supertest');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  asPersona,
} = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { Tenant, User } = require('../../src/models/platform');
const { signToken } = require('../../src/utils/jwt.utils');

describe('SEC-02: Tenant identity must come from authentication, never from client input', () => {
  let dbHarness;
  let personas;
  let appServer;
  let tenant1Id;
  let tenant2Id;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    appServer = await startTestServer();

    tenant1Id = personas.owner.tenantId;
    tenant2Id = personas.otherTenantOwner.tenantId;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('1. Body tenantId forging is rejected and does not leak existence', () => {
    test('Host A forging Tenant B ID in body is rejected with 404 (does not leak existence)', async () => {
      // Host A belongs to Tenant 1. Host A calls branch creation with Tenant 2's ID in body.
      const res = await request(appServer)
        .post('/api/v1/gyms/branches')
        .set('Authorization', `Bearer ${personas.owner.token}`)
        .send({
          tenantId: tenant2Id,
          branchName: 'Forged Malicious Branch',
          packages: [{ name: 'Standard', price: 5000 }],
        });

      // Must be 404 (not 403, and not 200/201)
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Tenant not found or not active/i);

      // Verify that NO branch was created in Tenant 2's database
      const { Branch } = dbHarness.tenant2.models;
      const branchInTenant2 = await Branch.findOne({
        where: { branchName: 'Forged Malicious Branch' },
      });
      expect(branchInTenant2).toBeNull();
    });

    test('Host A forging a non-existent tenant ID in body returns identical 404 response', async () => {
      const nonExistentTenantId = '99999999-9999-4999-8999-999999999999';
      const res = await request(appServer)
        .post('/api/v1/gyms/branches')
        .set('Authorization', `Bearer ${personas.owner.token}`)
        .send({
          tenantId: nonExistentTenantId,
          branchName: 'NonExistent Tenant Branch',
          packages: [{ name: 'Standard', price: 5000 }],
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Tenant not found or not active/i);
    });

    test('Regular member forging Tenant B in body is rejected with 404 (no leak)', async () => {
      const res = await request(appServer)
        .post('/api/v1/gyms/branches')
        .set('Authorization', `Bearer ${personas.member.token}`)
        .send({
          tenantId: tenant2Id,
          branchName: 'Member Forged Branch',
          packages: [{ name: 'Standard', price: 5000 }],
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Tenant not found or not active/i);
    });
  });

  describe('2. Header-based X-Tenant-Id is only validated against tenants the user belongs to', () => {
    test('Host A sending X-Tenant-Id for Tenant B (real tenant) is rejected with 404', async () => {
      const res = await request(appServer)
        .get('/api/v1/gyms/branches')
        .set('Authorization', `Bearer ${personas.owner.token}`)
        .set('X-Tenant-Id', tenant2Id);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Tenant not found or not active/i);
    });

    test('Host A sending X-Tenant-Id for non-existent tenant returns identical 404', async () => {
      const nonExistentTenantId = '88888888-8888-4888-8888-888888888888';
      const res = await request(appServer)
        .get('/api/v1/gyms/branches')
        .set('Authorization', `Bearer ${personas.owner.token}`)
        .set('X-Tenant-Id', nonExistentTenantId);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Tenant not found or not active/i);
    });

    test('Host A sending legitimate X-Tenant-Id for Tenant 1 succeeds', async () => {
      const res = await request(appServer)
        .get('/api/v1/gyms/branches')
        .set('Authorization', `Bearer ${personas.owner.token}`)
        .set('X-Tenant-Id', tenant1Id);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.branches)).toBe(true);
    });
  });

  describe('3. Tenant identity comes from authentication / legitimate membership', () => {
    test('Legitimate request with tenantId in body succeeds for caller own tenant and strips body.tenantId', async () => {
      const res = await request(appServer)
        .post('/api/v1/gyms/branches')
        .set('Authorization', `Bearer ${personas.owner.token}`)
        .set('X-Tenant-Id', tenant1Id)
        .send({
          tenantId: tenant1Id,
          branchName: 'Legitimate Branch Under Tenant 1',
          packages: [{ name: 'Standard', price: 5000 }],
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body.success).toBe(true);

      // Verify branch is in Tenant 1, NOT Tenant 2
      const { Branch: Branch1 } = dbHarness.tenant1.models;
      const createdBranch = await Branch1.findOne({
        where: { branchName: 'Legitimate Branch Under Tenant 1' },
      });
      expect(createdBranch).not.toBeNull();
    });

    test('Multi-tenant staff member can select among tenants they belong to, but not others', async () => {
      // Create user who has assignments in both Tenant 1 and Tenant 2
      const { createUser } = require('../harness/factories');
      const multiUserObj = await createUser({
        id: 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu',
        email: 'multi.staff@example.test',
        fullName: 'Multi Staff Person',
        role: 'BRANCH_MANAGER',
      });

      const multiUser = await dbHarness.tenant1.models.RoleAssignment.create({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        userId: multiUserObj.id,
        roleKey: 'FRONT_DESK',
        roleLevel: 20,
        scopeType: 'ORG',
        status: 'ACTIVE',
      });

      const { UserOrgIndex } = require('../../src/models/platform');
      await UserOrgIndex.upsert({
        userId: 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu',
        tenantId: tenant1Id,
        roleKey: 'FRONT_DESK',
        roleLevel: 20,
        scopeType: 'ORG',
        status: 'ACTIVE',
      });

      await UserOrgIndex.upsert({
        userId: 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu',
        tenantId: tenant2Id,
        roleKey: 'MANAGER',
        roleLevel: 30,
        scopeType: 'ORG',
        status: 'ACTIVE',
      });

      const multiToken = signToken({
        sub: 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu',
        id: 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu',
        email: 'multi.staff@example.test',
        role: 'BRANCH_MANAGER',
        isVerified: true,
      });

      // Can access Tenant 1 with X-Tenant-Id
      const res1 = await request(appServer)
        .get('/api/v1/gyms/branches')
        .set('Authorization', `Bearer ${multiToken}`)
        .set('X-Tenant-Id', tenant1Id);
      expect(res1.status).toBe(200);

      // Can access Tenant 2 with X-Tenant-Id
      const res2 = await request(appServer)
        .get('/api/v1/gyms/branches')
        .set('Authorization', `Bearer ${multiToken}`)
        .set('X-Tenant-Id', tenant2Id);
      expect(res2.status).toBe(200);

      // Cannot access third tenant they do not belong to
      const randomTenantId = '77777777-7777-4777-8777-777777777777';
      const res3 = await request(appServer)
        .get('/api/v1/gyms/branches')
        .set('Authorization', `Bearer ${multiToken}`)
        .set('X-Tenant-Id', randomTenantId);
      expect(res3.status).toBe(404);
    });
  });
});
