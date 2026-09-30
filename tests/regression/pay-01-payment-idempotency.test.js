const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  asPersona,
} = require('../harness');
const { startTestServer } = require('../harness/test-server');
const paymentService = require('../../src/services/payment.service');

describe('PAY-01: Payment Idempotency and Atomic Transactionality (spec §6.3, §11.2, §12)', () => {
  let dbHarness;
  let personas;
  let tenant1;
  let branchId;
  let memberUserId;
  let appServer;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant1 = dbHarness.tenant1;
    personas = await setupPersonas(dbHarness);
    appServer = await startTestServer();

    const { Branch } = tenant1.models;
    const branch = await Branch.findOne({ where: { status: 'ACTIVE' } });
    branchId = branch.id;
    memberUserId = personas.member.user.id;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('POST /payments without Idempotency-Key returns 400 idempotency_key_required', async () => {
    const res = await asPersona('owner')
      .post('/payments', {
        branchId,
        userId: memberUserId,
        amount: 2500,
        currency: 'PKR',
        method: 'CASH',
        paymentFor: 'MEMBERSHIP',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/idempotency-key.*required/i);
    expect(res.body.code).toBe('idempotency_key_required');
  });

  test('POST /payments with Idempotency-Key creates payment, and identical replay returns cached response without duplicate records', async () => {
    const { Payment, IdempotencyRecord } = tenant1.models;
    const idempotencyKey = 'pay-idemp-' + Date.now();

    const initialCount = await Payment.count();
    const payload = {
      branchId,
      userId: memberUserId,
      amount: 1500,
      currency: 'PKR',
      method: 'CASH',
      paymentFor: 'OTHER',
      notes: 'Initial registration fee',
    };

    // First call: records the payment
    const res1 = await asPersona('owner', { 'Idempotency-Key': idempotencyKey })
      .post('/payments', payload);

    expect(res1.status).toBe(201);
    expect(res1.body.success).toBe(true);
    expect(res1.body.data.payment).toBeDefined();
    expect(res1.headers['x-idempotent-replay']).toBeUndefined();

    const createdPaymentId = res1.body.data.payment.id;
    const afterFirstCount = await Payment.count();
    expect(afterFirstCount).toBe(initialCount + 1);

    // Verify idempotency record was persisted in tenant DB
    const idempRecord = await IdempotencyRecord.findOne({ where: { idempotencyKey } });
    expect(idempRecord).not.toBeNull();
    expect(idempRecord.status).toBe('RESOLVED');
    expect(idempRecord.statusCode).toBe(201);

    // Second call with same key and same payload: must be replayed
    const res2 = await asPersona('owner', { 'Idempotency-Key': idempotencyKey })
      .post('/payments', payload);

    expect(res2.status).toBe(201);
    expect(res2.headers['x-idempotent-replay']).toBe('true');
    expect(res2.body.data.payment.id).toBe(createdPaymentId);

    // Verify DB count has NOT increased
    const afterSecondCount = await Payment.count();
    expect(afterSecondCount).toBe(initialCount + 1);
  });

  test('POST /payments with same Idempotency-Key but altered payload returns 422 idempotency_key_reuse', async () => {
    const idempotencyKey = 'pay-reuse-' + Date.now();

    const res1 = await asPersona('owner', { 'Idempotency-Key': idempotencyKey })
      .post('/payments', {
        branchId,
        userId: memberUserId,
        amount: 2000,
        currency: 'PKR',
        method: 'CASH',
        paymentFor: 'OTHER',
      });
    expect(res1.status).toBe(201);

    // Second call altering amount
    const res2 = await asPersona('owner', { 'Idempotency-Key': idempotencyKey })
      .post('/payments', {
        branchId,
        userId: memberUserId,
        amount: 3500, // Altered
        currency: 'PKR',
        method: 'CASH',
        paymentFor: 'OTHER',
      });

    expect(res2.status).toBe(422);
    expect(res2.body.success).toBe(false);
    expect(res2.body.code).toBe('idempotency_key_reuse');
  });

  test('Transactional atomicity: if an error occurs during payment creation, no payment row is persisted', async () => {
    const { Payment } = tenant1.models;
    const initialCount = await Payment.count();

    // Trigger an error in transaction by attempting an invalid insert or simulating failure
    const badData = {
      branchId,
      userId: memberUserId,
      amount: 'INVALID_NUMBER_AMOUNT',
      currency: 'PKR',
      method: 'CASH',
      paymentFor: 'MEMBERSHIP',
      referenceEntityId: '00000000-0000-0000-0000-000000000000',
    };

    await expect(
      paymentService.recordPayment(tenant1, personas.owner.user.id, 'GYM_HOST', badData, true)
    ).rejects.toThrow();

    const finalCount = await Payment.count();
    expect(finalCount).toBe(initialCount);
  });

  test('Caller without branch permission gets 403 Forbidden without requiring idempotency key', async () => {
    // Cleaner has no branch payment record permission
    const res = await asPersona('cleaner')
      .post('/payments', {
        branchId,
        userId: memberUserId,
        amount: 1000,
        method: 'CASH',
      });

    expect(res.status).toBe(403);
  });
});
