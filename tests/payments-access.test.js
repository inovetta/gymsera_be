/**
 * Regression test for `/payments/:id/verify` — it used to be gated by
 * `authorize('GYM_HOST')`, the literal platform role string. A team member
 * holding `payments.verify` through a role assignment — a Branch Manager, an
 * Org Admin — could never verify a single payment, no matter what the
 * permission catalogue granted them. This is the exact bug behind "Pending
 * members/subscriptions are not clickable, so verification cannot be
 * completed" — nothing could ever succeed at calling this endpoint for
 * anyone but the literal tenant owner.
 */
jest.mock('../src/services/access.service', () => ({
  resolve: jest.fn(),
}));
jest.mock('../src/services/payment.service', () => ({
  verifyPayment: jest.fn(),
}));

const accessService = require('../src/services/access.service');
const paymentService = require('../src/services/payment.service');
const paymentsController = require('../src/controllers/payments.controller');

const grantsWith = (keys) => ({ has: (k) => keys.includes(k) });

const fakeRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('POST /payments/:id/verify — permission-aware, not role-string-only', () => {
  const paymentId = 'payment-1';
  const branchId = 'branch-1';

  const baseReq = (user, overrides = {}) => ({
    params: { id: paymentId },
    body: {},
    user,
    tenantDb: {
      models: {
        Payment: { findByPk: jest.fn().mockResolvedValue({ id: paymentId, branchId }) },
        GymStaff: { findOne: jest.fn().mockResolvedValue(null) },
      },
    },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    paymentService.verifyPayment.mockResolvedValue({ id: paymentId, status: 'COMPLETED' });
  });

  it('lets a Branch Manager holding payments.verify actually verify', async () => {
    accessService.resolve.mockResolvedValue(grantsWith(['payments.verify']));
    const req = baseReq({ id: 'manager-1', tenantId: 'tenant-1', role: 'BRANCH_MANAGER' });
    const res = fakeRes();
    const next = jest.fn();

    await paymentsController.verifyPayment(req, res, next);

    expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(paymentService.verifyPayment).toHaveBeenCalledWith(req.tenantDb, paymentId, 'manager-1', undefined);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects a team member who does not hold payments.verify', async () => {
    accessService.resolve.mockResolvedValue(grantsWith([])); // e.g. Front Desk
    const req = baseReq({ id: 'desk-1', tenantId: 'tenant-1', role: 'BRANCH_MANAGER' });
    const res = fakeRes();
    const next = jest.fn();

    await paymentsController.verifyPayment(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(paymentService.verifyPayment).not.toHaveBeenCalled();
  });

  it('the owner always passes, without resolving grants', async () => {
    const req = baseReq({ id: 'owner-1', tenantId: 'tenant-1', role: 'GYM_HOST', isHost: true });
    const res = fakeRes();
    const next = jest.fn();

    await paymentsController.verifyPayment(req, res, next);

    expect(accessService.resolve).not.toHaveBeenCalled();
    expect(paymentService.verifyPayment).toHaveBeenCalled();
  });

  it('404s cleanly when the payment does not exist, before any permission check', async () => {
    const req = baseReq(
      { id: 'manager-1', tenantId: 'tenant-1', role: 'BRANCH_MANAGER' },
      { tenantDb: { models: { Payment: { findByPk: jest.fn().mockResolvedValue(null) } } } }
    );
    const res = fakeRes();
    const next = jest.fn();

    await paymentsController.verifyPayment(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(accessService.resolve).not.toHaveBeenCalled();
  });
});
