'use strict';

/**
 * Regression test for AUTH-01:
 * Refresh token rotation, opaque tokens, hashed storage, and session family reuse detection.
 *
 * Spec §12 / Prompt 1D Issue 2:
 * 1. Refresh tokens must be opaque strings, not JWTs.
 * 2. Refresh tokens must be stored hashed (SHA-256) at rest, never plaintext.
 * 3. Every refresh rotates the token — old token is revoked, new token issued in the same family.
 * 4. Reusing an already-rotated refresh token revokes the ENTIRE session family.
 * 5. After reuse detection, the legitimate rotated token is also rejected with 401.
 * 6. Other independent session families for the same user remain unaffected.
 */

const crypto = require('crypto');
const request = require('supertest');
const { startTestServer } = require('../harness/test-server');
const { setupTestDatabases, teardownTestDatabases } = require('../harness/test-db');
const { User, RefreshToken } = require('../../src/models/platform');

describe('AUTH-01: Refresh Token Rotation & Family Reuse Detection', () => {
  let appServer;
  let testUser;

  beforeAll(async () => {
    await setupTestDatabases();
    appServer = await startTestServer();

    // Create a verified active user for auth tests
    const email = `auth01_${Date.now()}@example.test`;
    const bcrypt = require('bcrypt');
    const passwordHash = await bcrypt.hash('Secret123!', 10);

    testUser = await User.create({
      fullName: 'Auth01 Test User',
      email,
      passwordHash,
      role: 'MEMBER',
      status: 'ACTIVE',
      isVerified: true,
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('Login issues an opaque refresh token that is stored hashed at rest in DB', async () => {
    const res = await request(appServer)
      .post('/api/v1/auth/login')
      .send({ email: testUser.email, password: 'Secret123!' });

    expect(res.status).toBe(200);
    const { accessToken, refreshToken } = res.body.data;

    // 1. Refresh token must be opaque: NOT a JWT (which has 2 dots: header.payload.signature)
    expect(typeof refreshToken).toBe('string');
    const dotCount = (refreshToken.match(/\./g) || []).length;
    expect(dotCount).not.toBe(2);

    // 2. Token in DB must NOT match raw plaintext refreshToken (must be stored hashed)
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const stored = await RefreshToken.findOne({
      where: { userId: testUser.id, token: tokenHash },
    });

    expect(stored).not.toBeNull();
    expect(stored.token).toBe(tokenHash);
    expect(stored.token).not.toBe(refreshToken);
    expect(stored.isRevoked).toBe(false);
    expect(stored.familyId).toBeDefined();
    expect(typeof stored.familyId).toBe('string');
  });

  test('Refreshing a token rotates it, and reusing the old token revokes the entire session family', async () => {
    // Step 1: Login to establish Session Family A
    const loginRes = await request(appServer)
      .post('/api/v1/auth/login')
      .send({ email: testUser.email, password: 'Secret123!' });

    expect(loginRes.status).toBe(200);
    const rt1 = loginRes.body.data.refreshToken;

    // Also establish an independent Session Family B (e.g. another device)
    const loginRes2 = await request(appServer)
      .post('/api/v1/auth/login')
      .send({ email: testUser.email, password: 'Secret123!' });

    expect(loginRes2.status).toBe(200);
    const rt_device2 = loginRes2.body.data.refreshToken;

    // Step 2: Legitimate rotation of rt1 -> rt2
    const refreshRes1 = await request(appServer)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rt1 });

    expect(refreshRes1.status).toBe(200);
    const rt2 = refreshRes1.body.data.refreshToken;
    expect(rt2).not.toBe(rt1);

    // Verify rt1 is now marked revoked in DB
    const rt1Hash = crypto.createHash('sha256').update(rt1).digest('hex');
    const storedRt1 = await RefreshToken.findOne({ where: { token: rt1Hash } });
    expect(storedRt1.isRevoked).toBe(true);

    // Verify rt2 is in the same family and is active
    const rt2Hash = crypto.createHash('sha256').update(rt2).digest('hex');
    const storedRt2 = await RefreshToken.findOne({ where: { token: rt2Hash } });
    expect(storedRt2.isRevoked).toBe(false);
    expect(storedRt2.familyId).toBe(storedRt1.familyId);

    // Step 3: Attacker tries to REUSE already-rotated token rt1
    const reuseRes = await request(appServer)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rt1 });

    // Must be rejected with 401
    expect(reuseRes.status).toBe(401);

    // Step 4: REUSE DETECTION CHECK:
    // The entire session family (storedRt1.familyId) must now be revoked!
    await storedRt2.reload();
    expect(storedRt2.isRevoked).toBe(true);

    // Step 5: Legitimate client tries to use rt2 (which was valid before the reuse attack)
    const legRes = await request(appServer)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rt2 });

    // The legitimate rotated session must ALSO be rejected, proving session family revocation!
    expect(legRes.status).toBe(401);

    // Step 6: Verify Device 2 session family is STILL ALIVE (unaffected by Device 1's compromise)
    const device2Res = await request(appServer)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rt_device2 });

    expect(device2Res.status).toBe(200);
    expect(device2Res.body.data.refreshToken).toBeDefined();
  });

  test('Backward-compatibility: pre-deploy session with old-format unhashed token refreshes cleanly, upgrades to family, and is protected against reuse', async () => {
    // 1. Simulate a session that existed BEFORE AUTH-01 was deployed:
    // Raw plaintext token string, familyId is null
    const legacyRawToken = 'legacy_pre_deploy_refresh_token_' + Date.now();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const legacyRow = await RefreshToken.create({
      userId: testUser.id,
      familyId: null,
      token: legacyRawToken,
      expiresAt,
      isRevoked: false,
    });

    // 2. User calls /auth/refresh with the old token after deploy
    const refreshRes = await request(appServer)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: legacyRawToken });

    expect(refreshRes.status).toBe(200);
    const { accessToken, refreshToken: upgradedToken } = refreshRes.body.data;
    expect(accessToken).toBeDefined();
    expect(upgradedToken).toBeDefined();
    expect(upgradedToken).not.toBe(legacyRawToken);

    // 3. Confirm old token in DB is now REVOKED
    await legacyRow.reload();
    expect(legacyRow.isRevoked).toBe(true);

    // 4. Confirm new upgraded token is stored hashed and has a newly assigned familyId
    const upgradedHash = crypto.createHash('sha256').update(upgradedToken).digest('hex');
    const storedUpgraded = await RefreshToken.findOne({ where: { token: upgradedHash } });
    expect(storedUpgraded).not.toBeNull();
    expect(storedUpgraded.isRevoked).toBe(false);
    expect(storedUpgraded.familyId).toBeDefined();
    expect(typeof storedUpgraded.familyId).toBe('string');
    expect(storedUpgraded.familyId.length).toBeGreaterThan(10);

    // 5. Attacker attempts to reuse the old legacy token
    const reuseRes = await request(appServer)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: legacyRawToken });

    expect(reuseRes.status).toBe(401);

    // 6. Reuse detection revoked all tokens for this user because familyId was null on the legacy row
    await storedUpgraded.reload();
    expect(storedUpgraded.isRevoked).toBe(true);

    // 7. Legitimate client trying to use the upgraded token is now also rejected (session killed)
    const afterReuseRes = await request(appServer)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: upgradedToken });
    expect(afterReuseRes.status).toBe(401);
  });
});
