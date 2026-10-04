const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  factories,
} = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const request = require('supertest');

describe('RBAC-08: Optimistic concurrency control via expectedVersion on grant edits (spec §12.5, §8.3)', () => {
  let dbHarness;
  let personas;
  let tenantId;
  let appServer;
  let listing;
  let branch;
  let deskMemberUser;
  let assignment;

  beforeAll(async () => {
    const { GymListing, User } = require('../../src/models/platform');
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenantId = personas.owner.tenantId;
    listing = await GymListing.findOne({ where: { tenantId } });
    const { Branch, RoleAssignment } = dbHarness.tenant1.models;
    branch = await Branch.findOne({ where: { gymListingId: listing.id } });
    appServer = await startTestServer();

    deskMemberUser = await User.create({
      fullName: 'Concurrent Edit Staff',
      email: 'concurrent.staff@example.test',
      passwordHash: 'hashed_pw',
      role: 'MEMBER',
      status: 'ACTIVE',
      permissionVersion: 1,
    });

    assignment = await RoleAssignment.create({
      userId: deskMemberUser.id,
      email: deskMemberUser.email,
      roleKey: 'DESK',
      roleLevel: 20,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
      version: 1,
    });
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test('GET /team/:id exposes initial version', async () => {
    const res = await request(appServer)
      .get(`/api/v1/team/${assignment.id}`)
      .set('Authorization', `Bearer ${personas.owner.token}`)
      .set('X-Tenant-Id', tenantId);

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(1);
  });

  test('Parallel PATCH: First update with expectedVersion: 1 succeeds and increments version to 2', async () => {
    const res = await request(appServer)
      .patch(`/api/v1/team/${assignment.id}`)
      .set('Authorization', `Bearer ${personas.owner.token}`)
      .set('X-Tenant-Id', tenantId)
      .send({
        jobTitle: 'Desk Lead',
        expectedVersion: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);

    await assignment.reload();
    expect(assignment.version).toBe(2);
    expect(assignment.jobTitle).toBe('Desk Lead');
  });

  test('Parallel PATCH: Second update with stale expectedVersion: 1 fails with 409 grants_changed', async () => {
    const res = await request(appServer)
      .patch(`/api/v1/team/${assignment.id}`)
      .set('Authorization', `Bearer ${personas.owner.token}`)
      .set('X-Tenant-Id', tenantId)
      .send({
        jobTitle: 'Desk Supervisor',
        expectedVersion: 1,
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('grants_changed');
    expect(res.body.message).toMatch(/modified by another user/i);

    // Verify jobTitle was NOT overwritten
    await assignment.reload();
    expect(assignment.jobTitle).toBe('Desk Lead');
  });

  test('PUT /team/:id/permissions with stale expectedVersion: 1 fails with 409 grants_changed', async () => {
    const res = await request(appServer)
      .put(`/api/v1/team/${assignment.id}/permissions`)
      .set('Authorization', `Bearer ${personas.owner.token}`)
      .set('X-Tenant-Id', tenantId)
      .send({
        overrides: [
          {
            permissionKey: 'members.create',
            effect: 'ALLOW',
          },
        ],
        expectedVersion: 1,
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('grants_changed');
  });

  test('PUT /team/:id/permissions with current expectedVersion: 2 succeeds and increments version to 3', async () => {
    const res = await request(appServer)
      .put(`/api/v1/team/${assignment.id}/permissions`)
      .set('Authorization', `Bearer ${personas.owner.token}`)
      .set('X-Tenant-Id', tenantId)
      .send({
        overrides: [
          {
            permissionKey: 'members.create',
            effect: 'ALLOW',
          },
        ],
        expectedVersion: 2,
      });

    expect(res.status).toBe(200);

    await assignment.reload();
    expect(assignment.version).toBe(3);
  });

  test('Client omitting expectedVersion (backward compatibility) succeeds without conflict', async () => {
    const res = await request(appServer)
      .patch(`/api/v1/team/${assignment.id}`)
      .set('Authorization', `Bearer ${personas.owner.token}`)
      .set('X-Tenant-Id', tenantId)
      .send({
        jobTitle: 'Front Desk Head',
      });

    expect(res.status).toBe(200);

    await assignment.reload();
    expect(assignment.version).toBe(4);
    expect(assignment.jobTitle).toBe('Front Desk Head');
  });
});
