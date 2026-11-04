/**
 * NEW-212 (P2): POST /payments/:id/printed always answered 500. markPrinted used `Payment`
 * without taking it from req.tenantDb.models (ReferenceError: Payment is not defined), so no
 * receipt print was ever recorded. Found by ESLint no-undef (NEW-204).
 *
 * Persona matrix: owner and branch manager record the print; front desk, trainer and cleaner
 * record it only with payments.view at the branch; a member, another tenant's owner and an
 * anonymous caller never do. Nobody gets a 500.
 */
const { setupTestDatabases, teardownTestDatabases, factories, setupPersonas, asPersona } = require('../harness');
const accessService = require('../../src/services/access.service');

describe('NEW-212 POST /payments/:id/printed', () => {
  let dbHarness;
  let personas;
  let branchId;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    const branch = await dbHarness.tenant1.models.Branch.findOne({ where: { status: 'ACTIVE' } });
    branchId = branch.id;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  const newPayment = () => factories.createPayment(dbHarness.tenant1, branchId, { amount: 1500, paidAt: new Date() });

  it.each(['owner', 'manager'])('%s records the print', async (name) => {
    const payment = await newPayment();
    const res = await asPersona(name).post(`/payments/${payment.id}/printed`);
    expect(res.status).toBe(200);
    await payment.reload();
    expect(payment.printedAt).toBeTruthy();
    expect(payment.printedBy).toBe(personas[name].user.id);
  });

  it.each(['frontDesk', 'trainer', 'cleaner'])('%s records it only with payments.view at the branch', async (name) => {
    const payment = await newPayment();
    const grants = await accessService.resolve(dbHarness.tenant1, personas[name].tenantId, personas[name].user.id, branchId);
    const res = await asPersona(name).post(`/payments/${payment.id}/printed`);
    await payment.reload();
    if (grants.has('payments.view')) {
      expect(res.status).toBe(200);
      expect(payment.printedAt).toBeTruthy();
    } else {
      expect(res.status).toBe(404);
      expect(payment.printedAt).toBeFalsy();
    }
  });

  it.each(['member', 'otherTenantOwner', 'anonymous'])('%s cannot record it', async (name) => {
    const payment = await newPayment();
    const res = await asPersona(name).post(`/payments/${payment.id}/printed`);
    // A member with no tenant is refused by tenantContext (400) before the route runs.
    expect([400, 401, 403, 404]).toContain(res.status);
    await payment.reload();
    expect(payment.printedAt).toBeFalsy();
  });

  it('an unknown payment is 404, not 500', async () => {
    const res = await asPersona('owner').post('/payments/00000000-0000-4000-8000-000000000000/printed');
    expect(res.status).toBe(404);
  });
});
