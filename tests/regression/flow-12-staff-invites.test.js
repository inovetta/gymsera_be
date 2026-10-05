const request = require('supertest');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
} = require('../harness');
const { createUser } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');
const { startTestServer, stopTestServer } = require('../harness/test-server');

describe('FLOW-12: Legacy staff-invites single-use expiring token & access control', () => {
  let dbHarness;
  let personas;
  let tenantId;
  let appServer;
  let branch;
  let member2User;
  let member2Token;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenantId = personas.owner.tenantId;

    const { Branch } = dbHarness.tenant1.models;
    branch = await Branch.findOne({ where: { status: 'ACTIVE' } });
    appServer = await startTestServer();

    // Create a second distinct member
    member2User = await createUser({
      role: 'MEMBER',
      email: 'member2@gymsera.test',
      fullName: 'Second Member',
    });
    member2Token = signToken({
      sub: member2User.id,
      id: member2User.id,
      email: member2User.email,
      role: 'MEMBER',
      isVerified: true,
    });
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test('1. Unassigned user cannot accept an invite issued to someone else email (userId is null)', async () => {
    const { GymStaff } = dbHarness.tenant1.models;
    const staffInvite = await GymStaff.create({
      branchId: branch.id,
      userId: null,
      email: 'target.invitee@gymsera.test',
      designation: 'Trainer',
      status: 'pending',
      employmentStatus: 'ACTIVE',
    });

    // personas.member has email 'member@test.com', NOT 'target.invitee@gymsera.test'
    const res = await request(appServer)
      .post(`/api/v1/staff-invites/${staffInvite.id}/accept`)
      .set('Authorization', `Bearer ${personas.member.token}`)
      .send({ tenantId });

    expect(res.status).toBe(403);
    expect(res.body.message || res.body.error?.message).toMatch(/not assigned to your account/i);
  });

  test('2. Single-use: an accepted invite cannot be accepted a second time', async () => {
    const { GymStaff } = dbHarness.tenant1.models;

    // Create a staff invite for member
    const staffInvite = await GymStaff.create({
      branchId: branch.id,
      userId: personas.member.user.id,
      email: personas.member.user.email,
      designation: 'Trainer',
      status: 'pending',
      employmentStatus: 'ACTIVE',
    });

    // First accept succeeds
    const res1 = await request(appServer)
      .post(`/api/v1/staff-invites/${staffInvite.id}/accept`)
      .set('Authorization', `Bearer ${personas.member.token}`)
      .send({ tenantId });

    expect(res1.status).toBe(200);
    expect(res1.body.data.status).toBe('active');

    // Second accept attempt must fail (single-use)
    const res2 = await request(appServer)
      .post(`/api/v1/staff-invites/${staffInvite.id}/accept`)
      .set('Authorization', `Bearer ${personas.member.token}`)
      .send({ tenantId });

    expect([400, 409]).toContain(res2.status);
    expect(res2.body.message || res2.body.error?.message).toMatch(/already.*accepted|not pending/i);
  });

  test('3. Expired invite cannot be accepted (older than 7 days)', async () => {
    const { GymStaff } = dbHarness.tenant1.models;

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const staffInvite = await GymStaff.create({
      branchId: branch.id,
      userId: member2User.id,
      email: member2User.email,
      designation: 'Trainer',
      status: 'pending',
      employmentStatus: 'ACTIVE',
      createdAt: eightDaysAgo,
    });

    const res = await request(appServer)
      .post(`/api/v1/staff-invites/${staffInvite.id}/accept`)
      .set('Authorization', `Bearer ${member2Token}`)
      .send({ tenantId });

    expect([400, 410]).toContain(res.status);
    expect(res.body.message || res.body.error?.message).toMatch(/expired/i);
  });

  test('4. Declined or revoked invite cannot be accepted', async () => {
    const { GymStaff } = dbHarness.tenant1.models;

    const staffInvite = await GymStaff.create({
      branchId: branch.id,
      userId: member2User.id,
      email: member2User.email,
      designation: 'Trainer',
      status: 'declined',
      employmentStatus: 'TERMINATED',
    });

    const res = await request(appServer)
      .post(`/api/v1/staff-invites/${staffInvite.id}/accept`)
      .set('Authorization', `Bearer ${member2Token}`)
      .send({ tenantId });

    expect([400, 403, 409]).toContain(res.status);
    expect(res.body.message || res.body.error?.message).toMatch(/declined|revoked|not pending|no longer pending/i);
  });

  test('5. Accepting an invite preserves platform User.role as MEMBER (no global role mutation) and creates RoleAssignment', async () => {
    const { GymStaff, RoleAssignment } = dbHarness.tenant1.models;
    const { User } = require('../../src/models/platform');

    // Clean any prior role assignment for member2
    await RoleAssignment.destroy({ where: { userId: member2User.id } });

    const staffInvite = await GymStaff.create({
      branchId: branch.id,
      userId: member2User.id,
      email: member2User.email,
      designation: 'Front Desk',
      status: 'pending',
      employmentStatus: 'ACTIVE',
    });

    const res = await request(appServer)
      .post(`/api/v1/staff-invites/${staffInvite.id}/accept`)
      .set('Authorization', `Bearer ${member2Token}`)
      .send({ tenantId });

    expect(res.status).toBe(200);

    // Verify platform User.role did not get mutated
    const userAfter = await User.findByPk(member2User.id);
    expect(userAfter.role).toBe('MEMBER');

    // Verify tenant RoleAssignment was created with ACTIVE status
    const assignment = await RoleAssignment.findOne({
      where: { userId: member2User.id, status: 'ACTIVE' },
    });
    expect(assignment).toBeDefined();
    expect(assignment.roleKey).toBe('DESK');
  });

  test('6. Invite can be accepted using raw token when inviteTokenHash is stored', async () => {
    const crypto = require('crypto');
    const { GymStaff, RoleAssignment } = dbHarness.tenant1.models;
    const { createUser } = require('../harness/factories');
    const { signToken } = require('../../src/utils/jwt.utils');

    const member3User = await createUser({
      role: 'MEMBER',
      email: 'member3@gymsera.test',
      fullName: 'Third Member',
    });
    const member3Token = signToken({
      sub: member3User.id,
      id: member3User.id,
      email: member3User.email,
      role: 'MEMBER',
      isVerified: true,
    });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const staffInvite = await GymStaff.create({
      branchId: branch.id,
      userId: member3User.id,
      email: member3User.email,
      designation: 'Trainer',
      status: 'pending',
      employmentStatus: 'ACTIVE',
      inviteTokenHash: tokenHash,
      tokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    // Accepting using rawToken in URL path
    const res = await request(appServer)
      .post(`/api/v1/staff-invites/${rawToken}/accept`)
      .set('Authorization', `Bearer ${member3Token}`)
      .send({ tenantId });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');

    // Token is consumed (inviteTokenHash cleared)
    const staffAfter = await GymStaff.findByPk(staffInvite.id);
    expect(staffAfter.status).toBe('active');
    expect(staffAfter.inviteTokenHash).toBeNull();
  });
});

