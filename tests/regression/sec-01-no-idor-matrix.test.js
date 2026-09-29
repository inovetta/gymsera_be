const request = require('supertest');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
} = require('../harness');
const { personaManager } = require('../harness/personas');
const { startTestServer } = require('../harness/test-server');
const { createUser, createBranch } = require('../harness/factories');
const { UserGymMembership } = require('../../src/models/platform');
const { signToken } = require('../../src/utils/jwt.utils');

describe('SEC-01: No IDOR (Insecure Direct Object Reference) Matrix', () => {
  let dbHarness;
  let personas;
  let appServer;
  let ctx;

  let tenant1Member;
  let tenant2Member;
  let tenant1Branch1;
  let tenant1Branch2;
  let tenant2Branch;

  let tenant1PaymentBranch1;
  let tenant1PaymentBranch2;
  let tenant2Payment;

  let tenant1SubBranch1;
  let tenant1SubBranch2;
  let tenant2Sub;

  let tenant1Invoice;
  let tenant2Invoice;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    appServer = await startTestServer();
    ctx = personaManager.context;

    const { tenant1Db, tenant2Db } = ctx;

    // Create a 2nd branch in Tenant 1 for branch-scoping tests
    tenant1Branch1 = ctx.branch1;
    tenant1Branch2 = await createBranch(tenant1Db, ctx.listing1.id, {
      name: 'Uptown Branch 2',
    });
    tenant2Branch = ctx.branch2;

    // Create distinct members
    tenant1Member = await createUser({
      role: 'MEMBER',
      email: 'member.t1@test.com',
      fullName: 'Tenant 1 Member',
    });
    tenant2Member = await createUser({
      role: 'MEMBER',
      email: 'member.t2@test.com',
      fullName: 'Tenant 2 Member',
    });

    // Seed MemberProfile in tenant DBs
    await tenant1Db.models.MemberProfile.create({
      userId: tenant1Member.id,
      emergencyContactName: 'Contact T1',
    });
    await tenant2Db.models.MemberProfile.create({
      userId: tenant2Member.id,
      emergencyContactName: 'Contact T2',
    });

    // Seed membership plans
    const gym1 = (await tenant1Db.models.Gym.findOne()) || (await tenant1Db.models.Gym.create({ name: 'Alpha Gym', genderType: 'MIXED' }));
    const gym2 = (await tenant2Db.models.Gym.findOne()) || (await tenant2Db.models.Gym.create({ name: 'Beta Gym', genderType: 'MIXED' }));

    const planT1 = await tenant1Db.models.MembershipPlan.create({
      gymId: gym1.id,
      name: 'Plan T1',
      price: 1000,
      durationType: 'MONTHLY',
      durationValue: 1,
      status: 'ACTIVE',
    });
    const planT2 = await tenant2Db.models.MembershipPlan.create({
      gymId: gym2.id,
      name: 'Plan T2',
      price: 2000,
      durationType: 'MONTHLY',
      durationValue: 1,
      status: 'ACTIVE',
    });

    // Seed subscriptions
    tenant1SubBranch1 = await tenant1Db.models.MemberSubscription.create({
      userId: tenant1Member.id,
      membershipPlanId: planT1.id,
      branchId: tenant1Branch1.id,
      status: 'ACTIVE',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    await UserGymMembership.create({
      userId: tenant1Member.id,
      tenantId: ctx.tenant1.id,
      gymListingId: ctx.listing1.id,
      subscriptionId: tenant1SubBranch1.id,
      status: 'ACTIVE',
    });

    tenant1SubBranch2 = await tenant1Db.models.MemberSubscription.create({
      userId: tenant1Member.id,
      membershipPlanId: planT1.id,
      branchId: tenant1Branch2.id,
      status: 'ACTIVE',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    await UserGymMembership.create({
      userId: tenant1Member.id,
      tenantId: ctx.tenant1.id,
      gymListingId: ctx.listing1.id,
      subscriptionId: tenant1SubBranch2.id,
      status: 'ACTIVE',
    });

    tenant2Sub = await tenant2Db.models.MemberSubscription.create({
      userId: tenant2Member.id,
      membershipPlanId: planT2.id,
      branchId: tenant2Branch.id,
      status: 'ACTIVE',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    await UserGymMembership.create({
      userId: tenant2Member.id,
      tenantId: ctx.tenant2.id,
      gymListingId: ctx.listing2.id,
      subscriptionId: tenant2Sub.id,
      status: 'ACTIVE',
    });

    // Seed payments
    tenant1PaymentBranch1 = await tenant1Db.models.Payment.create({
      userId: tenant1Member.id,
      branchId: tenant1Branch1.id,
      amount: 1000,
      currency: 'PKR',
      method: 'CASH',
      status: 'PENDING',
    });
    tenant1PaymentBranch2 = await tenant1Db.models.Payment.create({
      userId: tenant1Member.id,
      branchId: tenant1Branch2.id,
      amount: 1000,
      currency: 'PKR',
      method: 'CASH',
      status: 'PENDING',
    });
    tenant2Payment = await tenant2Db.models.Payment.create({
      userId: tenant2Member.id,
      branchId: tenant2Branch.id,
      amount: 2000,
      currency: 'PKR',
      method: 'CASH',
      status: 'PENDING',
    });

    // Seed invoices
    tenant1Invoice = await tenant1Db.models.Invoice.create({
      userId: tenant1Member.id,
      branchId: tenant1Branch1.id,
      invoiceNo: 'INV-T1-001',
      subtotal: 1000,
      totalAmount: 1000,
      status: 'ISSUED',
      dueDate: '2026-12-31',
    });
    tenant2Invoice = await tenant2Db.models.Invoice.create({
      userId: tenant2Member.id,
      branchId: tenant2Branch.id,
      invoiceNo: 'INV-T2-001',
      subtotal: 2000,
      totalAmount: 2000,
      status: 'ISSUED',
      dueDate: '2026-12-31',
    });

    tenant1MemberToken = signToken({
      id: tenant1Member.id,
      sub: tenant1Member.id,
      email: tenant1Member.email,
      role: 'MEMBER',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('1. Member Personal Data IDOR Scoping (/users/:id)', () => {
    test('Host A reading Tenant B member detail (/users/:id) returns 404 (not 200 or 403)', async () => {
      const res = await request(appServer)
        .get(`/api/v1/users/${tenant2Member.id}`)
        .set('Authorization', `Bearer ${personas.owner.token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/user not found/i);
    });

    test('Host A updating Tenant B member info (PUT /users/:id) returns 404', async () => {
      const res = await request(appServer)
        .put(`/api/v1/users/${tenant2Member.id}`)
        .set('Authorization', `Bearer ${personas.owner.token}`)
        .send({ fullName: 'Malicious Name Tamper' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('Host A resetting Tenant B member password (/users/:id/password) returns 404', async () => {
      const res = await request(appServer)
        .post(`/api/v1/users/${tenant2Member.id}/password`)
        .set('Authorization', `Bearer ${personas.owner.token}`)
        .send({ newPassword: 'NewPassword123!' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('Host A requesting Tenant B member account statement returns 404', async () => {
      const res = await request(appServer)
        .get(`/api/v1/users/${tenant2Member.id}/account-statement`)
        .set('Authorization', `Bearer ${personas.owner.token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe('2. Subscriptions IDOR Scoping', () => {
    test('Cross-tenant staff subscription read (/subscriptions/staff/:id) returns 404', async () => {
      const res = await request(appServer)
        .get(`/api/v1/subscriptions/staff/${tenant2Sub.id}`)
        .set('Authorization', `Bearer ${personas.owner.token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('Cross-tenant staff subscription activation (/subscriptions/staff/:id/activate) returns 404', async () => {
      const res = await request(appServer)
        .post(`/api/v1/subscriptions/staff/${tenant2Sub.id}/activate`)
        .set('Authorization', `Bearer ${personas.owner.token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('Member A attempting to read Member B subscription detail (/subscriptions/:id/detail) returns 404', async () => {
      const res = await request(appServer)
        .get(`/api/v1/subscriptions/${tenant2Sub.id}/detail`)
        .set('Authorization', `Bearer ${tenant1MemberToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('Branch-scoped Manager reading subscription of unassigned branch returns 404', async () => {
      // Manager is scoped to branch1 only; tenant1SubBranch2 is at branch2
      const res = await request(appServer)
        .get(`/api/v1/subscriptions/staff/${tenant1SubBranch2.id}`)
        .set('Authorization', `Bearer ${personas.manager.token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe('3. Payments & Invoices IDOR Scoping (404, never 403)', () => {
    test('Host A reading Tenant B payment (/payments/:id) returns 404', async () => {
      const res = await request(appServer)
        .get(`/api/v1/payments/${tenant2Payment.id}`)
        .set('Authorization', `Bearer ${personas.owner.token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('Branch-scoped Manager reading Payment of unassigned branch returns 404 (NOT 403)', async () => {
      // Manager is assigned to branch1 only; tenant1PaymentBranch2 belongs to branch2
      const res = await request(appServer)
        .get(`/api/v1/payments/${tenant1PaymentBranch2.id}`)
        .set('Authorization', `Bearer ${personas.manager.token}`);

      // Must be 404 to avoid leaking payment existence!
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Payment not found/i);
    });

    test('Branch-scoped Manager verifying Payment of unassigned branch returns 404 (NOT 403)', async () => {
      const res = await request(appServer)
        .post(`/api/v1/payments/${tenant1PaymentBranch2.id}/verify`)
        .set('Authorization', `Bearer ${personas.manager.token}`)
        .send({ notes: 'Unauthorized verify attempt' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Payment not found/i);
    });

    test('Host A reading Tenant B invoice (/invoices/:id) returns 404', async () => {
      const res = await request(appServer)
        .get(`/api/v1/invoices/${tenant2Invoice.id}`)
        .set('Authorization', `Bearer ${personas.owner.token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('Member reading another member invoice (/invoices/:id) returns 404', async () => {
      const res = await request(appServer)
        .get(`/api/v1/invoices/${tenant2Invoice.id}`)
        .set('Authorization', `Bearer ${tenant1MemberToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe('4. Branch IDOR Scoping', () => {
    test('Host A reading Tenant B branch (/gyms/branches/:id) returns 404', async () => {
      const res = await request(appServer)
        .get(`/api/v1/gyms/branches/${tenant2Branch.id}`)
        .set('Authorization', `Bearer ${personas.owner.token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('Branch-scoped Manager reading unassigned branch returns 404 (NOT 200 or 403)', async () => {
      // Manager is assigned to branch1 only; branch2 is in same tenant but unassigned
      const res = await request(appServer)
        .get(`/api/v1/gyms/branches/${tenant1Branch2.id}`)
        .set('Authorization', `Bearer ${personas.manager.token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });
});
