/**
 * NEW-03 — Google sign-in never accepts an unverified ID token (spec §12.13.11).
 *
 * It used to fall back to `jwt.decode` (no signature check) whenever the
 * verifier's error text contained "network" / "certificates" / "timed out" /
 * …. That text is partly attacker-controlled (the library echoes the token
 * header in "No pem found for envelope …"), and a failed certificate fetch
 * also triggered it, so a hand-made token with the right claims logged in as
 * any Google user.
 *
 * Google's signing certificates are replaced by a local test key pair through
 * the library's own cert lookup (OAuth2Client#getFederatedSignonCertsAsync);
 * nothing reaches Google (network jail).
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { OAuth2Client } = require('google-auth-library');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { User } = require('../../src/models/platform');

const CLIENT_ID = 'new03-test-client.apps.googleusercontent.com';
const KID = 'google-test-kid';

const keyPair = () => crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const googleKeys = keyPair();
const attackerKeys = keyPair();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

const claims = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  azp: CLIENT_ID,
  sub: '109876543210987654321',
  email: 'real.user@gmail.test',
  email_verified: true,
  name: 'Real User',
  iat: now(),
  exp: now() + 3600,
  ...over,
});

/** A token Google itself would issue (signed with the key the stubbed cert lookup returns). */
const googleSigned = (over = {}, { kid = KID, key = googleKeys.privateKey } = {}) =>
  jwt.sign(claims(over), key, { algorithm: 'RS256', keyid: kid });

/** Correct shape and claims, but no valid signature. */
const forgedUnsigned = (over = {}, header = { alg: 'RS256', kid: KID, typ: 'JWT' }) =>
  `${b64(header)}.${b64(claims(over))}.${Buffer.from('not-a-signature').toString('base64url')}`;

let app;
let certsSpy;

const certsAvailable = () => {
  certsSpy = jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync')
    .mockResolvedValue({ certs: { [KID]: googleKeys.publicKey }, format: 'PEM' });
};
const certsUnavailable = (message = 'request to https://www.googleapis.com/oauth2/v1/certs failed, reason: network error ETIMEDOUT') => {
  certsSpy = jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockRejectedValue(new Error(message));
};

const signIn = (idToken, path = '/api/v1/auth/social/google') => request(app).post(path).send({ idToken });

beforeAll(async () => {
  await setupTestDatabases();
  app = await startTestServer();
});

afterAll(async () => {
  await teardownTestDatabases();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  await resetTestDatabases();
});

