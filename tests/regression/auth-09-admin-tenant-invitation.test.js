'use strict';

/**
 * Regression test for AUTH-09:
 * Admin "add tenant" links or creates accounts by email with no ownership proof.
 *
 * Requirements:
 * 1. Admin POST /admin/tenants does NOT auto-create a verified user or auto-link an existing user.
 * 2. It sends an invitation with a secure token to the owner email and records an audit log.
 * 3. The recipient must accept the invitation via token, proving ownership of the email.
 * 4. Only upon acceptance is the Tenant created and linked to the owner.
 * 5. Reusing or forging the invitation token is rejected.
 */

const request = require('supertest');
const { startTestServer } = require('../harness/test-server');
const { setupTestDatabases, teardownTestDatabases } = require('../harness/test-db');
const { User, Tenant, TenantInvitation, PlatformAuditLog } = require('../../src/models/platform');
const { createUser } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');

describe('AUTH-09: Admin "add tenant" invitation flow', () => {
  let appServer;
  let adminToken;
  let adminUser;

  beforeAll(async () => {
    await setupTestDatabases();
    appServer = await startTestServer();

    adminUser = await createUser({
      role: 'PLATFORM_ADMIN',
      email: `admin_${Date.now()}@example.test`,
      fullName: 'System Administrator',
    });
    adminToken = signToken({
      sub: adminUser.id,
      email: adminUser.email,
      role: 'PLATFORM_ADMIN',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('Admin creating a tenant sends an invitation and does NOT auto-create/auto-link accounts directly', async () => {
    const ownerEmail = `invite_new_${Date.now()}@example.test`;
    const businessName = 'Iron Peak Gym';

    const res = await request(appServer)
      .post('/api/v1/admin/tenants')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ownerEmail,
        ownerFullName: 'Iron Owner',
        ownerPhone: '+923001234567',
        businessName,
        email: `biz_${Date.now()}@example.test`,
        phone: '+923007654321',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    // 1. User must NOT be auto-created as an active verified account yet
    const userInDb = await User.findOne({ where: { email: ownerEmail } });
    expect(userInDb).toBeNull();

    // 2. Tenant must NOT be created yet without owner proof
    const tenantInDb = await Tenant.findOne({ where: { businessName } });
    expect(tenantInDb).toBeNull();

    // 3. A TenantInvitation record must exist in DB with token hashed at rest
    const invitation = await TenantInvitation.findOne({ where: { ownerEmail } });
    expect(invitation).not.toBeNull();
    expect(invitation.status).toBe('PENDING');
    expect(invitation.tokenHash).toHaveLength(64);
    expect(invitation.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // 4. Admin action must be audited
    const audit = await PlatformAuditLog.findOne({
      where: {
        action: 'admin.tenant_invited',
        targetId: invitation.id,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(adminUser.id);
  });

  test('Admin inviting an existing MEMBER does NOT auto-upgrade role or link tenant before acceptance', async () => {
    const existingMemberUser = await createUser({
      role: 'MEMBER',
      email: `existing_member_${Date.now()}@example.test`,
      fullName: 'Regular Member',
    });
    const businessName = 'Silver Peak Gym';

    const res = await request(appServer)
      .post('/api/v1/admin/tenants')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ownerEmail: existingMemberUser.email,
        ownerFullName: existingMemberUser.fullName,
        businessName,
        email: `biz_${Date.now()}@example.test`,
      });

    expect(res.status).toBe(201);

    // Reload member: role must STILL be MEMBER (not upgraded to GYM_HOST without their consent)
    await existingMemberUser.reload();
    expect(existingMemberUser.role).toBe('MEMBER');

    // Tenant must NOT be created yet
    const tenantInDb = await Tenant.findOne({ where: { businessName } });
    expect(tenantInDb).toBeNull();
  });

  test('Recipient proves ownership by accepting invitation via link token, creating the tenant', async () => {
    const ownerEmail = `accept_test_${Date.now()}@example.test`;
    const businessName = 'Gold Peak Gym';

    const inviteRes = await request(appServer)
      .post('/api/v1/admin/tenants')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ownerEmail,
        ownerFullName: 'Gold Owner',
        businessName,
        email: `biz_${Date.now()}@example.test`,
      });

    expect(inviteRes.status).toBe(201);
    const token = inviteRes.body.data.debugToken;
    expect(typeof token).toBe('string');

    // Recipient verifies token link
    const verifyRes = await request(appServer)
      .get(`/api/v1/auth/tenant-invitations/verify?token=${token}`);

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.valid).toBe(true);
    expect(verifyRes.body.data.invitation.ownerEmail).toBe(ownerEmail);

    // Recipient accepts invitation and sets password
    const acceptRes = await request(appServer)
      .post('/api/v1/auth/tenant-invitations/accept')
      .send({
        token,
        password: 'HostPassword123!',
        fullName: 'Gold Owner Verified',
      });

    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.success).toBe(true);

    // User is now verified and has GYM_HOST role
    const createdUser = await User.findOne({ where: { email: ownerEmail } });
    expect(createdUser).not.toBeNull();
    expect(createdUser.role).toBe('GYM_HOST');
    expect(createdUser.isVerified).toBe(true);

    // Tenant is now created with createdUser as owner
    const createdTenant = await Tenant.findOne({ where: { businessName } });
    expect(createdTenant).not.toBeNull();
    expect(createdTenant.ownerUserId).toBe(createdUser.id);

    // Invitation status marked ACCEPTED
    const invitation = await TenantInvitation.findOne({ where: { ownerEmail } });
    expect(invitation.status).toBe('ACCEPTED');
    expect(invitation.tenantId).toBe(createdTenant.id);

    // Acceptance audited
    const audit = await PlatformAuditLog.findOne({
      where: {
        action: 'tenant_invitation.accepted',
        targetId: createdTenant.id,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(createdUser.id);
  });

  test('Forged, expired, or reused invitation tokens are rejected', async () => {
    // 1. Forged token
    const forgedRes = await request(appServer)
      .post('/api/v1/auth/tenant-invitations/accept')
      .send({
        token: '0000000000000000000000000000000000000000000000000000000000000000',
        password: 'Password123!',
      });
    expect(forgedRes.status).toBe(400);

    // 2. Reused token
    const ownerEmail = `reused_${Date.now()}@example.test`;
    const inviteRes = await request(appServer)
      .post('/api/v1/admin/tenants')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ownerEmail,
        ownerFullName: 'Reused Test',
        businessName: 'Reused Gym',
        email: `reused_biz_${Date.now()}@example.test`,
      });
    const token = inviteRes.body.data.debugToken;

    // First accept: succeeds
    const firstAccept = await request(appServer)
      .post('/api/v1/auth/tenant-invitations/accept')
      .send({ token, password: 'Password123!' });
    expect(firstAccept.status).toBe(200);

    // Second accept: rejected
    const secondAccept = await request(appServer)
      .post('/api/v1/auth/tenant-invitations/accept')
      .send({ token, password: 'Password123!' });
    expect(secondAccept.status).toBe(400);
  });
});
