/**
 * Regression test for the bug where a role_assignments-based team member (e.g.
 * a Branch Admin created through Team & Access) got a 403 on every expenses
 * endpoint. The gate only ever recognized a legacy `gym_staff` row with
 * `designation === 'admin'` — a person hired through the new invite flow has no
 * such row, holds `expenses.view` through their role assignment instead, and
 * was rejected outright.
 */
jest.mock('../src/services/access.service', () => ({
  resolve: jest.fn(),
}));

const accessService = require('../src/services/access.service');
const expensesController = require('../src/controllers/expenses.controller');

const fakeRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const grantsWith = (keys) => ({ has: (k) => keys.includes(k) });

describe('expenses endpoints — permission-aware access, not legacy-only', () => {
  const branchId = 'branch-1';

  const baseReq = (overrides = {}) => ({
    params: { branchId },
    query: {},
    user: { id: 'user-1', tenantId: 'tenant-1', role: 'BRANCH_MANAGER' },
    tenantDb: {
      models: {
        Expense: { findAndCountAll: jest.fn().mockResolvedValue({ count: 0, rows: [] }) },
        GymStaff: { findOne: jest.fn().mockResolvedValue(null) },
      },
    },
    ...overrides,
  });

  beforeEach(() => jest.clearAllMocks());

  it('lets a role_assignments-based Branch Admin (no gym_staff row) list expenses', async () => {
    accessService.resolve.mockResolvedValue(grantsWith(['expenses.view']));
    const req = baseReq();
    const res = fakeRes();
    const next = jest.fn();

    await expensesController.listExpenses(req, res, next);

    expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('still rejects someone with no expenses.view and no legacy admin record', async () => {
    accessService.resolve.mockResolvedValue(grantsWith([])); // e.g. a Trainer
    const req = baseReq();
    const res = fakeRes();
    const next = jest.fn();

    await expensesController.listExpenses(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('still accepts a legacy gym_staff admin when the tenant has not been backfilled', async () => {
    // Simulate an un-migrated tenant: the permission resolver finds no
    // assignment at all (empty grants), so the legacy designation check must
    // still be the thing that lets this request through.
    accessService.resolve.mockResolvedValue(grantsWith([]));
    const req = baseReq({
      tenantDb: {
        models: {
          Expense: { findAndCountAll: jest.fn().mockResolvedValue({ count: 0, rows: [] }) },
          GymStaff: { findOne: jest.fn().mockResolvedValue({ designation: 'Admin' }) },
        },
      },
    });
    const res = fakeRes();
    const next = jest.fn();

    await expensesController.listExpenses(req, res, next);

    expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('the owner always passes, without ever resolving grants', async () => {
    const req = baseReq({ user: { id: 'owner-1', tenantId: 'tenant-1', role: 'GYM_HOST', isHost: true } });
    const res = fakeRes();
    const next = jest.fn();

    await expensesController.listExpenses(req, res, next);

    expect(accessService.resolve).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});
