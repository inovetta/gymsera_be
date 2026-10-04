const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  factories,
} = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const request = require('supertest');
const accessService = require('../../src/services/access.service');
const teamService = require('../../src/services/team.service');
const gymService = require('../../src/services/gym.service');

describe('RBAC-05: Strictly-below level rule (spec §12.5, §8.3)', () => {
  let dbHarness;
  let personas;
  let tenantId;
  let appServer;
  let listing;
  let branch;

  beforeAll(async () => {
    const { GymListing } = require('../../src/models/platform');
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenantId = personas.owner.tenantId;
    listing = await GymListing.findOne({ where: { tenantId } });
    const { Branch } = dbHarness.tenant1.models;
    branch = await Branch.findOne({ where: { gymListingId: listing.id } });
    appServer = await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test('Org Admin (level 80) inviting an Org Admin (level 80 - peer escalation) via POST /team/invites is rejected with 403', async () => {
    const res = await request(appServer)
      .post('/api/v1/team/invites')
      .set('Authorization', `Bearer ${personas.orgAdmin.token}`)
      .set('X-Tenant-Id', tenantId)
      .send({
        email: 'orgadmin.escalation@example.test',
        fullName: 'Escalation Target',
        roleKey: 'ORG_ADMIN',
        branchIds: [branch.id],
      });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/cannot assign the Org Admin role|at or above your own level/i);
  });

  test('Org Admin (level 80) inviting an Owner (level 100 - superior escalation) via POST /team/invites is rejected with 403', async () => {
    const res = await request(appServer)
      .post('/api/v1/team/invites')
      .set('Authorization', `Bearer ${personas.orgAdmin.token}`)
      .set('X-Tenant-Id', tenantId)
      .send({
        email: 'owner.escalation@example.test',
        fullName: 'Superior Target',
        roleKey: 'OWNER',
        branchIds: [branch.id],
      });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/cannot be assigned|at or above your own level/i);
  });

  test('Manager (level 60) assigning an Org Admin via legacy POST /gyms/branches/:branchId/staff is rejected with 403', async () => {
    const { User } = require('../../src/models/platform');
    const targetUser = await User.create({
      fullName: 'Legacy Staff Assignee',
      email: 'legacy.staff@example.test',
      passwordHash: 'hash',
      role: 'MEMBER',
      status: 'ACTIVE',
    });

    const res = await request(appServer)
      .post(`/api/v1/gyms/branches/${branch.id}/staff`)
      .set('Authorization', `Bearer ${personas.manager.token}`)
      .set('X-Tenant-Id', tenantId)
      .send({
        userId: targetUser.id,
        designation: 'admin',
      });

    expect(res.status).toBe(403);
  });

  test('Manager (level 60) updating a Desk staff to Org Admin via PATCH /team/:id is rejected with 403', async () => {
    const { RoleAssignment } = dbHarness.tenant1.models;
    const { User } = require('../../src/models/platform');

    const deskUser = await User.create({
      fullName: 'Desk Person',
      email: 'desk.person@example.test',
      passwordHash: 'hash',
      role: 'MEMBER',
      status: 'ACTIVE',
    });

    const deskAssignment = await RoleAssignment.create({
      userId: deskUser.id,
      email: deskUser.email,
      roleKey: 'DESK',
      roleLevel: 20,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
    });

    const res = await request(appServer)
      .patch(`/api/v1/team/${deskAssignment.id}`)
      .set('Authorization', `Bearer ${personas.manager.token}`)
      .set('X-Tenant-Id', tenantId)
      .send({
        roleKey: 'ORG_ADMIN',
      });

    expect(res.status).toBe(403);
  });

  test('Invite acceptance rejects elevation if inviter level is at or below the role level (403)', async () => {
    const { RoleAssignment } = dbHarness.tenant1.models;
    const { User } = require('../../src/models/platform');

    // Create a user who was invited as ORG_ADMIN by managerUser
    const inviteeUser = await User.create({
      fullName: 'Invitee Org Admin',
      email: 'invitee.admin@example.test',
      passwordHash: 'hash',
      role: 'MEMBER',
      status: 'ACTIVE',
    });

    // Attempt to accept an invite with roleKey ORG_ADMIN where inviter is managerUser (level 60 < 80)
    await expect(
      teamService.acceptStaffInvite({
        tenantDb: dbHarness.tenant1,
        tenantId,
        userId: inviteeUser.id,
        email: inviteeUser.email,
        branchId: branch.id,
        designation: 'admin',
        inviterUserId: personas.manager.user.id,
      })
    ).rejects.toThrow();
  });
});