describe('NEW-03: forged Google tokens are rejected', () => {
  let victim;
  beforeEach(async () => {
    victim = await factories.createUser({ email: 'victim@gmail.test', googleId: '100000000000000000001' });
  });

  const expectRejected = async (res) => {
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.data?.accessToken).toBeUndefined();
    // No account was created or linked by the forged attempt.
    expect(await User.count()).toBe(1);
    await victim.reload();
    expect(victim.googleId).toBe('100000000000000000001');
  };

  test('unsigned token while Google certs cannot be fetched (the old fallback path) → 401', async () => {
    certsUnavailable();
    await expectRejected(await signIn(forgedUnsigned({ sub: '100000000000000000001', email: 'victim@gmail.test' })));
  });

  test('unsigned token whose header puts "network" in the error text, certs available → 401', async () => {
    certsAvailable();
    const token = forgedUnsigned({ sub: '100000000000000000001', email: 'victim@gmail.test' }, { alg: 'RS256', kid: 'network certificates timed out', typ: 'JWT' });
    await expectRejected(await signIn(token));
  });

  test('token signed with an attacker key (correct kid) → 401', async () => {
    certsAvailable();
    await expectRejected(await signIn(googleSigned({ email: 'victim@gmail.test' }, { key: attackerKeys.privateKey })));
  });

  test('alg "none" token → 401', async () => {
    certsAvailable();
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims({ email: 'victim@gmail.test' }))}.`;
    await expectRejected(await signIn(token));
  });

  test('genuine token with its payload swapped after signing → 401', async () => {
    certsAvailable();
    const [h, , s] = googleSigned().split('.');
    await expectRejected(await signIn(`${h}.${b64(claims({ sub: '100000000000000000001', email: 'victim@gmail.test' }))}.${s}`));
  });

  test('Google cert fetch hangs → 401 (not a hang, not a fallback)', async () => {
    certsSpy = jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockImplementation(() => new Promise(() => {}));
    await expectRejected(await signIn(forgedUnsigned({ email: 'victim@gmail.test' })));
  }, 15000);

  test.each([
    ['another app\'s audience', { aud: 'someone-else.apps.googleusercontent.com', azp: 'someone-else.apps.googleusercontent.com' }],
    ['an expired token', { iat: now() - 7200, exp: now() - 3600 }],
    ['a non-Google issuer', { iss: 'https://evil.test' }],
    ['an unverified e-mail', { email_verified: false }],
    ['an unverified e-mail sent as the string "false"', { email_verified: 'false' }],
  ])('correctly signed token with %s → 401', async (_label, over) => {
    certsAvailable();
    await expectRejected(await signIn(googleSigned({ email: 'victim@gmail.test', ...over })));
  });

  test('the staff (CMS) Google sign-in rejects forged tokens the same way', async () => {
    certsUnavailable();
    await expectRejected(await signIn(forgedUnsigned({ sub: '100000000000000000001', email: 'victim@gmail.test' }), '/api/v1/auth/social/google/staff'));
  });

  test('re-authentication (e.g. confirming a branch delete) rejects a forged Google token', async () => {
    certsUnavailable();
    const authService = require('../../src/services/auth.service');
    await expect(authService.verifyReauthCredential(victim.id, {
      provider: 'GOOGLE',
      idToken: forgedUnsigned({ sub: '100000000000000000001', email: 'victim@gmail.test' }),
    })).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('NEW-03: genuine Google sign-in still works', () => {
  beforeEach(certsAvailable);

  test('a new Google user signs in and gets a session', async () => {
    const res = await signIn(googleSigned());
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    const user = await User.findOne({ where: { email: 'real.user@gmail.test' } });
    expect(user.googleId).toBe('109876543210987654321');
  });

  test('a returning Google user signs in to the same account', async () => {
    const existing = await factories.createUser({ email: 'real.user@gmail.test', googleId: '109876543210987654321' });
    const res = await signIn(googleSigned());
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(existing.id);
    expect(await User.count()).toBe(1);
  });

  test('an existing e-mail account is linked on first Google sign-in (unchanged behaviour)', async () => {
    const existing = await factories.createUser({ email: 'real.user@gmail.test' });
    const res = await signIn(googleSigned());
    expect(res.status).toBe(200);
    await existing.reload();
    expect(existing.googleId).toBe('109876543210987654321');
  });

  test('email_verified sent as the string "true" is accepted', async () => {
    const res = await signIn(googleSigned({ email_verified: 'true' }));
    expect(res.status).toBe(200);
  });

  test('the iOS client ID audience is accepted too', async () => {
    process.env.GOOGLE_IOS_CLIENT_ID = 'new03-ios-client.apps.googleusercontent.com';
    try {
      const res = await signIn(googleSigned({ aud: 'new03-ios-client.apps.googleusercontent.com', azp: 'new03-ios-client.apps.googleusercontent.com' }));
      expect(res.status).toBe(200);
    } finally {
      delete process.env.GOOGLE_IOS_CLIENT_ID;
    }
  });

  test('re-authentication with a genuine token for the same Google account succeeds; another account is refused', async () => {
    const user = await factories.createUser({ email: 'real.user@gmail.test', googleId: '109876543210987654321' });
    const authService = require('../../src/services/auth.service');
    await expect(authService.verifyReauthCredential(user.id, { provider: 'GOOGLE', idToken: googleSigned() })).resolves.toBe(true);
    await expect(authService.verifyReauthCredential(user.id, { provider: 'GOOGLE', idToken: googleSigned({ sub: '555' }) }))
      .rejects.toMatchObject({ statusCode: 401 });
  });
});
