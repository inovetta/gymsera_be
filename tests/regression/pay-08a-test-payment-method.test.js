const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  asPersona,
} = require('../harness');
const { startTestServer } = require('../harness/test-server');
const paymentService = require('../../src/services/payment.service');

describe('PAY-08a: Method TEST impossible in production (spec §12.13, §13)', () => {
  let dbHarness;
  let personas;
  let tenant1;
  let branchId;
  let memberUserId;
  let appServer;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPaymentTestKey = process.env.PAYMENT_TEST_KEY;
  const TEST_KEY = 'valid-test-payment-key-pay08a';

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
    process.env.NODE_ENV = originalNodeEnv;
    process.env.PAYMENT_TEST_KEY = originalPaymentTestKey;
    await teardownTestDatabases();
  });

  afterEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.PAYMENT_TEST_KEY = TEST_KEY;
  });

  describe('Route: POST /payments with method TEST', () => {
    test('TEST refused with 403 in production even with a correct key', async () => {
      process.env.NODE_ENV = 'production';
      process.env.PAYMENT_TEST_KEY = TEST_KEY;

      const idempotencyKey = 'pay08a-prod-refuse-' + Date.now();
      const res = await asPersona('owner', {
        'X-Test-Payment-Key': TEST_KEY,
        'Idempotency-Key': idempotencyKey,
      }).post('/payments', {
        branchId,
        userId: memberUserId,
        amount: 2500,
        currency: 'PKR',
        method: 'TEST',
        paymentFor: 'OTHER',
        notes: 'Attempted test payment in production',
      });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/production/i);
    });

    test('TEST refused with 403 in test environment when key is missing or invalid', async () => {
      process.env.NODE_ENV = 'test';
      process.env.PAYMENT_TEST_KEY = TEST_KEY;

      // Missing header
      const resMissing = await asPersona('owner', {
        'Idempotency-Key': 'pay08a-missing-key-' + Date.now(),
      }).post('/payments', {
        branchId,
        userId: memberUserId,
        amount: 2500,
        currency: 'PKR',
        method: 'TEST',
        paymentFor: 'OTHER',
      });

      expect(resMissing.status).toBe(403);
      expect(resMissing.body.success).toBe(false);
      expect(resMissing.body.message).toMatch(/invalid or missing x-test-payment-key/i);

      // Wrong header
      const resWrong = await asPersona('owner', {
        'X-Test-Payment-Key': 'wrong-key',
        'Idempotency-Key': 'pay08a-wrong-key-' + Date.now(),
      }).post('/payments', {
        branchId,
        userId: memberUserId,
        amount: 2500,
        currency: 'PKR',
        method: 'TEST',
        paymentFor: 'OTHER',
      });

      expect(resWrong.status).toBe(403);
      expect(resWrong.body.success).toBe(false);
      expect(resWrong.body.message).toMatch(/invalid or missing x-test-payment-key/i);
    });

    test('TEST works in test environment with the correct key', async () => {
      process.env.NODE_ENV = 'test';
      process.env.PAYMENT_TEST_KEY = TEST_KEY;

      const idempotencyKey = 'pay08a-test-allowed-' + Date.now();
      const res = await asPersona('owner', {
        'X-Test-Payment-Key': TEST_KEY,
        'Idempotency-Key': idempotencyKey,
      }).post('/payments', {
        branchId,
        userId: memberUserId,
        amount: 3000,
        currency: 'PKR',
        method: 'TEST',
        paymentFor: 'OTHER',
        notes: 'Test payment in test env',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.payment).toBeDefined();
      expect(res.body.data.payment.status).toBe('COMPLETED');
      expect(res.body.data.payment.gatewayName).toBe('TEST_GATEWAY');
    });

    test('real methods (CASH) unaffected in both production and test environment', async () => {
      // In production
      process.env.NODE_ENV = 'production';
      process.env.PAYMENT_TEST_KEY = TEST_KEY;

      const resProd = await asPersona('owner', {
        'Idempotency-Key': 'pay08a-cash-prod-' + Date.now(),
      }).post('/payments', {
        branchId,
        userId: memberUserId,
        amount: 1500,
        currency: 'PKR',
        method: 'CASH',
        paymentFor: 'OTHER',
        notes: 'Cash payment in production',
      });

      expect(resProd.status).toBe(201);
      expect(resProd.body.success).toBe(true);
      expect(resProd.body.data.payment.method).toBe('CASH');

      // In test env
      process.env.NODE_ENV = 'test';

      const resTest = await asPersona('owner', {
        'Idempotency-Key': 'pay08a-cash-test-' + Date.now(),
      }).post('/payments', {
        branchId,
        userId: memberUserId,
        amount: 1500,
        currency: 'PKR',
        method: 'CASH',
        paymentFor: 'OTHER',
        notes: 'Cash payment in test env',
      });

      expect(resTest.status).toBe(201);
      expect(resTest.body.success).toBe(true);
      expect(resTest.body.data.payment.method).toBe('CASH');
    });
  });

  describe('Service: payment.service.js recordPayment with method TEST', () => {
    test('ignores TEST method auto-completion in production', async () => {
      process.env.NODE_ENV = 'production';

      const paymentData = {
        userId: memberUserId,
        branchId,
        amount: 4000,
        currency: 'PKR',
        method: 'TEST',
        paymentFor: 'OTHER',
        idempotencyKey: 'pay08a-svc-prod-' + Date.now(),
      };

      // Calling with isDirect = false
      const result = await paymentService.recordPayment(
        tenant1,
        personas.frontDesk.user.id,
        'FRONT_DESK',
        paymentData,
        false
      );

      // In production, method TEST must be ignored:
      // It must NOT auto-complete to COMPLETED, and gatewayName must not be TEST_GATEWAY
      expect(result.payment.status).toBe('PENDING');
      expect(result.payment.gatewayName).toBeNull();
      expect(result.payment.paidAt).toBeNull();
    });

    test('auto-completes TEST method in test environment', async () => {
      process.env.NODE_ENV = 'test';

      const paymentData = {
        userId: memberUserId,
        branchId,
        amount: 4000,
        currency: 'PKR',
        method: 'TEST',
        paymentFor: 'OTHER',
        idempotencyKey: 'pay08a-svc-test-' + Date.now(),
      };

      const result = await paymentService.recordPayment(
        tenant1,
        personas.frontDesk.user.id,
        'FRONT_DESK',
        paymentData,
        false
      );

      expect(result.payment.status).toBe('COMPLETED');
      expect(result.payment.gatewayName).toBe('TEST_GATEWAY');
      expect(result.payment.paidAt).not.toBeNull();
    });
  });
});
