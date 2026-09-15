/**
 * Pre-approval collection — markCollected() and its effect on execute().
 *
 * The bug this closes: a REQUEST-tier "Add member" submission created no
 * Payment row until an approver decided it, and when execute() ran, the
 * resulting Payment was attributed to the approver — not to whoever was
 * actually standing at the counter holding the cash. markCollected() lets that
 * person mark the still-PENDING request collected; decide() reads it back and
 * threads it through to the command so the eventual Payment is attributed
 * correctly instead.
 */
jest.mock('../src/services/access.service', () => ({
  resolve: jest.fn(),
}));
jest.mock('../src/services/audit.service', () => ({
  record: jest.fn().mockResolvedValue(null),
}));

const accessService = require('../src/services/access.service');
const approvalService = require('../src/services/approval.service');

const grantsWith = (keys, extra = {}) => ({ has: (k) => keys.includes(k), isOwner: false, ...extra });

describe('approval.service — markCollected', () => {
  const buildTenantDb = (request) => ({
    models: {
      ApprovalRequest: {
        findByPk: jest.fn().mockResolvedValue(request),
        update: jest.fn().mockResolvedValue([1]),
      },
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('404s when the request does not exist', async () => {
    const tenantDb = buildTenantDb(null);
    const ctx = { tenantDb, tenantId: 't1', userId: 'u1' };

    await expect(approvalService.markCollected(ctx, 'missing')).rejects.toThrow(/not found/);
  });

  it('rejects an action key with nothing to collect', async () => {
    const request = { id: 'r1', status: 'PENDING', actionKey: 'expenses.create', branchId: 'b1' };
    const tenantDb = buildTenantDb(request);
    const ctx = { tenantDb, tenantId: 't1', userId: 'u1' };

    await expect(approvalService.markCollected(ctx, 'r1')).rejects.toThrow(/has no payment to collect/);
  });

  it('rejects a request that has already been decided', async () => {
    const request = { id: 'r1', status: 'APPROVED', actionKey: 'members.create', branchId: 'b1' };
    const tenantDb = buildTenantDb(request);
    const ctx = { tenantDb, tenantId: 't1', userId: 'u1' };

    await expect(approvalService.markCollected(ctx, 'r1')).rejects.toThrow(/already been approved/);
  });

  it('rejects someone who does not hold payments.record at the request\'s branch', async () => {
    accessService.resolve.mockResolvedValue(grantsWith([])); // e.g. a Trainer
    const request = { id: 'r1', status: 'PENDING', actionKey: 'members.create', branchId: 'b1' };
    const tenantDb = buildTenantDb(request);
    const ctx = { tenantDb, tenantId: 't1', userId: 'u1' };

    await expect(approvalService.markCollected(ctx, 'r1')).rejects.toThrow(/do not have permission/);
    expect(tenantDb.models.ApprovalRequest.update).not.toHaveBeenCalled();
  });

  it('lets an authorized collector mark a PENDING request collected', async () => {
    accessService.resolve.mockResolvedValue(grantsWith(['payments.record']));
    const request = {
      id: 'r1',
      status: 'PENDING',
      actionKey: 'members.create',
      branchId: 'b1',
      reload: jest.fn().mockResolvedValue(undefined),
    };
    const tenantDb = buildTenantDb(request);
    const ctx = { tenantDb, tenantId: 't1', userId: 'desk-1' };

    await approvalService.markCollected(ctx, 'r1', { method: 'CASH', notes: 'Paid at counter' });

    expect(tenantDb.models.ApprovalRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ collectedBy: 'desk-1', collectionMethod: 'CASH', collectionNotes: 'Paid at counter' }),
      { where: { id: 'r1', status: 'PENDING', collectedAt: null } }
    );
  });

  it('is race-safe — a second collect attempt after the first already won gets 409', async () => {
    accessService.resolve.mockResolvedValue(grantsWith(['payments.record']));
    const request = { id: 'r1', status: 'PENDING', actionKey: 'members.create', branchId: 'b1' };
    const tenantDb = buildTenantDb(request);
    tenantDb.models.ApprovalRequest.update.mockResolvedValue([0]); // someone else's collect already won
    const ctx = { tenantDb, tenantId: 't1', userId: 'desk-2' };

    await expect(approvalService.markCollected(ctx, 'r1')).rejects.toThrow(/already marked collected/);
  });

  it('the owner may collect even without an explicit payments.record grant', async () => {
    const request = {
      id: 'r1',
      status: 'PENDING',
      actionKey: 'members.create',
      branchId: 'b1',
      reload: jest.fn().mockResolvedValue(undefined),
    };
    const tenantDb = buildTenantDb(request);
    accessService.resolve.mockResolvedValue(grantsWith([], { isOwner: true }));
    const ctx = { tenantDb, tenantId: 't1', userId: 'owner-1' };

    await expect(approvalService.markCollected(ctx, 'r1')).resolves.toBeDefined();
  });
});

describe('members.create command — pre-collected attribution', () => {
  const commands = require('../src/services/commands');

  it('passes the pre-collection through to enrollMember when the request was marked collected', async () => {
    jest.resetModules();
    const enrollMember = jest.fn().mockResolvedValue({ id: 'sub-1' });
    jest.doMock('../src/services/gym.service', () => ({ enrollMember }));
    const freshCmd = require('../src/services/commands').get('members.create');

    const ctx = {
      tenantId: 'tenant-1',
      tenantDb: {},
      userId: 'approver-1', // the approver deciding the request
      branchId: 'branch-1',
      collectedBy: 'desk-1', // set by decide() from request.collectedBy
      collectedAt: new Date('2026-09-15T10:00:00Z'),
      collectionMethod: 'CASH',
    };
    await freshCmd.execute(ctx, { fullName: 'Ahmed', email: 'a@b.com', planId: 'p1' });

    expect(enrollMember).toHaveBeenCalledWith(
      ctx.tenantDb,
      'tenant-1',
      expect.objectContaining({ fullName: 'Ahmed' }),
      { role: 'GYM_HOST', id: 'approver-1' },
      { collectedBy: 'desk-1', collectedAt: ctx.collectedAt, collectionMethod: 'CASH' }
    );
    jest.dontMock('../src/services/gym.service');
  });

  it('passes null collection when the request was never pre-collected (the ordinary case)', async () => {
    jest.resetModules();
    const enrollMember = jest.fn().mockResolvedValue({ id: 'sub-1' });
    jest.doMock('../src/services/gym.service', () => ({ enrollMember }));
    const freshCmd = require('../src/services/commands').get('members.create');

    const ctx = { tenantId: 'tenant-1', tenantDb: {}, userId: 'host-1', branchId: 'branch-1' };
    await freshCmd.execute(ctx, { fullName: 'Ahmed', email: 'a@b.com', planId: 'p1' });

    expect(enrollMember).toHaveBeenCalledWith(
      ctx.tenantDb,
      'tenant-1',
      expect.objectContaining({ fullName: 'Ahmed' }),
      { role: 'GYM_HOST', id: 'host-1' },
      null
    );
    jest.dontMock('../src/services/gym.service');
  });
});
