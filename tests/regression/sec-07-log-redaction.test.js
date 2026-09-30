/**
 * SEC-07 — No sensitive data in logs (spec §12.6).
 *
 * Log-capture test: everything the app prints goes through
 * src/utils/log-redaction.js. Secrets (authorization, cookies, tokens, OTPs,
 * passwords, card data, bank accounts, CNIC, receipts) never appear; e-mails
 * and phone numbers appear only as a short hash.
 */
const { PassThrough } = require('stream');
const express = require('express');
const morgan = require('morgan');
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const logRedaction = require('../../src/utils/log-redaction');

const { redact, redactString, hashEmail, hashPhone } = logRedaction;

describe('SEC-07: log redaction rules', () => {
  test.each([
    ['Bearer header', 'auth failed for Authorization: Bearer abc.def-ghi_123', 'abc.def-ghi_123'],
    ['JWT anywhere', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX2hlcmU was rejected', 'eyJhbGciOiJIUzI1NiJ9'],
    ['query token', 'GET /api/v1/billing/webhooks/google?token=s3cr3t-push&x=1', 's3cr3t-push'],
    ['query otp', 'POST /verify?otp=482913', '482913'],
    ['CNIC', 'KYC for CNIC 35202-1234567-1 uploaded', '35202-1234567-1'],
    ['IBAN', 'payout to PK36SCBL0000001123456702 queued', 'PK36SCBL0000001123456702'],
    ['grouped card', 'card 4242 4242 4242 4242 declined', '4242 4242 4242 4242'],
    ['bare card', 'card 4111111111111111 declined', '4111111111111111'],
    ['JSON password', '{"email":"x","password":"hunter2!"}', 'hunter2!'],
    ['JSON refresh token', '{"refreshToken":"rt-plain-value"}', 'rt-plain-value'],
  ])('%s is removed from strings', (_label, input, secret) => {
    const out = redactString(input);
    expect(out).not.toContain(secret);
  });

  test('e-mails and phones are replaced by a stable short hash', () => {
    const out = redactString('sent to Ayesha.Khan@Example.com and +92 300 1234567 / 0300-1234567');
    expect(out).not.toMatch(/Ayesha\.Khan@Example\.com/i);
    expect(out).not.toContain('1234567');
    expect(out).toContain(hashEmail('ayesha.khan@example.com'));
    expect(hashEmail('A@B.co')).toBe(hashEmail(' a@b.co '));
    expect(out).toContain(hashPhone('+923001234567'));
  });

  test('ordinary identifiers stay readable (UUIDs, timestamps, amounts, dates)', () => {
    const line = 'tenant 6070f9af-f0e4-452a-8c81-911c3ba8e374 paid 4500.00 at 1727712345678 on 2026-09-30T12:28:45.044Z';
    expect(redactString(line)).toBe(line);
  });

  test('objects: secret keys removed, e-mail/phone keys hashed, nested and arrays handled, input untouched', () => {
    const input = {
      userId: 'u-1',
      email: 'owner@gym.test',
      headers: { authorization: 'Bearer zzz', Cookie: 'sid=abc' },
      body: { password: 'p@ss', otp_code: '123456', cardNumber: '4242424242424242', cvv: '123', bank: { iban: 'PK36SCBL0000001123456702' } },
      receipts: [{ purchaseToken: 'play-token', signedPayload: 'jws' }],
      phone: '03001234567',
      amount: 4500,
    };
    const snapshot = JSON.stringify(input);
    const out = redact(input);
    const printed = JSON.stringify(out);
    for (const secret of ['owner@gym.test', 'zzz', 'sid=abc', 'p@ss', '123456', '4242424242424242', 'PK36SCBL', 'play-token', '"jws"', '03001234567']) {
      expect(printed).not.toContain(secret);
    }
    expect(out.userId).toBe('u-1');
    expect(out.amount).toBe(4500);
    expect(out.email).toBe(hashEmail('owner@gym.test'));
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test('errors keep name/code but lose secrets in message and stack; circular objects do not crash', () => {
    const err = new Error('login failed for bob@example.com with Bearer abc123');
    err.code = 'E_AUTH';
    const out = redact(err);
    expect(out).toBeInstanceOf(Error);
    expect(out.code).toBe('E_AUTH');
    expect(out.message).not.toContain('bob@example.com');
    expect(out.stack).not.toContain('abc123');

    const a = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });
});

describe('SEC-07: what the running app actually prints', () => {
  let app;
  let printed;

  beforeAll(async () => {
    await setupTestDatabases();
    app = await startTestServer();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    await resetTestDatabases();
    printed = [];
    jest.spyOn(logRedaction.sink, 'write').mockImplementation((_target, method, _original, args) => {
      printed.push(`${method}: ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a instanceof Error ? { m: a.message, s: a.stack } : a))).join(' ')}`);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('console redaction is installed on the global console when the app loads', () => {
    expect(logRedaction.isConsoleRedactionInstalled(console)).toBe(true);
  });

  test('password reset for an unknown e-mail logs only the hash', async () => {
    const email = 'nobody.here@gymsera-sec07.test';
    const res = await request(app).post('/api/v1/auth/password-reset/request').send({ email });
    expect(res.status).toBeLessThan(500);
    const all = printed.join('\n');
    expect(all).not.toContain(email);
    expect(all).toContain(hashEmail(email));
  });

  test('direct console calls anywhere in the code base are redacted', () => {
    console.log('[Test] login for', 'someone@x.test', { refreshToken: 'rt-secret', phone: '+923001112223' });
    console.error(new Error('Stripe key sk_live_should_not_matter with ?token=abc'));
    expect(printed).toHaveLength(2);
    const all = printed.join('\n');
    expect(all).toContain(hashEmail('someone@x.test'));
    expect(all).not.toContain('someone@x.test');
    expect(all).not.toContain('rt-secret');
    expect(all).not.toContain('+923001112223');
    expect(all).not.toContain('token=abc');
  });

  test('morgan request lines show redacted URLs', async () => {
    logRedaction.installMorganRedaction(morgan);
    const stream = new PassThrough();
    let out = '';
    stream.on('data', (c) => { out += c.toString(); });
    const mini = express();
    mini.use(morgan('combined', { stream }));
    mini.get('*', (_req, res) => res.send('ok'));
    const server = require('http').createServer(mini);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await request(server)
        .get('/api/v1/billing/webhooks/google?token=push-secret&email=leak@x.test')
        .set('Referer', 'https://cms.test/reset?code=998877');
      await new Promise((r) => setImmediate(r));
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(out).toContain('/api/v1/billing/webhooks/google?token=[REDACTED]');
    expect(out).not.toContain('push-secret');
    expect(out).not.toContain('leak@x.test');
    expect(out).not.toContain('998877');
  });
});
