/**
 * RT-08 — grants.changed realtime event (spec §9.4).
 *
 * Every team write that changes what a person may do (assign, update,
 * override, revoke) must emit `grants.changed` to `user:{id}` so the client
 * refetches its grants instead of waiting for the next 403.
 * The event is a nudge only: the payload carries no grants.
 */
const request = require('supertest');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
} = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const socketGateway = require('../../src/socket');

describe('RT-08: grants.changed is emitted to the affected user on team writes', () => {
  let dbHarness;
  let personas;
  let tenantId;
  let app;
  let targetUser;
  let assignment;
  let spy;

  const grantsChangedFor = (userId) =>
    spy.mock.calls.filter((c) => c[0] === userId && c[1] === 'grants.changed');

  beforeAll(async () => {
    const { User } = require('../../src/models/platform');
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenantId = personas.owner.tenantId;
    app = await startTestServer();

    targetUser = await User.create({
      fullName: 'Grants Changed Staff',
      email: 'rt08.staff@example.test',
      passwordHash: 'hashed_pw',
      role: 'MEMBER',
      status: 'ACTIVE',
      permissionVersion: 1,
    });
    assignment = await dbHarness.tenant1.models.RoleAssignment.create({
      userId: targetUser.id,
      email: targetUser.email,
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

  beforeEach(() => {
    spy = jest.spyOn(socketGateway, 'emitToUser').mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
  });

  const asOwner = (req) =>
    req.set('Authorization', `Bearer ${personas.owner.token}`).set('X-Tenant-Id', tenantId);

  test('PATCH /team/:id (update) emits grants.changed to the assignee, once, with no grants in the payload', async () => {
    const res = await asOwner(request(app).patch(`/api/v1/team/${assignment.id}`)).send({
      jobTitle: 'Desk Lead',
    });
    expect(res.status).toBe(200);

    const calls = grantsChangedFor(targetUser.id);
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual(expect.not.objectContaining({ grants: expect.anything() }));
  });

  test('PUT /team/:id/permissions (override) emits grants.changed to the assignee', async () => {
    const res = await asOwner(
      request(app).put(`/api/v1/team/${assignment.id}/permissions`)
    ).send({ overrides: [{ permissionKey: 'members.create', effect: 'ALLOW' }] });
    expect(res.status).toBe(200);

    expect(grantsChangedFor(targetUser.id)).toHaveLength(1);
  });

  test('a rejected write (stale expectedVersion) does not emit', async () => {
    const res = await asOwner(
      request(app).patch(`/api/v1/team/${assignment.id}`)
    ).send({ jobTitle: 'Nope', expectedVersion: 1 });
    expect(res.status).toBe(409);

    expect(grantsChangedFor(targetUser.id)).toHaveLength(0);
  });

  test('DELETE /team/:id (revoke) emits grants.changed to the revoked user', async () => {
    const res = await asOwner(request(app).delete(`/api/v1/team/${assignment.id}`));
    expect(res.status).toBe(200);

    expect(grantsChangedFor(targetUser.id)).toHaveLength(1);
  });
});
