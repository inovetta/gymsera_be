const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  asPersona,
} = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { PaymentStatus } = require('../../src/constants/payment-status');
const { Tenant, User } = require('../../src/models/platform');

describe('SEC-13: Payout Account Changes: Re-auth, Owner Notification, and Cooling Period (spec §12)', () => {
  let dbHarness;
  let personas;
  let tenant1;
  let branchId;
  let appServer;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant1 = dbHarness.tenant1;
    personas = await setupPersonas(dbHarness);
    appServer = await startTestServer();

    const { Branch, Payment } = tenant1.models;
    const branch = await Branch.findOne({ where: { status: 'ACTIVE' } });
    branchId = branch.id;

    // Seed a completed payment so there is available balance
    await Payment.create({
      userId: personas.member.user.id,
      branchId,
      amount: '5000.00',
      currency: 'PKR',
      method: 'CASH',
      status: PaymentStatus.COMPLETED,
      paidAt: new Date(),
      businessDate: '2026-09-30',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('PATCH /gyms/profile with paymentDetailsJson without password returns 401 reauth_required', async () => {
    const res = await asPersona('owner').patch('/gyms/profile', {
      paymentDetailsJson: {
        bankName: 'Standard Chartered',
        accountTitle: 'Attacker Account',
        accountNumber: '9999999999',
      },
    });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('reauth_required');
  });

  test('PATCH /gyms/profile with paymentDetailsJson and incorrect password returns 401 invalid_credentials', async () => {
    const res = await asPersona('owner').patch('/gyms/profile', {
      paymentDetailsJson: {
        bankName: 'Standard Chartered',
        accountTitle: 'Attacker Account',
        accountNumber: '9999999999',
      },
      password: 'WrongPassword123!',
    });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_credentials');
  });

  test('Non-authorized persona (cleaner) attempting to update paymentDetailsJson returns 403 Forbidden', async () => {
    const res = await asPersona('cleaner').patch('/gyms/profile', {
      paymentDetailsJson: {
        bankName: 'HBL',
        accountTitle: 'Cleaner Rogue Account',
        accountNumber: '1122334455',
      },
      password: 'Password123!',
    });

    expect(res.status).toBe(403);
  });

  test('Updating paymentDetailsJson with valid re-auth stamps paymentDetailsUpdatedAt and sends owner notification', async () => {
    // Default password for test persona users created by harness is 'Password123!'
    const res = await asPersona('owner').patch('/gyms/profile', {
      paymentDetailsJson: {
        bankName: 'Habib Bank Limited',
        accountTitle: 'Alpha Fitness Main',
        accountNumber: '12345678901234',
        iban: 'PK12HABB0012345678901234',
      },
      password: 'Test@12345',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify Tenant in Platform DB has paymentDetailsUpdatedAt stamped
    const tenant = await Tenant.findByPk(personas.owner.tenantId);
    expect(tenant.paymentDetailsUpdatedAt).not.toBeNull();
    const updateTime = new Date(tenant.paymentDetailsUpdatedAt).getTime();
    expect(Date.now() - updateTime).toBeLessThan(10000); // Updated within last 10 seconds

    // Verify notification was sent
    const { Notification } = require('../../src/models/platform');
    const alertNotif = await Notification.findOne({
      where: {
        userId: personas.owner.user.id,
        type: 'SECURITY_ALERT',
      },
    });
    expect(alertNotif).not.toBeNull();
    expect(alertNotif.title).toMatch(/Security Alert/);
  });

  test('Immediate payout request after bank details update is BLOCKED by cooling period (422 cooling_period_active)', async () => {
    const res = await asPersona('owner', { 'Idempotency-Key': 'payout-cooling-' + Date.now() })
      .post('/host/payouts', {
        branchId,
        amount: 1000,
        notes: 'Immediate payout attempt right after bank details change',
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('cooling_period_active');
    expect(res.body.message).toMatch(/cooling period/i);
  });

  test('Payout request succeeds once cooling period expires (simulated by setting timestamp >24h ago)', async () => {
    // Simulate cooling period expiration (25 hours ago)
    const expiredCoolingDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await Tenant.update(
      { paymentDetailsUpdatedAt: expiredCoolingDate },
      { where: { id: personas.owner.tenantId } }
    );

    const res = await asPersona('owner', { 'Idempotency-Key': 'payout-cooled-' + Date.now() })
      .post('/host/payouts', {
        branchId,
        amount: 1000,
        notes: 'Payout after cooling period expired',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.amount).toBe('1000.00');
    expect(res.body.data.status).toBe('PENDING');
  });
});
