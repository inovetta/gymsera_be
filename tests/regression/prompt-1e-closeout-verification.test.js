/**
 * Regression Test: Prompt 1E Close-Out Verification
 *
 * Verifies two specific integration concerns:
 *
 * PART 1: PAY-03 Payment Immutability Hook vs repair-payment-business-dates.js
 * 1. Confirms the repair script's update path against a COMPLETED payment with wrong business_date
 *    succeeds without error via allowBusinessDateRepair: true.
 * 2. Confirms direct mutations without allowBusinessDateRepair are blocked.
 * 3. Confirms financial fields (amount, currency, paidAt, branchId) on COMPLETED payments remain immutable.
 *
 * PART 2: PAY-02 Money-Math Conversion vs Existing Production Payment Data
 * 1. Reads payment rows stored the OLD way via raw SQL (e.g. 19.99, 0.10, 0.20, 100.20, 100.10).
 * 2. Confirms reading through toMinorUnits / fromMinorUnits produces exact same displayed string.
 * 3. Recomputes ledger totals over existing data under NEW math, confirming zero float drift.
 * 4. Confirms gymsera-member-money-check.js float precision query correctly distinguishes
 *    legitimately-stored decimals from sub-cent float anomalies.
 */
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
const {
  toMinorUnits,
  fromMinorUnits,
  toMajorUnitsNumber,
  sumMoney,
  subtractMoney,
} = require('../../src/utils/money.utils');
const {
  processTenantPaymentRepair,
  normalizeDateStr,
} = require('../../src/scripts/repair-payment-business-dates');

