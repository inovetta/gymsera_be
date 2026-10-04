const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  factories,
} = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const request = require('supertest');
const approvalService = require('../../src/services/approval.service');

describe('RBAC-04: Approval execution re-checks and atomicity (spec §12.5, §8.3)', () => {
  let dbHarness;
  let personas;
  let tenantId;
  let appServer;
  let listing;
  let branch;
  let category;

  beforeAll(async () => {
    const { GymListing } = require('../../src/models/platform');
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenantId = personas.owner.tenantId;
    listing = await GymListing.findOne({ where: { tenantId } });
    const { Branch, ExpenseCategory } = dbHarness.tenant1.models;
    branch = await Branch.findOne({ where: { gymListingId: listing.id } });
    category = await ExpenseCategory.create({
      branchId: branch.id,
      name: 'Operations Category',
    });
    appServer = await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test('Approver losing grant before execution returns 403', async () => {
    const { User } = require('../../src/models/platform');
    const { RoleAssignment, ApprovalRequest } = dbHarness.tenant1.models;

    // Create desk clerk (requester)
    const deskUser = await User.create({
      fullName: 'Approval Desk Requester',
      email: 'desk.req1@example.test',
      passwordHash: 'hash',
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    await RoleAssignment.create({
      userId: deskUser.id,
      email: deskUser.email,
      roleKey: 'DESK',
      roleLevel: 20,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
    });

    // Create approval request for expense
    const approvalReq = await ApprovalRequest.create({
      branchId: branch.id,
      actionKey: 'expenses.create',
      requestedBy: deskUser.id,
      payload: {
        title: 'Office Supplies',
        amount: 500,
        categoryId: category.id,
      },
      status: 'PENDING',
    });

    // Demote/revoke manager's assignment
    const managerAssignment = await RoleAssignment.findOne({
      where: { userId: personas.manager.user.id },
    });
    const originalRoleKey = managerAssignment.roleKey;
    const originalLevel = managerAssignment.roleLevel;
    await managerAssignment.update({ roleKey: 'DESK', roleLevel: 20 });

    const ctx = {
      tenantDb: dbHarness.tenant1,
      tenantId,
      userId: personas.manager.user.id,
    };

    await expect(
      approvalService.decide(ctx, approvalReq.id, 'APPROVE')
    ).rejects.toMatchObject({
      statusCode: 403,
    });

    // Restore manager role
    await managerAssignment.update({ roleKey: originalRoleKey, roleLevel: originalLevel });
  });

  test('Requester account suspended before execution returns 422', async () => {
    const { User } = require('../../src/models/platform');
    const { RoleAssignment, ApprovalRequest } = dbHarness.tenant1.models;

    const deskUser = await User.create({
      fullName: 'Suspended Desk Requester',
      email: 'desk.susp@example.test',
      passwordHash: 'hash',
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    await RoleAssignment.create({
      userId: deskUser.id,
      email: deskUser.email,
      roleKey: 'DESK',
      roleLevel: 20,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
    });

    const approvalReq = await ApprovalRequest.create({
      branchId: branch.id,
      actionKey: 'expenses.create',
      requestedBy: deskUser.id,
      payload: {
        title: 'Cleaning Materials',
        amount: 300,
        categoryId: category.id,
      },
      status: 'PENDING',
    });

    // Suspend requester
    await deskUser.update({ status: 'SUSPENDED' });

    const ctx = {
      tenantDb: dbHarness.tenant1,
      tenantId,
      userId: personas.owner.user.id,
    };

    await expect(
      approvalService.decide(ctx, approvalReq.id, 'APPROVE')
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/requester account has been suspended/i),
    });
  });

  test('Requester team assignment revoked before execution returns 422', async () => {
    const { User } = require('../../src/models/platform');
    const { RoleAssignment, ApprovalRequest } = dbHarness.tenant1.models;

    const deskUser = await User.create({
      fullName: 'Revoked Desk Requester',
      email: 'desk.revoked@example.test',
      passwordHash: 'hash',
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    const assignment = await RoleAssignment.create({
      userId: deskUser.id,
      email: deskUser.email,
      roleKey: 'DESK',
      roleLevel: 20,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
    });

    const approvalReq = await ApprovalRequest.create({
      branchId: branch.id,
      actionKey: 'expenses.create',
      requestedBy: deskUser.id,
      payload: {
        title: 'Printer Toner',
        amount: 250,
        categoryId: category.id,
      },
      status: 'PENDING',
    });

    // Revoke requester assignment
    await assignment.update({ status: 'REVOKED' });

    const ctx = {
      tenantDb: dbHarness.tenant1,
      tenantId,
      userId: personas.owner.user.id,
    };

    await expect(
      approvalService.decide(ctx, approvalReq.id, 'APPROVE')
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/requester is no longer an active team member/i),
    });
  });

  test('Double-approval concurrency: one wins, parallel attempt fails with 409 conflict', async () => {
    const { User } = require('../../src/models/platform');
    const { RoleAssignment, ApprovalRequest } = dbHarness.tenant1.models;

    const deskUser = await User.create({
      fullName: 'Race Requester',
      email: 'desk.race@example.test',
      passwordHash: 'hash',
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    await RoleAssignment.create({
      userId: deskUser.id,
      email: deskUser.email,
      roleKey: 'DESK',
      roleLevel: 20,
      scopeType: 'BRANCH',
      status: 'ACTIVE',
    });

    const approvalReq = await ApprovalRequest.create({
      branchId: branch.id,
      actionKey: 'expenses.create',
      requestedBy: deskUser.id,
      payload: {
        title: 'Stationery Items',
        amount: 150,
        categoryId: category.id,
      },
      status: 'PENDING',
    });

    const ctx = {
      tenantDb: dbHarness.tenant1,
      tenantId,
      userId: personas.owner.user.id,
    };

    // Parallel decide calls
    const results = await Promise.allSettled([
      approvalService.decide(ctx, approvalReq.id, 'APPROVE'),
      approvalService.decide(ctx, approvalReq.id, 'APPROVE'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.statusCode).toBe(409);
  });
});
