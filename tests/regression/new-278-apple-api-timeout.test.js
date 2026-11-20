/**
 * NEW-278 — calls to Apple's App Store Server API have a time limit.
 *
 * apple-billing.service.js called axios.get with no timeout, so a slow Apple answer held
 * POST /billing/ios/sync open for as long as Apple took; the app gives up after 10 s
 * (dio_client.dart) without ever hearing why. Now every Apple call carries a timeout:
 * APPLE_API_TIMEOUT_MS, default 8000 (under the app's 10 s), and a timed-out call is an
 * error, never "transaction not found" (which would move on to the other environment).
 *
 * No network: axios.get is replaced; the API key is a throwaway EC key in a temp file.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const appleBilling = require('../../src/services/apple-billing.service');

const PROD = 'https://api.storekit.itunes.apple.com';
const ENV_KEYS = [
  'APPLE_IAP_KEY_ID', 'APPLE_IAP_ISSUER_ID', 'APPLE_IAP_BUNDLE_ID', 'APPLE_IAP_PRIVATE_KEY_PATH',
  'APPLE_IAP_ENVIRONMENT', 'APPLE_API_TIMEOUT_MS',
];

describe('NEW-278: Apple API calls time out', () => {
  const saved = {};
  let keyDir;
  let configs;

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'new278-apple-'));
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyPath = path.join(keyDir, 'fake-key.p8');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    Object.assign(process.env, {
      APPLE_IAP_KEY_ID: 'FAKEKEY123', APPLE_IAP_ISSUER_ID: 'fake-issuer', APPLE_IAP_BUNDLE_ID: 'com.gymsera.test',
      APPLE_IAP_PRIVATE_KEY_PATH: keyPath,
    });
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(keyDir, { recursive: true, force: true });
  });

  const tx = JSON.stringify({ originalTransactionId: '7000001', transactionId: '7000002', environment: 'Production' });

  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env.APPLE_IAP_ENVIRONMENT;
    delete process.env.APPLE_API_TIMEOUT_MS;
    configs = [];
    jest.spyOn(appleBilling.appleApi, 'verifyAndDecode').mockImplementation((jws) => JSON.parse(jws));
    jest.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      configs.push({ url, timeout: config && config.timeout });
      if (url.includes('/inApps/v1/transactions/')) return { data: { signedTransactionInfo: tx } };
      return { data: { data: [{ lastTransactions: [{ originalTransactionId: '7000001', status: 1, signedTransactionInfo: tx }] }] } };
    });
  });

  test('both the transaction lookup and the subscription status call carry the default 8000 ms', async () => {
    await appleBilling.appleApi.getLatestTransaction('7000002');
    expect(configs.map((c) => c.url)).toEqual([
      `${PROD}/inApps/v1/transactions/7000002`,
      `${PROD}/inApps/v1/subscriptions/7000001`,
    ]);
    expect(configs.map((c) => c.timeout)).toEqual([8000, 8000]);
  });

  test('APPLE_API_TIMEOUT_MS changes it; a value that is not a positive whole number keeps the default', async () => {
    process.env.APPLE_API_TIMEOUT_MS = '3000';
    await appleBilling.appleApi.getTransactionInfo('7000002');
    process.env.APPLE_API_TIMEOUT_MS = 'soon';
    await appleBilling.appleApi.getTransactionInfo('7000002');
    process.env.APPLE_API_TIMEOUT_MS = '0';
    await appleBilling.appleApi.getTransactionInfo('7000002');
    expect(configs.map((c) => c.timeout)).toEqual([3000, 8000, 8000]);
  });

  test('a timed-out call is an error, not "not found": the other environment is not asked', async () => {
    axios.get.mockImplementation(async (url, config) => {
      configs.push({ url, timeout: config && config.timeout });
      throw Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' });
    });
    await expect(appleBilling.appleApi.getTransactionInfo('7000002')).rejects.toThrow(/timeout/);
    expect(configs).toHaveLength(1);
  });
});
