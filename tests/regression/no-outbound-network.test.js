/**
 * R-19 regression — test runs have NO network path to Apple, Google or Stripe
 * (or any other remote host). Proves the jail in tests/harness/no-network.js,
 * loaded by jest.config.js `setupFiles`, rather than relying on blanked keys.
 *
 * Safety of this test itself: the jail is first proven against targets that
 * can never route (an `.invalid` domain, the TEST-NET-1 address 192.0.2.1).
 * The provider-code checks run only after that, and only with freshly
 * generated FAKE credentials — never the real keys from .env.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');
const dns = require('dns');

const jail = net.Socket.prototype.__gymseraNetworkJail;

const PROVIDER_HOSTS = [
  'androidpublisher.googleapis.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'api.storekit.itunes.apple.com',
  'api.storekit-sandbox.itunes.apple.com',
  'appleid.apple.com',
  'api.stripe.com',
  'files.stripe.com',
];

const expectBlocked = async (promise) => {
  await expect(promise).rejects.toMatchObject({ code: 'TEST_NETWORK_BLOCKED' });
};

const httpsGet = (url) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, resolve);
    req.on('error', reject);
  });

describe('R-19: tests have no outbound network', () => {
  let jailProven = false;

  test('the jail is installed by jest setupFiles', () => {
    expect(jail).toBeDefined();
    expect(typeof jail.isAllowedHost).toBe('function');
  });

  test('allow-list: only local test infrastructure; every provider host and remote IP is refused', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', 'mysql']) expect(jail.isAllowedHost(host)).toBe(true);
    for (const host of [...PROVIDER_HOSTS, '8.8.8.8', '2001:4860:4860::8888', 'mail.gymsera.com']) {
      expect(jail.isAllowedHost(host)).toBe(false);
    }
  });

  test('real sockets are refused before leaving the machine: raw TCP, TLS, https, fetch and DNS', async () => {
    const before = jail.blockedAttempts.length;

    await expectBlocked(new Promise((resolve, reject) => {
      const s = net.connect({ host: '192.0.2.1', port: 443 }, resolve);
      s.on('error', reject);
    }));
    await expectBlocked(new Promise((resolve, reject) => {
      const s = tls.connect({ host: 'no-network-check.invalid', port: 443, servername: 'x.invalid' }, resolve);
      s.on('error', reject);
    }));
    await expectBlocked(httpsGet('https://no-network-check.invalid/'));
    await expect(fetch('https://no-network-check.invalid/')).rejects.toMatchObject({ cause: { code: 'TEST_NETWORK_BLOCKED' } });
    await expectBlocked(dns.promises.lookup('no-network-check.invalid'));

    expect(jail.blockedAttempts.length).toBeGreaterThanOrEqual(before + 5);
    jailProven = true;
  });

  test('DNS servers are never queried for an external name: resolve*, Resolver classes, reverse', async () => {
    const before = jail.blockedAttempts.length;
    const host = 'no-network-check.invalid';
    const cb = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

    await expectBlocked(cb((done) => dns.resolve4(host, done)));
    await expectBlocked(cb((done) => dns.resolveMx(host, done)));
    await expectBlocked(cb((done) => dns.resolve(host, 'A', done)));
    // nodemailer's way of resolving SMTP hosts
    await expectBlocked(cb((done) => new dns.Resolver().resolve4(host, done)));
    await expectBlocked(dns.promises.resolve4(host));
    await expectBlocked(new dns.promises.Resolver().resolveTxt(host));
    await expectBlocked(cb((done) => dns.reverse('192.0.2.1', done)));

    const dnsBlocks = jail.blockedAttempts.slice(before).filter((a) => a.dns);
    expect(dnsBlocks).toHaveLength(7);
  });

  test('a real nodemailer SMTP send is stopped at the DNS lookup, before any connection', async () => {
    const nodemailer = require('nodemailer');
    const before = jail.blockedAttempts.length;
    const transport = nodemailer.createTransport({ host: 'smtp.no-network-check.invalid', port: 587, secure: false });

    await expect(
      transport.sendMail({ from: 'a@example.test', to: 'b@example.test', subject: 'x', text: 'x' })
    ).rejects.toBeTruthy();

    const attempts = jail.blockedAttempts.slice(before);
    expect(attempts.some((a) => a.dns && a.host === 'smtp.no-network-check.invalid')).toBe(true);
    expect(attempts.filter((a) => !a.dns)).toEqual([]); // never got as far as a connection
  });

  test('local connections still work (localhost, 127.0.0.1, ::1 are never blocked)', async () => {
    const server = net.createServer((sock) => sock.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const before = jail.blockedAttempts.length;
    try {
      for (const host of ['localhost', '127.0.0.1']) {
        const reply = await new Promise((resolve, reject) => {
          const s = net.connect({ host, port }, () => {});
          let data = '';
          s.on('data', (d) => { data += d; });
          s.on('end', () => resolve(data));
          s.on('error', reject);
        });
        expect(reply).toBe('ok');
      }
      expect(jail.blockedAttempts.length).toBe(before);
    } finally {
      server.close();
    }
  });

  describe('provider code with credentials present still cannot reach the provider', () => {
    let tmpDir;
    const saved = {};
    const FAKE_ENV = {};

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-network-'));
      const { privateKey: rsa } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const { privateKey: ec } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const appleKeyPath = path.join(tmpDir, 'fake-apple.p8');
      fs.writeFileSync(appleKeyPath, ec.export({ type: 'pkcs8', format: 'pem' }));
      Object.assign(FAKE_ENV, {
        GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
          type: 'service_account',
          client_email: 'fake@fake-project.iam.gserviceaccount.com',
          private_key: rsa.export({ type: 'pkcs8', format: 'pem' }),
        }),
        GOOGLE_PLAY_PACKAGE_NAME: 'com.example.fake',
        APPLE_IAP_KEY_ID: 'FAKEKEYID1',
        APPLE_IAP_ISSUER_ID: '00000000-0000-4000-8000-000000000000',
        APPLE_IAP_BUNDLE_ID: 'com.example.fake',
        APPLE_IAP_PRIVATE_KEY_PATH: appleKeyPath,
        APPLE_IAP_ENVIRONMENT: 'Sandbox',
        STRIPE_SECRET_KEY: 'sk_test_fake_no_network',
      });
      for (const [k, v] of Object.entries(FAKE_ENV)) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
    });

    afterAll(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const loadIsolated = (modulePath) => {
      let mod;
      jest.isolateModules(() => {
        mod = require(modulePath);
      });
      return mod;
    };

    const attemptedHosts = (since) => jail.blockedAttempts.slice(since).map((a) => a.host);

    test('Google Play acknowledge is blocked at Google’s token endpoint', async () => {
      expect(jailProven).toBe(true);
      const since = jail.blockedAttempts.length;
      const google = loadIsolated('../../src/services/google-play-billing.service');
      await expect(google.acknowledgePurchaseIfNeeded('fake-token', 'fake-product')).rejects.toBeTruthy();
      expect(attemptedHosts(since).some((h) => /googleapis\.com$/.test(h))).toBe(true);
    });

    test('Apple App Store Server API is blocked', async () => {
      expect(jailProven).toBe(true);
      const since = jail.blockedAttempts.length;
      const apple = loadIsolated('../../src/services/apple-billing.service');
      await expect(apple.getTransactionInfo('1000000000000000')).rejects.toBeTruthy();
      expect(attemptedHosts(since)).toContain('api.storekit-sandbox.itunes.apple.com');
    });

    test('Stripe API is blocked', async () => {
      expect(jailProven).toBe(true);
      const since = jail.blockedAttempts.length;
      const stripe = loadIsolated('../../src/services/stripe-billing.service');
      await expect(stripe.stripeApi.retrieveSubscription('sub_fake')).rejects.toBeTruthy();
      expect(attemptedHosts(since)).toContain('api.stripe.com');
    });
  });
});
