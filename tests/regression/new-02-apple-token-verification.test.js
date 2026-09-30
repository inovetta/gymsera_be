/**
 * NEW-02 — Apple sign-in and Apple re-authentication verify the identity
 * token (spec §12.13.11).
 *
 * The token used to be `jwt.decode`d with no signature check (sign-in and
 * re-auth), the audience was computed but never enforced, the Apple user id
 * could come from the request body (`userIdentifier`), and the e-mail used to
 * link an existing account could come from the body too. Any of these let a
 * caller sign in as someone else.
 *
 * Apple's public keys (JWKS, https://appleid.apple.com/auth/keys) are replaced
 * by a local test key pair by stubbing `fetch`; nothing reaches Apple.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { User } = require('../../src/models/platform');

const BUNDLE_ID = 'com.inovettatech.gymsera';
const KID = 'apple-test-kid';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

const keyPair = () => crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const appleKeys = keyPair();
const rotatedKeys = keyPair();
const attackerKeys = keyPair();

const jwk = (pem, kid) => ({ ...crypto.createPublicKey(pem).export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

const claims = (over = {}) => ({
  iss: 'https://appleid.apple.com',
  aud: BUNDLE_ID,
  sub: '001234.aaaabbbbccccdddd.0101',
  email: 'real.user@privaterelay.appleid.com',
  email_verified: 'true',
  is_private_email: 'true',
  auth_time: now(),
  iat: now(),
  exp: now() + 600,
  ...over,
});

const appleSigned = (over = {}, { kid = KID, key = appleKeys.privateKey } = {}) => {
  const payload = claims(over);
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return jwt.sign(payload, key, { algorithm: 'RS256', keyid: kid });
};

const forgedUnsigned = (over = {}) =>
  `${b64({ alg: 'RS256', kid: KID })}.${b64(claims(over))}.${Buffer.from('not-a-signature').toString('base64url')}`;

let app;
let fetchSpy;
let jwksKeys;

/** Stubs fetch: Apple's JWKS endpoint returns `jwksKeys`; anything else is refused. */
const stubAppleJwks = (keys = [jwk(appleKeys.publicKey, KID)]) => {
  jwksKeys = keys;
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (String(url) !== APPLE_JWKS_URL) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify({ keys: jwksKeys }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
};

const signIn = (body) => request(app).post('/api/v1/auth/social/apple').send(body);

beforeAll(async () => {
  await setupTestDatabases();
  app = await startTestServer();
});

afterAll(async () => {
  await teardownTestDatabases();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  const authService = require('../../src/services/auth.service');
  if (typeof authService._resetAppleKeyCacheForTests === 'function') authService._resetAppleKeyCacheForTests();
  await resetTestDatabases();
});

describe('NEW-02: forged or misused Apple tokens are rejected', () => {
  const VICTIM_APPLE_ID = '000999.victimvictimvict.0999';
  let victim;
  beforeEach(async () => {
    stubAppleJwks();
    victim = await factories.createUser({ email: 'victim@icloud.test', appleId: VICTIM_APPLE_ID });
  });

  const expectRejected = async (res) => {
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.data?.accessToken).toBeUndefined();
    expect(await User.count()).toBe(1);
  };

  test('unsigned token claiming the victim\'s Apple id → 401', async () => {
    await expectRejected(await signIn({ identityToken: forgedUnsigned({ sub: VICTIM_APPLE_ID, email: 'victim@icloud.test' }) }));
  });

  test('token signed with an attacker key (Apple\'s kid) → 401', async () => {
    await expectRejected(await signIn({ identityToken: appleSigned({ sub: VICTIM_APPLE_ID }, { key: attackerKeys.privateKey }) }));
  });

  test('alg "none" token → 401', async () => {
    await expectRejected(await signIn({ identityToken: `${b64({ alg: 'none' })}.${b64(claims({ sub: VICTIM_APPLE_ID }))}.` }));
  });

  test('genuine token with its payload swapped after signing → 401', async () => {
    const [h, , s] = appleSigned().split('.');
    await expectRejected(await signIn({ identityToken: `${h}.${b64(claims({ sub: VICTIM_APPLE_ID }))}.${s}` }));
  });

  test('token signed by a key Apple does not publish (unknown kid) → 401', async () => {
    await expectRejected(await signIn({ identityToken: appleSigned({ sub: VICTIM_APPLE_ID }, { kid: 'not-apples', key: attackerKeys.privateKey }) }));
  });

  test.each([
    ['another app\'s audience', { aud: 'com.someone.else' }],
    ['an expired token', { iat: now() - 7200, exp: now() - 3600 }],
    ['a non-Apple issuer', { iss: 'https://evil.test' }],
  ])('correctly signed token with %s → 401', async (_label, over) => {
    await expectRejected(await signIn({ identityToken: appleSigned({ sub: VICTIM_APPLE_ID, ...over }) }));
  });

  test('Apple\'s keys cannot be fetched → 401 (never decoded without verification)', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expectRejected(await signIn({ identityToken: forgedUnsigned({ sub: VICTIM_APPLE_ID }) }));
  });

  test('the body\'s userIdentifier never overrides the token: a genuine token for A cannot sign in as B', async () => {
    const res = await signIn({ identityToken: appleSigned({ sub: '000111.attackerattacker.0111', email: 'attacker@icloud.test' }), userIdentifier: VICTIM_APPLE_ID });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).not.toBe(victim.id);
    const attacker = await User.findOne({ where: { appleId: '000111.attackerattacker.0111' } });
    expect(attacker).not.toBeNull();
    await victim.reload();
    expect(victim.appleId).toBe(VICTIM_APPLE_ID);
  });

  test('the body\'s email never links an account: a genuine token without an e-mail cannot take over the victim\'s e-mail account', async () => {
    const emailOnly = await factories.createUser({ email: 'emailonly@icloud.test' });
    const res = await signIn({ identityToken: appleSigned({ sub: '000222.attackerattacker.0222', email: undefined, email_verified: undefined }), email: 'emailonly@icloud.test' });
    expect(res.status).not.toBe(200);
    await emailOnly.reload();
    expect(emailOnly.appleId).toBeFalsy();
  });

  test('an e-mail Apple marks as unverified is not used to link an existing account', async () => {
    const emailOnly = await factories.createUser({ email: 'emailonly@icloud.test' });
    const res = await signIn({ identityToken: appleSigned({ sub: '000333.attackerattacker.0333', email: 'emailonly@icloud.test', email_verified: 'false' }) });
    expect(res.status).toBe(401);
    await emailOnly.reload();
    expect(emailOnly.appleId).toBeFalsy();
  });

  test('re-authentication rejects a forged Apple token for the victim', async () => {
    const authService = require('../../src/services/auth.service');
    await expect(authService.verifyReauthCredential(victim.id, { provider: 'APPLE', idToken: forgedUnsigned({ sub: VICTIM_APPLE_ID }) }))
      .rejects.toMatchObject({ statusCode: 401 });
    await expect(authService.verifyReauthCredential(victim.id, { provider: 'APPLE', idToken: appleSigned({ sub: VICTIM_APPLE_ID, aud: 'com.someone.else' }) }))
      .rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('NEW-02: genuine Apple sign-in still works', () => {
  beforeEach(() => stubAppleJwks());

  test('first sign-in (the app sends identityToken, userIdentifier = sub, email, fullName) creates the account', async () => {
    const res = await signIn({ identityToken: appleSigned(), userIdentifier: '001234.aaaabbbbccccdddd.0101', email: 'real.user@privaterelay.appleid.com', fullName: 'Real User' });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    const user = await User.findOne({ where: { appleId: '001234.aaaabbbbccccdddd.0101' } });
    expect(user.email).toBe('real.user@privaterelay.appleid.com');
    expect(user.fullName).toBe('Real User');
  });

  test('a returning user signs in even when Apple omits the e-mail and the app sends no email/name', async () => {
    const existing = await factories.createUser({ email: 'real.user@privaterelay.appleid.com', appleId: '001234.aaaabbbbccccdddd.0101' });
    const res = await signIn({ identityToken: appleSigned({ email: undefined, email_verified: undefined, is_private_email: undefined }), userIdentifier: '001234.aaaabbbbccccdddd.0101' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(existing.id);
  });

  test('an existing e-mail account is linked when Apple vouches for the e-mail (boolean or "true")', async () => {
    const a = await factories.createUser({ email: 'linkme@icloud.test' });
    expect((await signIn({ identityToken: appleSigned({ sub: '000444.linklinklinklink.0444', email: 'linkme@icloud.test', email_verified: true }) })).status).toBe(200);
    await a.reload();
    expect(a.appleId).toBe('000444.linklinklinklink.0444');
  });

  test('Apple\'s keys are cached: two sign-ins fetch the JWKS once', async () => {
    await signIn({ identityToken: appleSigned() });
    await signIn({ identityToken: appleSigned() });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('Apple rotates its key: a token with a new kid triggers one refetch and is accepted', async () => {
    await signIn({ identityToken: appleSigned() });
    jwksKeys = [jwk(appleKeys.publicKey, KID), jwk(rotatedKeys.publicKey, 'apple-rotated-kid')];
    const res = await signIn({ identityToken: appleSigned({}, { kid: 'apple-rotated-kid', key: rotatedKeys.privateKey }) });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('re-authentication with a genuine token for the same Apple account succeeds; another account is refused', async () => {
    const user = await factories.createUser({ email: 'real.user@privaterelay.appleid.com', appleId: '001234.aaaabbbbccccdddd.0101' });
    const authService = require('../../src/services/auth.service');
    await expect(authService.verifyReauthCredential(user.id, { provider: 'APPLE', idToken: appleSigned() })).resolves.toBe(true);
    await expect(authService.verifyReauthCredential(user.id, { provider: 'APPLE', idToken: appleSigned({ sub: '000555.someoneelse.0555' }) }))
      .rejects.toMatchObject({ statusCode: 401 });
  });
});
