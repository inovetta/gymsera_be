/**
 * UX-15 — Bank transfer instructions served from backend config per country/currency (spec §12.9).
 *
 * GET /api/v1/billing/bank-instructions
 * - Public read-only endpoint (no auth required)
 * - Returns bank transfer details configured via environment variables
 * - No hardcoded bank details in code
 * - Returns null/default values if env variables are not set
 */
const request = require('supertest');
const { startTestServer } = require('../harness/test-server');

let app;
beforeAll(async () => {
  app = await startTestServer();
});

describe('UX-15: Bank transfer instructions endpoint', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('GET /api/v1/billing/bank-instructions returns 200 without authentication', async () => {
    const res = await request(app).get('/api/v1/billing/bank-instructions');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('bankName');
    expect(res.body.data).toHaveProperty('accountTitle');
    expect(res.body.data).toHaveProperty('accountNumber');
    expect(res.body.data).toHaveProperty('iban');
    expect(res.body.data).toHaveProperty('currency');
  });

  it('reflects BANK_TRANSFER_* environment variables', async () => {
    process.env.BANK_TRANSFER_BANK_NAME = 'Test Bank Ltd';
    process.env.BANK_TRANSFER_ACCOUNT_TITLE = 'GymsEra Test Title';
    process.env.BANK_TRANSFER_ACCOUNT_NUMBER = '1234567890';
    process.env.BANK_TRANSFER_IBAN = 'PK00TEST1234567890';
    process.env.BANK_TRANSFER_SWIFT = 'TESTPKKA';
    process.env.BANK_TRANSFER_CURRENCY = 'PKR';
    process.env.BANK_TRANSFER_INSTRUCTIONS = 'Please upload your receipt after transfer.';

    const res = await request(app).get('/api/v1/billing/bank-instructions');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      bankName: 'Test Bank Ltd',
      accountTitle: 'GymsEra Test Title',
      accountNumber: '1234567890',
      iban: 'PK00TEST1234567890',
      swiftCode: 'TESTPKKA',
      currency: 'PKR',
      instructions: 'Please upload your receipt after transfer.',
    });
  });

  it('returns nulls and default currency when environment variables are unset', async () => {
    delete process.env.BANK_TRANSFER_BANK_NAME;
    delete process.env.BANK_TRANSFER_ACCOUNT_TITLE;
    delete process.env.BANK_TRANSFER_ACCOUNT_NUMBER;
    delete process.env.BANK_TRANSFER_IBAN;
    delete process.env.BANK_TRANSFER_SWIFT;
    delete process.env.BANK_TRANSFER_INSTRUCTIONS;

    const res = await request(app).get('/api/v1/billing/bank-instructions');
    expect(res.status).toBe(200);
    expect(res.body.data.bankName).toBeNull();
    expect(res.body.data.accountTitle).toBeNull();
    expect(res.body.data.accountNumber).toBeNull();
    expect(res.body.data.iban).toBeNull();
    expect(res.body.data.swiftCode).toBeNull();
    expect(res.body.data.currency).toBe('PKR');
  });

  it('supports currency query parameter override', async () => {
    const res = await request(app).get('/api/v1/billing/bank-instructions?currency=USD');
    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('USD');
  });
});
