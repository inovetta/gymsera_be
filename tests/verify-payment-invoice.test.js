/**
 * Regression test: verifying a payment whose subscription has no matching
 * `ISSUED` invoice used to silently do nothing to invoices at all — the
 * `Invoice.update({...}, {where: {status: 'ISSUED', ...}})` call matched zero
 * rows and nobody noticed. Every subscription created before invoices were
 * consistently generated on enrolment hits this; the invoice for it can never
 * exist. A completed payment should always end up with a paid invoice behind
 * it, so verifyPayment now creates the missing one rather than leaving the gap.
 */
const { PaymentStatus, InvoiceStatus } = require('../src/constants/payment-status');

describe('paymentService.verifyPayment — invoice backfill', () => {
  let paymentService;
  let tenantDb;

  const buildTenantDb = () => {
    const paymentRow = {
      id: 'payment-1',
      referenceEntityId: 'sub-1',
      paymentFor: 'MEMBERSHIP',
      amount: '2000.00',
      status: PaymentStatus.PENDING,
      branchId: 'branch-1',
      userId: 'user-1',
      update: jest.fn().mockImplementation(function (fields) {
        Object.assign(this, fields);
        return Promise.resolve(this);
      }),
      reload: jest.fn().mockImplementation(function () {
        return Promise.resolve(this);
      }),
    };

    const subscriptionRow = {
      id: 'sub-1',
      membershipPlanId: 'plan-1',
      branchId: 'branch-1',
      status: 'PENDING',
      update: jest.fn().mockResolvedValue(true),
    };
    const planRow = { id: 'plan-1', price: '2000.00', joiningFee: '0', securityFee: '0', name: 'Monthly' };

    return {
      tenantId: 'tenant-1',
      models: {
        Payment: { findByPk: jest.fn().mockResolvedValue(paymentRow) },
        // Zero rows updated — the exact scenario that used to leave a
        // verified payment with no invoice at all.
        Invoice: { update: jest.fn().mockResolvedValue([0]), create: jest.fn().mockResolvedValue({ id: 'inv-1' }) },
        MemberSubscription: { findByPk: jest.fn().mockResolvedValue(subscriptionRow) },
        MembershipPlan: { findByPk: jest.fn().mockResolvedValue(planRow) },
      },
      paymentRow,
    };
  };

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/models/platform', () => ({
      Tenant: { findByPk: jest.fn().mockResolvedValue({ id: 'tenant-1', gymName: 'Test Gym' }) },
      User: { findByPk: jest.fn().mockResolvedValue({ id: 'user-1', fullName: 'Test Member' }) },
      UserGymMembership: {
        findOrCreate: jest.fn().mockResolvedValue([{}, true]),
        update: jest.fn().mockResolvedValue([1]),
      },
    }));
    jest.doMock('../src/jobs/queues', () => ({ notificationsQueue: { add: jest.fn() } }));
    jest.doMock('../src/services/notifications.service', () => ({ createNotification: jest.fn() }));
    paymentService = require('../src/services/payment.service');
    tenantDb = buildTenantDb();
  });

  afterEach(() => {
    jest.dontMock('../src/models/platform');
    jest.dontMock('../src/jobs/queues');
    jest.dontMock('../src/services/notifications.service');
  });

  it('creates a PAID invoice when no ISSUED invoice existed to update', async () => {
    await paymentService.verifyPayment(tenantDb, 'payment-1', 'verifier-1', null);

    expect(tenantDb.models.Invoice.update).toHaveBeenCalled();
    expect(tenantDb.models.Invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        referenceEntityId: 'sub-1',
        branchId: 'branch-1',
        status: InvoiceStatus.PAID,
      })
    );
  });

  it('does not create a duplicate invoice when the update already matched a row', async () => {
    tenantDb.models.Invoice.update.mockResolvedValue([1]); // an ISSUED invoice existed and got updated

    await paymentService.verifyPayment(tenantDb, 'payment-1', 'verifier-1', null);

    expect(tenantDb.models.Invoice.create).not.toHaveBeenCalled();
  });

  it('never throws the verify flow even if invoice backfill itself fails', async () => {
    tenantDb.models.Invoice.create.mockRejectedValue(new Error('db unavailable'));

    await expect(
      paymentService.verifyPayment(tenantDb, 'payment-1', 'verifier-1', null)
    ).resolves.not.toThrow();
  });
});
