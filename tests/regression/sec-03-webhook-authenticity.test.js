/**
 * SEC-03 — Webhook authenticity (spec §12.6, decision R-26).
 *
 * Every billing webhook must prove it came from the provider before anything
 * is stored:
 *  - Google RTDN: the Pub/Sub push OIDC token (Google signature, audience,
 *    service account, verified email, not expired). The old static ?token=
 *    query parameter no longer authenticates anything.
 *  - Apple: the JWS signature (already enforced; re-checked here).
 *  - Stripe: constructEvent on the raw body with the real verifier (no fake).
 * Tampered or unauthenticated payload → 400/401 and no billing_events row.
 */
const crypto = require('crypto');
const request = require('supertest');
const Stripe = require('stripe');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases } = require('../harness');
const fakes = require('../harness/billing-fakes');
const { startTestServer } = require('../harness/test-server');
const { BillingEvent } = require('../../src/models/platform');

const RTDN_PATH = '/api/v1/billing/webhooks/google';

let app;
beforeAll(async () => {
  app = await startTestServer();
});

describe('SEC-03: webhook authenticity', () => {
  beforeAll(async () => {
    await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestDatabases();
    fakes.installRtdnAuthFakes();
  });

  const body = (messageId) => fakes.rtdnBody({
    messageId,
    notification: { subscriptionNotification: { notificationType: 2, purchaseToken: 'tok-sec03', subscriptionId: 'p' } },
  });

  const expectNothingStored = async () => {
    expect(await BillingEvent.count()).toBe(0);
  };

  describe('Google RTDN (Pub/Sub push OIDC)', () => {
    test('a valid Google-signed token for our audience and service account is accepted and recorded', async () => {
      const res = await request(app).post(RTDN_PATH).set('Authorization', fakes.rtdnAuthHeader()).send(body('m-ok'));
      expect(res.status).toBe(200);
      expect(await BillingEvent.count({ where: { provider: 'GOOGLE', providerEventId: 'm-ok' } })).toBe(1);
    });

    test('no Authorization header → 401, nothing stored', async () => {
      const res = await request(app).post(RTDN_PATH).send(body('m-none'));
      expect(res.status).toBe(401);
      await expectNothingStored();
    });

    test('the old static ?token= query parameter alone → 401 (it no longer authenticates)', async () => {
      process.env.GOOGLE_PLAY_RTDN_TOKEN = 'legacy-static-token';
      try {
        const res = await request(app).post(`${RTDN_PATH}?token=legacy-static-token`).send(body('m-legacy'));
        expect(res.status).toBe(401);
        await expectNothingStored();
      } finally {
        delete process.env.GOOGLE_PLAY_RTDN_TOKEN;
      }
    });

    test('a token signed by a key that is not Google\'s → 401', async () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const res = await request(app).post(RTDN_PATH)
        .set('Authorization', fakes.rtdnAuthHeader({}, { privateKey })).send(body('m-forged'));
      expect(res.status).toBe(401);
      await expectNothingStored();
    });

    test('a payload changed after signing → 401', async () => {
      const [h, , s] = fakes.rtdnAuthHeader().slice('Bearer '.length).split('.');
      const forgedPayload = Buffer.from(JSON.stringify({
        iss: 'https://accounts.google.com', aud: fakes.RTDN_TEST_AUDIENCE, email: 'attacker@evil.test', email_verified: true,
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
      })).toString('base64url');
      const res = await request(app).post(RTDN_PATH).set('Authorization', `Bearer ${h}.${forgedPayload}.${s}`).send(body('m-tamper'));
      expect(res.status).toBe(401);
      await expectNothingStored();
    });

    test.each([
      ['another audience', { aud: 'https://someone-else.test/push' }],
      ['another service account', { email: 'intruder@other-project.iam.gserviceaccount.com' }],
      ['an unverified email', { email_verified: false }],
      ['a non-Google issuer', { iss: 'https://evil.test' }],
      ['an expired token', { iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 }],
    ])('a Google-signed token with %s → 401', async (_label, claims) => {
      const header = claims.exp
        ? `Bearer ${require('jsonwebtoken').sign(
          { iss: 'https://accounts.google.com', aud: fakes.RTDN_TEST_AUDIENCE, email: fakes.RTDN_TEST_SERVICE_ACCOUNT, email_verified: true, ...claims },
          fakes.installRtdnAuthFakes().privateKey,
          { algorithm: 'RS256', keyid: 'rtdn-test-key' }
        )}`
        : fakes.rtdnAuthHeader(claims);
      const res = await request(app).post(RTDN_PATH).set('Authorization', header).send(body('m-claims'));
      expect(res.status).toBe(401);
      await expectNothingStored();
    });

    test('server without audience/service-account configuration refuses every push (fails closed)', async () => {
      const header = fakes.rtdnAuthHeader();
      process.env.GOOGLE_PLAY_RTDN_AUDIENCE = '';
      const res = await request(app).post(RTDN_PATH).set('Authorization', header).send(body('m-unconfigured'));
      expect(res.status).toBe(401);
      await expectNothingStored();
    });

    test('the push token never appears in the 401 response', async () => {
      const header = fakes.rtdnAuthHeader({ aud: 'https://someone-else.test/push' });
      const res = await request(app).post(RTDN_PATH).set('Authorization', header).send(body('m-leak'));
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain(header.slice('Bearer '.length));
    });
  });

  describe('Apple App Store Server Notifications (JWS)', () => {
    test('a signedPayload whose payload was changed → 400, nothing stored', async () => {
      const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const tampered = [seg({ alg: 'ES256', x5c: ['AAAA', 'BBBB', 'CCCC'] }), seg({ notificationType: 'SUBSCRIBED', notificationUUID: 'u-tamper' }), 'c2ln'].join('.');
      const res = await request(app).post('/api/v1/billing/webhooks/apple').send({ signedPayload: tampered });
      expect(res.status).toBe(400);
      await expectNothingStored();
    });
  });

  describe('Stripe (real constructEvent on the raw body)', () => {
    const secret = 'whsec_sec03_test_only';
    const event = { id: 'evt_sec03', object: 'event', type: 'customer.subscription.updated', data: { object: { id: 'sub_x' } } };

    beforeEach(() => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_sec03_offline_only';
      process.env.STRIPE_WEBHOOK_SECRET = secret;
    });
    afterEach(() => {
      process.env.STRIPE_SECRET_KEY = '';
      process.env.STRIPE_WEBHOOK_SECRET = '';
    });

    const signed = (payload, key = secret) => Stripe.webhooks.generateTestHeaderString({ payload, secret: key });

    test('a correctly signed event is accepted', async () => {
      const payload = JSON.stringify(event);
      const res = await request(app).post('/api/v1/billing/webhooks/stripe')
        .set('Content-Type', 'application/json').set('Stripe-Signature', signed(payload)).send(payload);
      expect(res.status).toBe(200);
      expect(await BillingEvent.count({ where: { provider: 'STRIPE', providerEventId: 'evt_sec03' } })).toBe(1);
    });

    test('a body changed after signing → 400, nothing stored', async () => {
      const payload = JSON.stringify(event);
      const tampered = JSON.stringify({ ...event, type: 'checkout.session.completed' });
      const res = await request(app).post('/api/v1/billing/webhooks/stripe')
        .set('Content-Type', 'application/json').set('Stripe-Signature', signed(payload)).send(tampered);
      expect(res.status).toBe(400);
      await expectNothingStored();
    });

    test('an event signed with another secret → 400, nothing stored', async () => {
      const payload = JSON.stringify(event);
      const res = await request(app).post('/api/v1/billing/webhooks/stripe')
        .set('Content-Type', 'application/json').set('Stripe-Signature', signed(payload, 'whsec_attacker')).send(payload);
      expect(res.status).toBe(400);
      await expectNothingStored();
    });
  });
});
