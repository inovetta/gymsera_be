const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  asPersona,
  factories,
} = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const request = require('supertest');
const { signToken } = require('../../src/utils/jwt.utils');

describe('RBAC-09: Branch deletion cascade and permission revocation (spec §12.5, §8.3)', () => {
  let dbHarness;
  let personas;
  let tenantId;
  let listing;
  let appServer;

  beforeAll(async () => {
    const { GymListing } = require('../../src/models/platform');
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenantId = personas.owner.tenantId;
    listing = await GymListing.findOne({ where: { tenantId } });
    appServer = await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test('Deleting a branch cascades revocation to branch-scoped RoleAssignments, bumps permissionVersion, and restore does not re-grant', async () => {
    const { User } = require('../../src/models/platform');
    const { Branch, RoleAssignment, RoleAssignmentBranch } = dbHarness.tenant1.models;
    const gymService = require('../../src/services/gym.service');

    // 1. Create a dedicated branch
    const branch = await factories.createBranch(dbHarness.tenant1, listing.id, {
      branchName: 'Cascade Test Branch 1',
    });

    // 2. Create a staff user with branch-scoped RoleAssignment
    const staffUser = await User.create({
      fullName: 'Cascade Staff Member',
      email: 'cascade.staff@example.test',
      passwordHash: 'hashed_pw',
      role: 'MEMBER',
      status: 'ACTIVE',
      permissionVersion: 1,
    });

    const assignment = await RoleAssignment.create({
      userId: staffUser.id,
      email: staffUser.email,
      roleKey: 'DESK',
      roleLevel: 20,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
    });

    await RoleAssignmentBranch.create({
      assignmentId: assignment.id,
      branchId: branch.id,
    });

    // Generate token with ver: 1
    const initialToken = signToken({
      sub: staffUser.id,
      email: staffUser.email,
      role: staffUser.role,
      tenantId,
      branchId: branch.id,
      ver: 1,
    });

    // 3. Delete the branch
    await gymService.deleteBranch(dbHarness.tenant1, branch.id, personas.owner.user.id, {
      confirmOrganizationDeletion: true,
    });

    // 4. Verify RoleAssignment is REVOKED
    await assignment.reload();
    expect(assignment.status).toBe('REVOKED');
    expect(assignment.revokedBy).toBe('system:branch_deleted');

    // 5. Verify user permissionVersion was bumped on platform User model
    await staffUser.reload();
    expect(staffUser.permissionVersion).toBeGreaterThan(1);

    // 6. Verify previous JWT receives immediate 403 (AUTH-08)
    const resForbidden = await request(appServer)
      .get(`/api/v1/gyms/branches/${branch.id}/staff`)
      .set('Authorization', `Bearer ${initialToken}`)
      .set('x-tenant-id', tenantId);

    expect(resForbidden.status).toBe(403);
    expect(resForbidden.body.code).toBe('forbidden');

    // 7. Restore the branch
    await gymService.restoreBranch(dbHarness.tenant1, tenantId, branch.id, personas.owner.user.id);

    // 8. Verify the branch is restored to ACTIVE
    await branch.reload();
    expect(branch.status).toBe('ACTIVE');

    // 9. Verify the assignment REMAINS REVOKED after branch restoration (no automatic re-grant)
    await assignment.reload();
    expect(assignment.status).toBe('REVOKED');

    // 10. Generate fresh token with updated permissionVersion
    const freshToken = signToken({
      sub: staffUser.id,
      email: staffUser.email,
      role: staffUser.role,
      tenantId,
      branchId: branch.id,
      ver: staffUser.permissionVersion,
    });

    // The fresh token passes auth ver check, but because RoleAssignment remains REVOKED:
    // a) GET /me/staff-status returns isStaff: false
    const statusRes = await request(appServer)
      .get('/api/v1/me/staff-status')
      .set('Authorization', `Bearer ${freshToken}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data.isStaff).toBe(false);
    expect(statusRes.body.data.branches).toEqual([]);

    // b) Accessing branch endpoints rejects access (404 branch access mask per SEC-01)
    const resStillForbidden = await request(appServer)
      .get(`/api/v1/gyms/branches/${branch.id}/staff`)
      .set('Authorization', `Bearer ${freshToken}`)
      .set('x-tenant-id', tenantId);

    expect([403, 404]).toContain(resStillForbidden.status);
  });

  test('Multi-branch staff assignment: deleting one branch removes link but retains ACTIVE status for remaining branches', async () => {
    const { User } = require('../../src/models/platform');
    const { RoleAssignment, RoleAssignmentBranch } = dbHarness.tenant1.models;
    const gymService = require('../../src/services/gym.service');

    const branchA = await factories.createBranch(dbHarness.tenant1, listing.id, {
      branchName: 'Multi Branch A',
    });
    const branchB = await factories.createBranch(dbHarness.tenant1, listing.id, {
      branchName: 'Multi Branch B',
    });

    const multiUser = await User.create({
      fullName: 'Multi Staff Member',
      email: 'multi.staff@example.test',
      passwordHash: 'hashed_pw',
      role: 'MEMBER',
      status: 'ACTIVE',
      permissionVersion: 1,
    });

    const assignment = await RoleAssignment.create({
      userId: multiUser.id,
      email: multiUser.email,
      roleKey: 'DESK',
      roleLevel: 20,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
    });

    await RoleAssignmentBranch.create({
      assignmentId: assignment.id,
      branchId: branchA.id,
    });
    await RoleAssignmentBranch.create({
      assignmentId: assignment.id,
      branchId: branchB.id,
    });

    // Delete branch A only
    await gymService.deleteBranch(dbHarness.tenant1, branchA.id, personas.owner.user.id, {
      confirmOrganizationDeletion: true,
    });

    // Assignment must still be ACTIVE because branch B remains
    await assignment.reload();
    expect(assignment.status).toBe('ACTIVE');

    const links = await RoleAssignmentBranch.findAll({ where: { assignmentId: assignment.id } });
    expect(links.length).toBe(1);
    expect(links[0].branchId).toBe(branchB.id);

    // Permission version was bumped so token for branch A is invalidated
    await multiUser.reload();
    expect(multiUser.permissionVersion).toBeGreaterThan(1);
  });
});
