/**
 * P7c item 4 (NEW-173, P1 launch; owner decision R-82).
 *
 * Before P7c one APPLE_IAP_ENVIRONMENT chose one App Store Server API host
 * (apple-billing.service.js#_appleApiBase). With Production set, TestFlight and
 * App Review purchases (always Sandbox) could never be verified, and their
 * Sandbox notifications could not be re-fetched.
 *
 * Now: Production first, Sandbox when Production answers "transaction not found"
 * (Apple's documented order); a notification's own `environment` goes first;
 * the follow-up subscription-status call goes to the environment that found the
 * transaction. APPLE_IAP_ENVIRONMENT=Sandbox keeps a staging server on Sandbox only.
 *
 * No network: axios.get is replaced; the API key is a throwaway EC key written
 * to a temp file (never a real key).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const appleBilling = require('../../src/services/apple-billing.service');
const billingEvents = require('../../src/services/billing-event.service');

const PROD = 'https://api.storekit.itunes.apple.com';
const SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com';
const ENV_KEYS = ['APPLE_IAP_KEY_ID', 'APPLE_IAP_ISSUER_ID', 'APPLE_IAP_BUNDLE_ID', 'APPLE_IAP_PRIVATE_KEY_PATH', 'APPLE_IAP_ENVIRONMENT'];

const notFound = () =>
  Object.assign(new Error('Request failed with status code 404'), {
    response: { status: 404, data: { errorCode: 4040010, errorMessage: 'Transaction id not found.' } },
  });

describe('P7c item 4: Apple Production first, Sandbox on transaction-not-found', () => {
  const saved = {};
  let keyDir;
  let calls;
  let routes;

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7c-apple-'));
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

  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env.APPLE_IAP_ENVIRONMENT;
    calls = [];
    routes = {};
    jest.spyOn(appleBilling.appleApi, 'verifyAndDecode').mockImplementation((jws) => JSON.parse(jws));
    jest.spyOn(axios, 'get').mockImplementation(async (url) => {
      calls.push(url);
      const hit = Object.keys(routes).find((prefix) => url.startsWith(prefix));
      if (!hit) throw notFound();
      return { data: routes[hit] };
    });
  });

  const tx = (environment) => JSON.stringify({ originalTransactionId: '2000001', transactionId: '2000002', environment });

  test('a Sandbox (TestFlight / App Review) transaction: Production answers not-found, then Sandbox', async () => {
    routes[`${SANDBOX}/inApps/v1/transactions/2000002`] = { signedTransactionInfo: tx('Sandbox') };
    const decoded = await appleBilling.appleApi.getTransactionInfo('2000002');
    expect(decoded.environment).toBe('Sandbox');
    expect(calls).toEqual([`${PROD}/inApps/v1/transactions/2000002`, `${SANDBOX}/inApps/v1/transactions/2000002`]);
  });

  test('a Production transaction is found on Production with one call', async () => {
    routes[`${PROD}/inApps/v1/transactions/2000002`] = { signedTransactionInfo: tx('Production') };
    await appleBilling.appleApi.getTransactionInfo('2000002');
    expect(calls).toEqual([`${PROD}/inApps/v1/transactions/2000002`]);
  });

  test('any other error is not retried on Sandbox (a 401 or an outage is not "not found")', async () => {
    axios.get.mockImplementation(async (url) => {
      calls.push(url);
      throw Object.assign(new Error('Request failed with status code 401'), { response: { status: 401, data: {} } });
    });
    await expect(appleBilling.appleApi.getTransactionInfo('2000002')).rejects.toThrow(/401/);
    expect(calls).toEqual([`${PROD}/inApps/v1/transactions/2000002`]);
  });

  test('the subscription-status call goes to the environment that found the transaction', async () => {
    routes[`${SANDBOX}/inApps/v1/transactions/2000002`] = { signedTransactionInfo: tx('Sandbox') };
    routes[`${SANDBOX}/inApps/v1/subscriptions/2000001`] = {
      data: [{ lastTransactions: [{ originalTransactionId: '2000001', status: 1, signedTransactionInfo: tx('Sandbox') }] }],
    };
    const latest = await appleBilling.appleApi.getLatestTransaction('2000002');
    expect(latest.subscriptionStatus).toBe(1);
    expect(calls).toEqual([
      `${PROD}/inApps/v1/transactions/2000002`,
      `${SANDBOX}/inApps/v1/transactions/2000002`,
      `${SANDBOX}/inApps/v1/subscriptions/2000001`,
    ]);
  });

  test('an environment hint (the notification payload, the stored row) is tried first', async () => {
    routes[`${SANDBOX}/inApps/v1/transactions/2000002`] = { signedTransactionInfo: tx('Sandbox') };
    await appleBilling.appleApi.getTransactionInfo('2000002', { environment: 'Sandbox' });
    expect(calls).toEqual([`${SANDBOX}/inApps/v1/transactions/2000002`]);
    calls.length = 0;
    await appleBilling.appleApi.getTransactionInfo('2000002', { environment: 'SANDBOX' }); // the row's spelling
    expect(calls).toEqual([`${SANDBOX}/inApps/v1/transactions/2000002`]);
  });

  test('APPLE_IAP_ENVIRONMENT=Sandbox keeps a staging server on Sandbox only', async () => {
    process.env.APPLE_IAP_ENVIRONMENT = 'Sandbox';
    await expect(appleBilling.appleApi.getTransactionInfo('2000002')).rejects.toThrow(/404/);
    expect(calls).toEqual([`${SANDBOX}/inApps/v1/transactions/2000002`]);
  });

  test('a Sandbox App Store notification re-fetches from Sandbox first', async () => {
    const latest = jest.spyOn(appleBilling.appleApi, 'getLatestTransaction').mockResolvedValue({
      originalTransactionId: '2000001', transactionId: '2000002', productId: 'x', environment: 'Sandbox',
    });
    jest.spyOn(require('../../src/services/subscription-migration.service'), 'resolveSubscriptionOwner').mockResolvedValue(null);
    const event = {
      provider: 'APPLE', providerEventId: 'n-1', attempts: 0, tenantId: null,
      rawPayload: JSON.stringify({
        signedPayload: JSON.stringify({
          notificationType: 'DID_RENEW',
          data: { environment: 'Sandbox', signedTransactionInfo: tx('Sandbox') },
        }),
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    await billingEvents.processEvent(event);
    expect(latest).toHaveBeenCalledWith('2000001', { environment: 'Sandbox' });
    expect(event.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'IGNORED' }));
  });
});
