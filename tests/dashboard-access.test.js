/**
 * `dashboard.view` and `dashboard.revenue.view` are separate permissions in the
 * catalogue on purpose — a Trainer or Front Desk clerk should see today's
 * check-ins without seeing takings. This confirms the branch dashboard endpoint
 * actually enforces that split rather than always returning the financial
 * figures regardless of who asked.
 */
jest.mock('../src/services/access.service', () => ({
  resolve: jest.fn(),
}));

const accessService = require('../src/services/access.service');
const hostController = require('../src/controllers/host.controller');

const grantsWith = (keys) => ({ has: (k) => keys.includes(k) });

const fakeRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const fakeTenantDb = () => {
  const Branch = { findOne: jest.fn().mockResolvedValue({ id: 'branch-1', status: 'ACTIVE' }) };
  const zeroCount = { count: jest.fn().mockResolvedValue(0) };
  return {
    models: {
      Branch,
      AttendanceLog: { ...zeroCount, findAll: jest.fn().mockResolvedValue([]) },
      Payment: { sum: jest.fn().mockResolvedValue(500000) },
      MemberSubscription: zeroCount,
      MembershipPlan: {},
      Expense: { sum: jest.fn().mockResolvedValue(10000) },
    },
  };
};

describe('GET /host/branches/:branchId/dashboard — revenue masking', () => {
  const baseReq = (user) => ({
    params: { branchId: 'branch-1' },
    user,
    tenantDb: fakeTenantDb(),
  });

  beforeEach(() => jest.clearAllMocks());

  it('hides every financial figure from someone without dashboard.revenue.view', async () => {
    accessService.resolve.mockResolvedValue(grantsWith(['dashboard.view']));
    const req = baseReq({ id: 'trainer-1', tenantId: 'tenant-1', role: 'BRANCH_MANAGER' });
    const res = fakeRes();
    const next = jest.fn();

    await hostController.getBranchDashboard(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.data.monthlyRevenue).toBeNull();
    expect(body.data.grossRevenue).toBeNull();
    expect(body.data.totalExpenses).toBeNull();
    expect(body.data.netProfit).toBeNull();
    // Operational figures are unaffected.
    expect(body.data.todaysCheckins).toBe(0);
  });

  it('shows the financial figures to someone who holds dashboard.revenue.view', async () => {
    accessService.resolve.mockResolvedValue(grantsWith(['dashboard.view', 'dashboard.revenue.view']));
    const req = baseReq({ id: 'admin-1', tenantId: 'tenant-1', role: 'BRANCH_MANAGER' });
    const res = fakeRes();
    const next = jest.fn();

    await hostController.getBranchDashboard(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.data.monthlyRevenue).toBe(500000);
    expect(body.data.netProfit).toBe(490000);
  });

  it('the owner sees revenue without ever resolving grants', async () => {
    const req = baseReq({ id: 'owner-1', tenantId: 'tenant-1', role: 'GYM_HOST', isHost: true });
    const res = fakeRes();
    const next = jest.fn();

    await hostController.getBranchDashboard(req, res, next);

    expect(accessService.resolve).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.data.monthlyRevenue).toBe(500000);
  });

  it('fails closed: a permission-resolution error still hides revenue', async () => {
    accessService.resolve.mockRejectedValue(new Error('tenant db unreachable'));
    const req = baseReq({ id: 'trainer-1', tenantId: 'tenant-1', role: 'BRANCH_MANAGER' });
    const res = fakeRes();
    const next = jest.fn();

    await hostController.getBranchDashboard(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.data.monthlyRevenue).toBeNull();
  });
});
