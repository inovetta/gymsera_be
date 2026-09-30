const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  asPersona,
} = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { PaymentStatus } = require('../../src/constants/payment-status');
const { Tenant } = require('../../src/models/platform');

describe('PAY-10: Ledger-Derived Payouts and Balance (spec §6.3, §12)', () => {
  let dbHarness;
  let personas;
  let tenant1;
  let branchId;
  let Payment;
  let LedgerDay;
  let LedgerAdjustment;
  let Expense;
  let ExpenseCategory;
  let Payout;
  let appServer;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant1 = dbHarness.tenant1;
    personas = await setupPersonas(dbHarness);
    appServer = await startTestServer();

    Payment = tenant1.models.Payment;
    LedgerDay = tenant1.models.LedgerDay;
    LedgerAdjustment = tenant1.models.LedgerAdjustment;
    Expense = tenant1.models.Expense;
    ExpenseCategory = tenant1.models.ExpenseCategory;
    Payout = tenant1.models.Payout;

    const { Branch } = tenant1.models;
    const branch = await Branch.findOne({ where: { status: 'ACTIVE' } });
    branchId = branch.id;

    // Set default bank details on Tenant (with paymentDetailsUpdatedAt in the past so cooling period is inactive)
    const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
    await Tenant.update(
      {
        paymentDetailsJson: {
          bankName: 'Meezan Bank',
          accountTitle: 'Alpha Fitness Club',
          accountNumber: '01020304050607',
          iban: 'PK36MEZN0001020304050607',
        },
        paymentDetailsUpdatedAt: pastDate,
      },
      { where: { id: personas.owner.tenantId } }
    );
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('GET /host/payouts/balance dynamically derives balance from payments, reversals, expenses, and payouts', async () => {
    // 1. Initial balance should be 0.00
    const resInitial = await asPersona('owner').get(`/host/payouts/balance?branchId=${branchId}`);
    expect(resInitial.status).toBe(200);
    expect(resInitial.body.data.availableBalance).toBe('0.00');

    // 2. Add completed payment of 10,000
    await Payment.create({
      userId: personas.member.user.id,
      branchId,
      amount: '10000.00',
      currency: 'PKR',
      method: 'CASH',
      status: PaymentStatus.COMPLETED,
      paidAt: new Date(),
      businessDate: '2026-09-30',
    });

    // 3. Add reversal adjustment of 2,000
    const ledgerDay = await LedgerDay.create({
      branchId,
      businessDate: '2026-09-30',
      status: 'OPEN',
      openedAt: new Date(),
    });
    await LedgerAdjustment.create({
      ledgerDayId: ledgerDay.id,
      type: 'REVERSAL',
      amount: -2000.0,
      reason: 'Refund',
      createdBy: personas.owner.user.id,
    });

    // 4. Add paid expense of 1,500
    const cat = await ExpenseCategory.create({
      branchId,
      name: 'Maintenance',
    });
    await Expense.create({
      branchId,
      categoryId: cat.id,
      title: 'Dumbbell repairs',
      amount: 1500.0,
      expenseDate: '2026-09-30',
      createdBy: personas.owner.user.id,
    });

    // 5. Balance should now be 10000 - 2000 - 1500 = 6500.00
    const resDynamic = await asPersona('owner').get(`/host/payouts/balance?branchId=${branchId}`);
    expect(resDynamic.status).toBe(200);
    expect(resDynamic.body.data.totalCollected).toBe('10000.00');
    expect(resDynamic.body.data.totalRefunded).toBe('2000.00');
    expect(resDynamic.body.data.totalExpenses).toBe('1500.00');
    expect(resDynamic.body.data.availableBalance).toBe('6500.00');
  });

  test('POST /host/payouts without Idempotency-Key returns 400 idempotency_key_required', async () => {
    const res = await asPersona('owner').post('/host/payouts', {
      branchId,
      amount: 1000,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('idempotency_key_required');
  });

  test('POST /host/payouts with amount exceeding available balance returns 422 insufficient_balance', async () => {
    const res = await asPersona('owner', { 'Idempotency-Key': 'payout-excess-' + Date.now() })
      .post('/host/payouts', {
        branchId,
        amount: 10000, // Available is 6500
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('insufficient_balance');
  });

  test('Host (DIRECT tier) requests payout: creates PENDING payout, reduces available balance, and is idempotent', async () => {
    const idemKey = 'payout-host-' + Date.now();

    // 1. Submit valid payout of 3,000
    const res = await asPersona('owner', { 'Idempotency-Key': idemKey }).post('/host/payouts', {
      branchId,
      amount: 3000,
      notes: 'Weekly host payout',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.amount).toBe('3000.00');
    expect(res.body.data.status).toBe('PENDING');
    const payoutId = res.body.data.id;

    // 2. Available balance should now be 6,500 - 3,000 = 3,500.00
    const resBal = await asPersona('owner').get(`/host/payouts/balance?branchId=${branchId}`);
    expect(resBal.body.data.totalPayouts).toBe('3000.00');
    expect(resBal.body.data.availableBalance).toBe('3500.00');

    // 3. Replaying exact same request returns identical payout record (idempotent)
    const resReplay = await asPersona('owner', { 'Idempotency-Key': idemKey }).post('/host/payouts', {
      branchId,
      amount: 3000,
      notes: 'Weekly host payout',
    });
    expect(resReplay.status).toBe(201);
    expect(resReplay.body.data.id).toBe(payoutId);

    // 4. Verify balance is NOT deducted twice
    const resBalAfter = await asPersona('owner').get(`/host/payouts/balance?branchId=${branchId}`);
    expect(resBalAfter.body.data.availableBalance).toBe('3500.00');
  });

  test('Manager (REQUEST tier) submitting payout request creates PENDING approval request (202 Accepted)', async () => {
    const res = await asPersona('manager', { 'Idempotency-Key': 'payout-mgr-' + Date.now() })
      .post('/host/payouts', {
        branchId,
        amount: 1000,
        notes: 'Manager requesting branch operational payout',
      });

    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.approvalRequestId).toBeDefined();

    // Payout record is NOT yet created
    const pendingRequests = await tenant1.models.ApprovalRequest.findAll({
      where: { actionKey: 'payouts.request' },
    });
    expect(pendingRequests.length).toBeGreaterThan(0);
  });

  test('Cleaner (OFF tier) submitting payout is rejected with 403 Forbidden', async () => {
    const res = await asPersona('cleaner', { 'Idempotency-Key': 'payout-cleaner-' + Date.now() })
      .post('/host/payouts', {
        branchId,
        amount: 500,
      });

    expect(res.status).toBe(403);
  });
});
