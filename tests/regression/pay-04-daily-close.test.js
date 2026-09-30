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
const ledgerService = require('../../src/services/ledger.service');
const paymentService = require('../../src/services/payment.service');

describe('PAY-04: Daily Close Immutable and Timezone-Safe (spec §6.3, §12)', () => {
  let dbHarness;
  let tenant1;
  let branch;
  let testUser;
  let LedgerDay;
  let Payment;
  let ctx;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant1 = dbHarness.tenant1;
    Payment = tenant1.models.Payment;
    LedgerDay = tenant1.models.LedgerDay;

    testUser = await createUser({
      email: 'dailyclose-host@test.com',
      fullName: 'Daily Close Host',
      role: 'GYM_HOST',
    });

    const tenantRecord = await createTenant({
      id: '44444444-4444-4444-8444-444444444444',
      tenantCode: 'GYM-CLOSE',
      gymName: 'Close Gym',
      ownerUserId: testUser.id,
      connectionStringEncrypted: tenant1.encryptedConnStr,
    });

    const gymListing = await createGymListing(tenantRecord.id, { title: 'Close Gym Downtown' });
    branch = await createBranch(tenant1, gymListing.id, { name: 'Close Branch' });
    await branch.update({ timezone: 'Asia/Karachi' });

    ctx = {
      tenantDb: tenant1,
      tenantId: tenantRecord.id,
      userId: testUser.id,
      branchId: branch.id,
    };
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('Close twice -> one close (idempotent daily close)', async () => {
    const businessDate = '2026-09-20';
    const day = await ledgerService.getOrCreateLedgerDay(tenant1, branch.id, businessDate);

    // Seed one completed payment on this day
    await Payment.create({
      userId: testUser.id,
      branchId: branch.id,
      amount: '5000.00',
      currency: 'PKR',
      method: 'CASH',
      status: PaymentStatus.COMPLETED,
      paidAt: new Date('2026-09-20T10:00:00Z'),
      businessDate,
    });

    // First close
    const closedFirst = await ledgerService.closeDay(ctx, { ledgerDayId: day.id });
    expect(closedFirst.status).toBe('CLOSED');
    expect(Number(closedFirst.closedVerifiedTotal)).toBe(5000);
    const firstClosedAt = closedFirst.closedAt;

    // Second close: rejected with 409 ledger_day_closed
    let secondCloseErr = null;
    try {
      await ledgerService.closeDay(ctx, { ledgerDayId: day.id });
    } catch (err) {
      secondCloseErr = err;
    }
    expect(secondCloseErr).not.toBeNull();
    expect(secondCloseErr.statusCode).toBe(409);
    expect(secondCloseErr.code).toBe('ledger_day_closed');

    // Verify day remains cleanly closed once
    const reloaded = await LedgerDay.findByPk(day.id);
    expect(reloaded.status).toBe('CLOSED');
    expect(Number(reloaded.closedVerifiedTotal)).toBe(5000);
    expect(new Date(reloaded.closedAt).getTime()).toBe(new Date(firstClosedAt).getTime());
  });

  test('Recording a payment into a CLOSED day is rejected with 409 ledger_day_closed', async () => {
    const closedDate = '2026-09-21';
    const day = await ledgerService.getOrCreateLedgerDay(tenant1, branch.id, closedDate);
    await ledgerService.closeDay(ctx, { ledgerDayId: day.id });

    // Attempt to record a cash payment for that closed day (paidAt on closedDate)
    const paymentData = {
      branchId: branch.id,
      userId: testUser.id,
      amount: '2000.00',
      currency: 'PKR',
      method: 'CASH',
      paymentFor: 'OTHER',
      paidAt: new Date(`${closedDate}T12:00:00Z`),
      collectedAt: new Date(`${closedDate}T12:00:00Z`),
    };

    let errorThrown = null;
    try {
      await paymentService.recordPayment(tenant1, testUser.id, 'GYM_HOST', paymentData, true);
    } catch (err) {
      errorThrown = err;
    }

    expect(errorThrown).not.toBeNull();
    expect(errorThrown.statusCode).toBe(409);
    expect(errorThrown.code).toBe('ledger_day_closed');
  });

  test('Verifying a pending payment into a CLOSED day is rejected with 409 ledger_day_closed', async () => {
    const closedDate = '2026-09-22';

    // Create a pending payment before closing the day
    const payment = await Payment.create({
      userId: testUser.id,
      branchId: branch.id,
      amount: '3500.00',
      currency: 'PKR',
      method: 'CASH',
      status: PaymentStatus.PENDING,
      businessDate: closedDate,
    });

    // Now close the day
    const day = await ledgerService.getOrCreateLedgerDay(tenant1, branch.id, closedDate);
    await ledgerService.closeDay(ctx, { ledgerDayId: day.id });

    // Attempt to verify payment now that the day is closed
    let errorThrown = null;
    try {
      await paymentService.verifyPayment(tenant1, payment.id, testUser.id);
    } catch (err) {
      errorThrown = err;
    }

    expect(errorThrown).not.toBeNull();
    expect(errorThrown.statusCode).toBe(409);
    expect(errorThrown.code).toBe('ledger_day_closed');
  });

  test('addAdjustment directly against a CLOSED day is rejected with 409 ledger_day_closed', async () => {
    const closedDate = '2026-09-23';
    const day = await ledgerService.getOrCreateLedgerDay(tenant1, branch.id, closedDate);
    await ledgerService.closeDay(ctx, { ledgerDayId: day.id });

    let errorThrown = null;
    try {
      await ledgerService.addAdjustment(ctx, {
        ledgerDayId: day.id,
        type: 'VARIANCE_ADJUSTMENT',
        amount: '150.00',
        reason: 'Late cash found in desk',
      });
    } catch (err) {
      errorThrown = err;
    }

    expect(errorThrown).not.toBeNull();
    expect(errorThrown.statusCode).toBe(409);
    expect(errorThrown.code).toBe('ledger_day_closed');
  });

  test('Late adjustments posted to an OPEN day referencing a closed day succeed', async () => {
    const closedDate = '2026-09-24';
    const openDate = '2026-09-25';

    const closedDay = await ledgerService.getOrCreateLedgerDay(tenant1, branch.id, closedDate);
    await ledgerService.closeDay(ctx, { ledgerDayId: closedDay.id });

    const openDay = await ledgerService.getOrCreateLedgerDay(tenant1, branch.id, openDate);

    // Post adjustment to open day
    const adjustment = await ledgerService.addAdjustment(ctx, {
      ledgerDayId: openDay.id,
      type: 'MISSED_DAY_RECONCILIATION',
      amount: '500.00',
      reason: `Reconciliation for closed day ${closedDate}: found unrecorded receipt`,
    });

    expect(adjustment).toBeDefined();
    expect(adjustment.ledgerDayId).toBe(openDay.id);
    expect(adjustment.type).toBe('MISSED_DAY_RECONCILIATION');
  });
});
