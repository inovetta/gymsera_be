/**
 * Integration Test: Payment Business Date Repair Script (Step 2.9)
 *
 * Verifies:
 * 1. PREVIEW mode performs ZERO writes (payments unchanged, 0 audit logs).
 * 2. Refuses --apply without --confirm.
 * 3. APPLY mode:
 *    - Repairs open-day mismatched payments to correct canonical day.
 *    - Skips payments touching a CLOSED ledger day (marks needs manual adjustment).
 *    - Writes one audit_logs row per change.
 * 4. Second run is idempotent (repaired rows are no longer mismatched; 0 writes).
 * 5. Direct updates without allowBusinessDateRepair: true are rejected by the immutability hook.
 */
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const {
  processTenantPaymentRepair,
  repairAllTenantsPaymentBusinessDates,
  normalizeDateStr,
} = require('../../src/scripts/repair-payment-business-dates');

describe('Step 2.9: Repair script for payments on the wrong day', () => {
  let dbHarness;
  let tenantSeq;
  let models;
  let branch;
  let gym;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenantSeq = dbHarness.tenant1.sequelize;
    models = dbHarness.tenant1.models;

    const { Gym, Branch } = models;
    gym = await Gym.create({ name: 'Repair Test Gym' });
    branch = await Branch.create({
      gymId: gym.id,
      branchName: 'Main Branch',
      timezone: 'Asia/Karachi',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('PREVIEW mode detects mismatches, distinguishes open vs closed days, and makes ZERO writes', async () => {
    const { Payment, LedgerDay, AuditLog } = models;

    // 1. Create a closed ledger day for 2026-09-10
    await LedgerDay.create({
      branchId: branch.id,
      businessDate: '2026-09-10',
      status: 'CLOSED',
      openedAt: new Date('2026-09-10T08:00:00.000Z'),
      closedAt: new Date('2026-09-10T22:00:00.000Z'),
    });

    // 2. Insert test payments:
    // Row 1 (Open day): Cash created at 23:30 PKT (18:30 UTC) on 2026-09-25.
    // Correct day: 2026-09-25. Deliberately store wrong business_date: 2026-09-26.
    const pOpen = await Payment.create({
      userId: '772b1504-0a7e-4f7f-9610-c2d437aa8f3b',
      branchId: branch.id,
      amount: '500.00',
      currency: 'PKR',
      method: 'CASH',
      status: 'COMPLETED',
      businessDate: '2026-09-26', // wrong day!
    });
    // Override created_at/updated_at directly via raw SQL so it represents 23:30 PKT
    await tenantSeq.query(
      'UPDATE payments SET created_at = "2026-09-25 18:30:00", updated_at = "2026-09-25 18:30:00", collected_at = NULL, paid_at = "2026-09-26 05:00:00" WHERE id = ?',
      { replacements: [pOpen.id] }
    );

    // Row 2 (Closed day): Touches 2026-09-10 which is CLOSED
    const pClosed = await Payment.create({
      userId: '772b1504-0a7e-4f7f-9610-c2d437aa8f3b',
      branchId: branch.id,
      amount: '1200.00',
      currency: 'PKR',
      method: 'ONLINE',
      status: 'COMPLETED',
      businessDate: '2026-09-10', // touches closed day!
    });
    await tenantSeq.query(
      'UPDATE payments SET created_at = "2026-09-11 10:00:00", updated_at = "2026-09-11 10:00:00", collected_at = NULL, paid_at = "2026-09-11 10:00:00" WHERE id = ?',
      { replacements: [pClosed.id] }
    );

    // Count audits before preview
    const auditsBefore = await AuditLog.count({ where: { action: 'payment.business_date.repair' } });

    // 3. Execute PREVIEW (apply: false)
    const previewResult = await processTenantPaymentRepair(
      tenantSeq,
      { tenantId: 'test-tenant-1', gymName: 'Test Gym' },
      { apply: false, quiet: true }
    );

    expect(previewResult.mismatches.length).toBeGreaterThanOrEqual(2);

    const openMismatch = previewResult.mismatches.find((m) => m.paymentId === pOpen.id);
    expect(openMismatch).toBeDefined();
    expect(openMismatch.currentDay).toBe('2026-09-26');
    expect(openMismatch.correctDay).toBe('2026-09-25');
    expect(openMismatch.action).toBe('ELIGIBLE');
    expect(openMismatch.touchesClosedDay).toBe(false);

    const closedMismatch = previewResult.mismatches.find((m) => m.paymentId === pClosed.id);
    expect(closedMismatch).toBeDefined();
    expect(closedMismatch.currentDay).toBe('2026-09-10');
    expect(closedMismatch.correctDay).toBe('2026-09-11');
    expect(closedMismatch.action).toBe('NEEDS_MANUAL_ADJUSTMENT');
    expect(closedMismatch.touchesClosedDay).toBe(true);

    // 4. Verify ZERO writes were made
    const pOpenReloaded = await Payment.findByPk(pOpen.id);
    expect(normalizeDateStr(pOpenReloaded.businessDate)).toBe('2026-09-26'); // Still wrong

    const pClosedReloaded = await Payment.findByPk(pClosed.id);
    expect(normalizeDateStr(pClosedReloaded.businessDate)).toBe('2026-09-10'); // Still wrong

    const auditsAfter = await AuditLog.count({ where: { action: 'payment.business_date.repair' } });
    expect(auditsAfter).toBe(auditsBefore); // 0 audit logs written
  });

  test('refuses to run --apply without --confirm', async () => {
    await expect(
      repairAllTenantsPaymentBusinessDates({ apply: true, confirm: false, quiet: true })
    ).rejects.toThrow('Safety check failed: --apply requires --confirm flag');
  });

  test('APPLY mode updates open-day rows, skips closed-day rows, and writes audit_logs', async () => {
    const { Payment, AuditLog } = models;

    // Run in APPLY mode
    const applyResult = await processTenantPaymentRepair(
      tenantSeq,
      { tenantId: 'test-tenant-1', gymName: 'Test Gym' },
      { apply: true, quiet: true }
    );

    expect(applyResult.repairedCount).toBeGreaterThanOrEqual(1);
    expect(applyResult.skippedClosedCount).toBeGreaterThanOrEqual(1);

    // 1. Verify open row was updated to correct canonical date
    const allPayments = await Payment.findAll();
    const openRow = allPayments.find((p) => p.amount === '500.00' && p.method === 'CASH');
    expect(normalizeDateStr(openRow.businessDate)).toBe('2026-09-25');

    // 2. Verify closed row was SKIPPED and never modified
    const closedRow = allPayments.find((p) => p.amount === '1200.00' && p.method === 'ONLINE');
    expect(normalizeDateStr(closedRow.businessDate)).toBe('2026-09-10');

    // 3. Verify audit_logs row was created for the repaired payment
    const audit = await AuditLog.findOne({
      where: {
        action: 'payment.business_date.repair',
        targetId: openRow.id,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit.branchId).toBe(branch.id);
    expect(audit.beforeState).toEqual(
      expect.objectContaining({
        business_date: '2026-09-26',
      })
    );
    expect(audit.afterState).toEqual(
      expect.objectContaining({
        business_date: '2026-09-25',
        timezone: 'Asia/Karachi',
      })
    );

    // 4. Verify no audit log was created for the skipped closed row
    const closedAudit = await AuditLog.findOne({
      where: {
        action: 'payment.business_date.repair',
        targetId: closedRow.id,
      },
    });
    expect(closedAudit).toBeNull();
  });

  test('running a second time is idempotent (finds 0 eligible repairs, makes 0 writes)', async () => {
    const { AuditLog } = models;
    const auditCountBefore = await AuditLog.count({ where: { action: 'payment.business_date.repair' } });

    // Second run
    const secondResult = await processTenantPaymentRepair(
      tenantSeq,
      { tenantId: 'test-tenant-1', gymName: 'Test Gym' },
      { apply: true, quiet: true }
    );

    expect(secondResult.repairedCount).toBe(0);
    expect(secondResult.eligibleCount).toBe(0);

    // Audit log count has not increased
    const auditCountAfter = await AuditLog.count({ where: { action: 'payment.business_date.repair' } });
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  test('direct update mutating business_date without allowBusinessDateRepair is rejected by immutability hook', async () => {
    const { Payment } = models;
    const payment = await Payment.findOne();

    payment.businessDate = '2026-01-01';
    await expect(payment.save()).rejects.toThrow(
      'business_date is immutable and cannot be changed once set'
    );
  });
});
