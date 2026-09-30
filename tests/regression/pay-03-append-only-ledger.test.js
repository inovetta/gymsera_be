const {
  setupTestDatabases,
  teardownTestDatabases,
} = require('../harness');
const {
  createUser,
  createTenant,
  createGymListing,
  createBranch,
} = require('../harness/factories');
const { PaymentStatus } = require('../../src/constants/payment-status');

describe('PAY-03: Append-Only Ledger and Payment Financial Immutability (spec §6.3, §12)', () => {
  let dbHarness;
  let tenant1;
  let branch;
  let testUser;
  let LedgerDay;
  let LedgerAdjustment;
  let Payment;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant1 = dbHarness.tenant1;
    Payment = tenant1.models.Payment;
    LedgerDay = tenant1.models.LedgerDay;
    LedgerAdjustment = tenant1.models.LedgerAdjustment;

    testUser = await createUser({
      email: 'appendonly-member@test.com',
      fullName: 'Append Only Member',
      role: 'MEMBER',
    });

    const tenantRecord = await createTenant({
      id: '33333333-3333-4333-8333-333333333333',
      tenantCode: 'GYM-APPEND',
      gymName: 'Append Only Gym',
      ownerUserId: testUser.id,
      connectionStringEncrypted: tenant1.encryptedConnStr,
    });

    const gymListing = await createGymListing(tenantRecord.id, { title: 'Append Gym Branch' });
    branch = await createBranch(tenant1, gymListing.id, { name: 'Main Branch' });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('Payment Deletion Prevention', () => {
    test('instance.destroy() on Payment is rejected with an Error', async () => {
      const payment = await Payment.create({
        userId: testUser.id,
        branchId: branch.id,
        amount: '1200.00',
        currency: 'PKR',
        method: 'CASH',
        status: PaymentStatus.COMPLETED,
        paidAt: new Date(),
        businessDate: '2026-09-30',
      });

      await expect(payment.destroy()).rejects.toThrow(
        /append-only financial records and cannot be deleted/i
      );
    });

    test('Payment.destroy() bulk call is rejected with an Error', async () => {
      await expect(
        Payment.destroy({ where: { userId: testUser.id } })
      ).rejects.toThrow(
        /append-only financial records and cannot be deleted/i
      );
    });
  });

  describe('Completed Payment Financial Immutability', () => {
    test('Modifying amount on a COMPLETED payment is rejected', async () => {
      const payment = await Payment.create({
        userId: testUser.id,
        branchId: branch.id,
        amount: '3000.00',
        currency: 'PKR',
        method: 'CASH',
        status: PaymentStatus.COMPLETED,
        paidAt: new Date(),
        businessDate: '2026-09-30',
      });

      await expect(payment.update({ amount: '2500.00' })).rejects.toThrow(
        /Completed payments cannot have their amount modified/i
      );
    });

    test('Modifying currency or branchId on a COMPLETED payment is rejected', async () => {
      const payment = await Payment.create({
        userId: testUser.id,
        branchId: branch.id,
        amount: '1500.00',
        currency: 'PKR',
        method: 'CASH',
        status: PaymentStatus.COMPLETED,
        paidAt: new Date(),
        businessDate: '2026-09-30',
      });

      await expect(payment.update({ currency: 'USD' })).rejects.toThrow(
        /Completed payments cannot have their currency modified/i
      );

      await payment.reload();

      await expect(payment.update({ branchId: '00000000-0000-0000-0000-000000000001' })).rejects.toThrow(
        /Completed payments cannot have their branch modified/i
      );
    });

    test('Non-financial metadata updates on a COMPLETED payment succeed (receipt printing, notes)', async () => {
      const payment = await Payment.create({
        userId: testUser.id,
        branchId: branch.id,
        amount: '1000.00',
        currency: 'PKR',
        method: 'CASH',
        status: PaymentStatus.COMPLETED,
        paidAt: new Date(),
        businessDate: '2026-09-30',
      });

      const printedTime = new Date();
      await payment.update({
        printedAt: printedTime,
        notes: 'Printed receipt issued to customer',
      });

      await payment.reload();
      expect(payment.notes).toBe('Printed receipt issued to customer');
      expect(payment.printedAt).toBeDefined();
    });

    test('PENDING payment can have its amount adjusted prior to completion', async () => {
      const payment = await Payment.create({
        userId: testUser.id,
        branchId: branch.id,
        amount: '5000.00',
        currency: 'PKR',
        method: 'CASH',
        status: PaymentStatus.PENDING,
        businessDate: '2026-09-30',
      });

      await payment.update({ amount: '4000.00' });
      await payment.reload();
      expect(payment.amount).toBe('4000.00');
    });
  });

  describe('LedgerAdjustment Append-Only Immutability', () => {
    let day;
    let adjustment;

    beforeAll(async () => {
      day = await LedgerDay.create({
        branchId: branch.id,
        businessDate: '2026-09-29',
        status: 'OPEN',
      });

      adjustment = await LedgerAdjustment.create({
        ledgerDayId: day.id,
        type: 'VARIANCE_ADJUSTMENT',
        amount: '200.00',
        reason: 'Cash discrepancy corrected during audit',
        createdBy: testUser.id,
      });
    });

    test('LedgerAdjustment cannot be updated via instance.update()', async () => {
      await expect(adjustment.update({ amount: '300.00' })).rejects.toThrow(
        /LedgerAdjustment is append-only and cannot be updated/i
      );
    });

    test('LedgerAdjustment cannot be updated via bulk update', async () => {
      await expect(
        LedgerAdjustment.update({ amount: '300.00' }, { where: { id: adjustment.id } })
      ).rejects.toThrow(/LedgerAdjustment is append-only and cannot be updated/i);
    });

    test('LedgerAdjustment cannot be deleted via instance.destroy()', async () => {
      await expect(adjustment.destroy()).rejects.toThrow(
        /LedgerAdjustment is append-only and cannot be deleted/i
      );
    });

    test('LedgerAdjustment cannot be deleted via bulk destroy', async () => {
      await expect(
        LedgerAdjustment.destroy({ where: { id: adjustment.id } })
      ).rejects.toThrow(/LedgerAdjustment is append-only and cannot be deleted/i);
    });
  });
});