describe('Prompt 1E Close-Out Verification: Integration Risks', () => {
  let dbHarness;
  let tenant1;
  let tenantSeq;
  let branch;
  let testUser;
  let Payment;
  let LedgerDay;
  let AuditLog;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant1 = dbHarness.tenant1;
    tenantSeq = tenant1.sequelize;
    Payment = tenant1.models.Payment;
    LedgerDay = tenant1.models.LedgerDay;
    AuditLog = tenant1.models.AuditLog;

    testUser = await createUser({
      email: 'closeout-verify@test.com',
      fullName: 'Closeout Verification User',
      role: 'MEMBER',
    });

    const tenantRecord = await createTenant({
      id: '44444444-4444-4444-8444-444444444444',
      tenantCode: 'GYM-CLOSEOUT',
      gymName: 'Closeout Gym',
      ownerUserId: testUser.id,
      connectionStringEncrypted: tenant1.encryptedConnStr,
    });

    const gymListing = await createGymListing(tenantRecord.id, { title: 'Closeout Gym Listing' });
    branch = await createBranch(tenant1, gymListing.id, {
      name: 'Closeout Branch',
      timezone: 'Asia/Karachi',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('PART 1: PAY-03 Immutability Hook vs repair-payment-business-dates.js', () => {
    test('repair-payment-business-dates.js update path succeeds on a COMPLETED payment with wrong business_date', async () => {
      // 1. Create completed payment on 2026-09-25 at 23:30 PKT (18:30 UTC), but with wrong business_date 2026-09-26
      const payment = await Payment.create({
        userId: testUser.id,
        branchId: branch.id,
        amount: '1500.00',
        currency: 'PKR',
        method: 'CASH',
        status: PaymentStatus.COMPLETED,
        businessDate: '2026-09-26', // wrong!
      });

      // Override created_at to 18:30 UTC so canonical collection date in Asia/Karachi is 2026-09-25
      await tenantSeq.query(
        'UPDATE payments SET created_at = "2026-09-25 18:30:00", updated_at = "2026-09-25 18:30:00", collected_at = NULL, paid_at = "2026-09-26 05:00:00" WHERE id = ?',
        { replacements: [payment.id] }
      );

      // 2. Run actual repair tool in APPLY mode
      const repairResult = await processTenantPaymentRepair(
        tenantSeq,
        { tenantId: 'test-closeout-tenant', gymName: 'Closeout Gym' },
        { apply: true, quiet: true }
      );

      expect(repairResult.repairedCount).toBeGreaterThanOrEqual(1);

      // 3. Verify payment was repaired to correct business_date
      await payment.reload();
      expect(normalizeDateStr(payment.businessDate)).toBe('2026-09-25');

      // 4. Verify an audit trail entry was recorded
      const audit = await AuditLog.findOne({
        where: {
          action: 'payment.business_date.repair',
          targetId: payment.id,
        },
      });
      expect(audit).not.toBeNull();
      expect(audit.beforeState).toEqual(
        expect.objectContaining({ business_date: '2026-09-26' })
      );
      expect(audit.afterState).toEqual(
        expect.objectContaining({ business_date: '2026-09-25' })
      );
    });

    test('direct mutation of business_date without allowBusinessDateRepair is rejected by immutability hook', async () => {
      const payment = await Payment.create({
        userId: testUser.id,
        branchId: branch.id,
        amount: '2000.00',
        currency: 'PKR',
        method: 'CASH',
        status: PaymentStatus.COMPLETED,
        paidAt: new Date(),
        businessDate: '2026-09-25',
      });

      payment.businessDate = '2026-09-26';
      await expect(payment.save()).rejects.toThrow(
        /business_date is immutable and cannot be changed once set/i
      );
    });

    test('completed payment financial fields (amount, currency, paidAt, branchId) are immutable', async () => {
      const payment = await Payment.create({
        userId: testUser.id,
        branchId: branch.id,
        amount: '3500.00',
        currency: 'PKR',
        method: 'CASH',
        status: PaymentStatus.COMPLETED,
        paidAt: new Date('2026-09-25T10:00:00Z'),
        businessDate: '2026-09-25',
      });

      // Attempting to modify amount fails
      await expect(payment.update({ amount: '3000.00' })).rejects.toThrow(
        /Completed payments cannot have their amount modified/i
      );

      await payment.reload();

      // Attempting to modify currency fails
      await expect(payment.update({ currency: 'USD' })).rejects.toThrow(
        /Completed payments cannot have their currency modified/i
      );

      await payment.reload();

      // Attempting to modify branchId fails
      await expect(payment.update({ branchId: '00000000-0000-0000-0000-000000000001' })).rejects.toThrow(
        /Completed payments cannot have their branch modified/i
      );

      await payment.reload();

      // Attempting to modify paidAt fails
      await expect(payment.update({ paidAt: new Date('2026-09-20T10:00:00Z') })).rejects.toThrow(
        /Completed payments cannot have their paidAt date modified/i
      );
    });
  });

  describe('PART 2: PAY-02 Money-Math Conversion vs Existing Production Payment Data', () => {
    test('existing payment rows stored the old way read through new money utils with zero drift', async () => {
      // 1. Insert rows directly via raw SQL to simulate pre-existing production data
      const sampleAmounts = ['19.99', '0.10', '0.20', '100.20', '100.10'];
      const insertedIds = [];

      for (let i = 0; i < sampleAmounts.length; i++) {
        const id = `11111111-9999-4444-8888-${String(i).padStart(12, '0')}`;
        insertedIds.push(id);
        await tenantSeq.query(`
          INSERT INTO payments (id, user_id, branch_id, amount, currency, method, status, business_date, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'PKR', 'CASH', 'COMPLETED', '2026-09-25', NOW(), NOW())
        `, {
          replacements: [id, testUser.id, branch.id, sampleAmounts[i]],
        });
      }

      // 2. Read each payment row through Sequelize
      const existingPayments = await Payment.findAll({
        where: { id: insertedIds },
        order: [['amount', 'ASC']],
      });
      expect(existingPayments).toHaveLength(sampleAmounts.length);

      // 3. Confirm reading through toMinorUnits and fromMinorUnits yields exact stored string
      for (const p of existingPayments) {
        const storedStr = String(p.amount);
        const minor = toMinorUnits(p.amount);
        const displayedStr = fromMinorUnits(minor);

        expect(displayedStr).toBe(parseFloat(storedStr).toFixed(2));
      }

      // 4. Verify classic IEEE-754 float drift is eliminated when computing totals over old rows
      // In old JS float math:
      const floatSum = 0.10 + 0.20;
      expect(floatSum).not.toBe(0.30); // 0.30000000000000004
      expect(floatSum.toString()).toBe('0.30000000000000004');

      // Under new minor units math:
      const safeSum = sumMoney(['0.10', '0.20']);
      expect(safeSum).toBe('0.30');

      // Old JS float subtraction:
      const floatDiff = 100.20 - 100.10;
      expect(floatDiff).not.toBe(0.10); // 0.09999999999999432

      // Under new minor units subtraction:
      const safeDiff = subtractMoney('100.20', '100.10');
      expect(safeDiff).toBe('0.10');

      // 5. Total ledger sum including 19.99 and drift-prone values
      // 19.99 + 0.10 + 0.20 + 100.20 + 100.10 = 220.59 exactly
      const paymentAmounts = existingPayments.map((p) => p.amount);
      const ledgerTotal = sumMoney(paymentAmounts);
      expect(ledgerTotal).toBe('220.59');
    });

    test('gymsera-member-money-check.js Float Precision Drift query recognizes legitimate old decimals as clean', async () => {
      // Query from gymsera-member-money-check.js
      const [precisionAnomalies] = await tenantSeq.query(`
        SELECT id, amount, currency, created_at
        FROM payments
        WHERE (amount * 100) != ROUND(amount * 100, 0)
      `);

      // All legitimately stored payments (including 19.99, 0.10, 0.20) must be clean (0 anomalies)
      expect(precisionAnomalies).toHaveLength(0);

      // Verify that if a genuine fractional anomaly were inserted, the query WOULD flag it
      // (Temporary scratch table with DECIMAL(10,4) to test anomaly detection)
      await tenantSeq.query(`
        CREATE TEMPORARY TABLE temp_test_payments (
          id VARCHAR(36),
          amount DECIMAL(10, 4)
        )
      `);
      await tenantSeq.query(`
        INSERT INTO temp_test_payments VALUES
        ('clean-1', 19.9900),
        ('clean-2', 0.1000),
        ('anomalous-1', 19.9950),
        ('anomalous-2', 0.1025)
      `);

      const [testAnomalies] = await tenantSeq.query(`
        SELECT id, amount
        FROM temp_test_payments
        WHERE (amount * 100) != ROUND(amount * 100, 0)
        ORDER BY id
      `);

      expect(testAnomalies).toHaveLength(2);
      expect(testAnomalies[0].id).toBe('anomalous-1');
      expect(testAnomalies[1].id).toBe('anomalous-2');
    });
  });
});
