const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
} = require('../harness');
const { createUser } = require('../harness/factories');
const { recordPayment } = require('../../src/services/payment.service');
const ledgerService = require('../../src/services/ledger.service');

describe('PAY-06: Collector accountability & cash per collector at daily close', () => {
  let dbHarness;
  let personas;
  let tenant1Db;
  let branch;
  let staffCollector1;
  let staffCollector2;
  let member1;
  let member2;
  let businessDate;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenant1Db = dbHarness.tenant1;

    const { Branch } = tenant1Db.models;
    branch = await Branch.findOne({ where: { status: 'ACTIVE' } });

    staffCollector1 = await createUser({
      role: 'BRANCH_MANAGER',
      email: 'collector1@gymsera.test',
      fullName: 'Collector Alice',
    });

    staffCollector2 = await createUser({
      role: 'BRANCH_MANAGER',
      email: 'collector2@gymsera.test',
      fullName: 'Collector Bob',
    });

    member1 = await createUser({
      role: 'MEMBER',
      email: 'member1.pay06@gymsera.test',
      fullName: 'Member One',
    });

    member2 = await createUser({
      role: 'MEMBER',
      email: 'member2.pay06@gymsera.test',
      fullName: 'Member Two',
    });

    businessDate = '2026-10-05';
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('1. Cash payment records collectedBy and shift', async () => {
    const { payment } = await recordPayment(
      tenant1Db,
      staffCollector1.id,
      'BRANCH_MANAGER',
      {
        userId: member1.id,
        branchId: branch.id,
        amount: 2500,
        currency: 'PKR',
        method: 'CASH',
        paymentFor: 'MEMBERSHIP',
        staffCollectedBy: staffCollector1.id,
        shift: 'MORNING',
        businessDate,
      },
      true
    );

    expect(payment).toBeDefined();
    expect(payment.staffCollectedBy).toBe(staffCollector1.id);
    expect(payment.shift).toBe('MORNING');
    expect(payment.method).toBe('CASH');
  });

  test('2. Ledger totals breakdown includes cash per collector vs expected', async () => {
    // Payment 2: Collected by Collector 1 in MORNING shift
    await recordPayment(
      tenant1Db,
      staffCollector1.id,
      'BRANCH_MANAGER',
      {
        userId: member2.id,
        branchId: branch.id,
        amount: 1500,
        currency: 'PKR',
        method: 'CASH',
        paymentFor: 'MEMBERSHIP',
        staffCollectedBy: staffCollector1.id,
        shift: 'MORNING',
        businessDate,
      },
      true
    );

    // Payment 3: Collected by Collector 2 in EVENING shift
    await recordPayment(
      tenant1Db,
      staffCollector2.id,
      'BRANCH_MANAGER',
      {
        userId: member1.id,
        branchId: branch.id,
        amount: 3000,
        currency: 'PKR',
        method: 'CASH',
        paymentFor: 'MEMBERSHIP',
        staffCollectedBy: staffCollector2.id,
        shift: 'EVENING',
        businessDate,
      },
      true
    );

    const ledger = await ledgerService.getDayLedger(tenant1Db, branch.id, businessDate);

    expect(ledger).toBeDefined();
    expect(ledger.byCollector).toBeDefined();

    const c1 = ledger.byCollector.find((c) => c.collectorId === staffCollector1.id);
    expect(c1).toBeDefined();
    expect(c1.collectorName).toBe('Collector Alice');
    expect(c1.cashCollected).toBe(4000); // 2500 + 1500
    expect(c1.cashExpected).toBe(4000);
    expect(c1.shifts).toBeDefined();
    expect(c1.shifts.MORNING).toBeDefined();
    expect(c1.shifts.MORNING.cashCollected).toBe(4000);

    const c2 = ledger.byCollector.find((c) => c.collectorId === staffCollector2.id);
    expect(c2).toBeDefined();
    expect(c2.collectorName).toBe('Collector Bob');
    expect(c2.cashCollected).toBe(3000);
    expect(c2.cashExpected).toBe(3000);
    expect(c2.shifts.EVENING).toBeDefined();
    expect(c2.shifts.EVENING.cashCollected).toBe(3000);
  });

  test('3. closeDay snapshots cash per collector vs expected into closedCollectors', async () => {
    const ledgerBefore = await ledgerService.getDayLedger(tenant1Db, branch.id, businessDate);
    const ctx = {
      tenantDb: tenant1Db,
      tenantId: personas.owner.tenantId,
      userId: personas.manager.user.id,
      branchId: branch.id,
    };

    const closedDay = await ledgerService.closeDay(ctx, { ledgerDayId: ledgerBefore.ledgerDay.id });

    expect(closedDay.status).toBe('CLOSED');
    expect(closedDay.closedCollectorsJson).toBeDefined();

    const snapshot = typeof closedDay.closedCollectorsJson === 'string'
      ? JSON.parse(closedDay.closedCollectorsJson)
      : closedDay.closedCollectorsJson;

    expect(Array.isArray(snapshot)).toBe(true);
    const snapCollector1 = snapshot.find((c) => c.collectorId === staffCollector1.id);
    expect(snapCollector1).toBeDefined();
    expect(snapCollector1.cashCollected).toBe(4000);
    expect(snapCollector1.cashExpected).toBe(4000);

    // Reading ledger day after close returns snapshot
    const ledgerAfter = await ledgerService.getDayLedger(tenant1Db, branch.id, businessDate);
    expect(ledgerAfter.ledgerDay.status).toBe('CLOSED');
    expect(ledgerAfter.closedCollectors).toBeDefined();
    expect(ledgerAfter.closedCollectors.length).toBeGreaterThan(0);
  });
});
