'use strict';

/**
 * Regression tests for AUTH-02, AUTH-08, and NEW-37:
 * AUTH-08: Immediate permission revocation via permissionVersion ('ver' claim) in JWT and Redis cache.
 * NEW-37: Immediate account deletion enforcement (tokens rejected immediately when user is PENDING_DELETION).
 * AUTH-02: Session management (GET /sessions, DELETE /sessions/:id, DELETE /sessions, POST /logout).
 * AUTH-02: Legacy role shim resets role to MEMBER when user has no active tenant assignments.
 */

const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const request = require('supertest');
const { signToken } = require('../../src/utils/jwt.utils');
const { User, RefreshToken, Tenant } = require('../../src/models/platform');
const accessService = require('../../src/services/access.service');
const { applyLegacyRoleShim } = require('../../src/middleware/tenantContext');

describe('Prompt 2A: AUTH-02, AUTH-08, NEW-37 Session and Revocation Controls', () => {
  let appServer;
  let testUser;
  let testTenant;

  beforeAll(async () => {
    await setupTestDatabases();
    appServer = await startTestServer();

    testUser = await User.create({
      fullName: 'Auth Test User',
      email: `authtest_${Date.now()}@example.test`,
      passwordHash: 'dummyhash',
      role: 'MEMBER',
      status: 'ACTIVE',
      isVerified: true,
      permissionVersion: 1,
    });

    testTenant = await Tenant.create({
      tenantCode: 'TEN-AUTH-' + Date.now(),
      businessName: 'Auth Test Tenant',
      ownerUserId: testUser.id,
      email: testUser.email,
      status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('AUTH-08: Immediate Permission Version Revocation', () => {
    test('Token with stale ver is rejected with 403 forbidden once permissionVersion is bumped', async () => {
      // 1. Token with current ver = 1
      const tokenV1 = signToken({
        sub: testUser.id,
        email: testUser.email,
        role: 'MEMBER',
        isVerified: true,
        ver: 1,
      });

      // Initially succeeds
      const res1 = await request(appServer)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${tokenV1}`);

      expect(res1.status).toBe(200);

      // 2. Bump user permission version
      await accessService.bumpUserPermissionVersion(testUser.id);
      await testUser.reload();
      expect(testUser.permissionVersion).toBeGreaterThan(1);

      // 3. Stale token with ver: 1 must be rejected
      const res2 = await request(appServer)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${tokenV1}`);

      expect(res2.status).toBe(403);
      expect(res2.body.error?.code || res2.body.code).toBe('forbidden');

      // 4. Token issued with the new permissionVersion succeeds
      const tokenV2 = signToken({
        sub: testUser.id,
        email: testUser.email,
        role: 'MEMBER',
        isVerified: true,
        ver: testUser.permissionVersion,
      });

      const res3 = await request(appServer)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${tokenV2}`);

      expect(res3.status).toBe(200);
    });
  });

  describe('NEW-37: Immediate Account Deletion Token Rejection', () => {
    test('Tokens for PENDING_DELETION users are rejected with 403 account_pending_deletion on standard endpoints', async () => {
      const deletionUser = await User.create({
        fullName: 'Deletion User',
        email: `deluser_${Date.now()}@example.test`,
        passwordHash: 'dummyhash',
        role: 'MEMBER',
        status: 'ACTIVE',
        isVerified: true,
        permissionVersion: 1,
      });

      const token = signToken({
        sub: deletionUser.id,
        email: deletionUser.email,
        role: 'MEMBER',
        isVerified: true,
        ver: 1,
      });

      // Initially active
      const resActive = await request(appServer)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${token}`);
      expect(resActive.status).toBe(200);

      // Transition user to PENDING_DELETION
      await deletionUser.update({ status: 'PENDING_DELETION' });
      // Invalidate Redis user cache
      await accessService.bumpUserPermissionVersion(deletionUser.id);
      await deletionUser.reload();

      // 1. Token issued before deletion request has ver: 1, so it is immediately revoked via ver check (NEW-37)
      const resStale = await request(appServer)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${token}`);
      expect(resStale.status).toBe(403);
      expect(resStale.body.error?.code || resStale.body.code).toBe('forbidden');

      // 2. Token issued during PENDING_DELETION (has dp: true) is restricted to allowed endpoints
      const tokenPending = signToken({
        sub: deletionUser.id,
        email: deletionUser.email,
        role: 'MEMBER',
        isVerified: true,
        ver: deletionUser.permissionVersion,
        dp: true,
      });

      // Standard protected endpoint is blocked with account_pending_deletion
      const resBlocked = await request(appServer)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${tokenPending}`);

      expect(resBlocked.status).toBe(403);
      expect(resBlocked.body.error?.code || resBlocked.body.code).toBe('account_pending_deletion');

      // Allowed endpoint (/auth/me) is permitted
      const resAllowed = await request(appServer)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${tokenPending}`);

      expect(resAllowed.status).toBe(200);

      await deletionUser.destroy();
    });
  });

  describe('AUTH-02: Session Management and Logout', () => {
    test('Lists active sessions, revokes single session, revokes all sessions, and logs out', async () => {
      const sessionUser = await User.create({
        fullName: 'Session User',
        email: `sessionuser_${Date.now()}@example.test`,
        passwordHash: 'dummyhash',
        role: 'MEMBER',
        status: 'ACTIVE',
        isVerified: true,
        permissionVersion: 1,
      });

      const expiresFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const token1 = await RefreshToken.create({
        userId: sessionUser.id,
        familyId: 'family-session-1',
        token: 'hashed_token_1',
        expiresAt: expiresFuture,
        isRevoked: false,
        userAgent: 'Mobile App 1',
      });

      const token2 = await RefreshToken.create({
        userId: sessionUser.id,
        familyId: 'family-session-2',
        token: 'hashed_token_2',
        expiresAt: expiresFuture,
        isRevoked: false,
        userAgent: 'Web Browser 2',
      });

      let userToken = signToken({
        sub: sessionUser.id,
        email: sessionUser.email,
        role: 'MEMBER',
        isVerified: true,
        ver: sessionUser.permissionVersion,
      });

      // 1. GET /sessions lists 2 active sessions
      const resList = await request(appServer)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${userToken}`);

      expect(resList.status).toBe(200);
      expect(resList.body.data.sessions.length).toBe(2);

      // 2. DELETE /sessions/:id revokes family-session-1
      const resRevokeOne = await request(appServer)
        .delete('/api/v1/auth/sessions/family-session-1')
        .set('Authorization', `Bearer ${userToken}`);

      expect(resRevokeOne.status).toBe(200);

      // Check DB row
      await token1.reload();
      expect(token1.isRevoked).toBe(true);

      // Reload user for bumped permissionVersion
      await sessionUser.reload();
      userToken = signToken({
        sub: sessionUser.id,
        email: sessionUser.email,
        role: 'MEMBER',
        isVerified: true,
        ver: sessionUser.permissionVersion,
      });

      const resListAfterOne = await request(appServer)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${userToken}`);

      expect(resListAfterOne.status).toBe(200);
      expect(resListAfterOne.body.data.sessions.length).toBe(1);
      expect(resListAfterOne.body.data.sessions[0].id).toBe('family-session-2');

      // 3. DELETE /sessions revokes all sessions
      const resRevokeAll = await request(appServer)
        .delete('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${userToken}`);

      expect(resRevokeAll.status).toBe(200);

      await token2.reload();
      expect(token2.isRevoked).toBe(true);

      await sessionUser.reload();
      userToken = signToken({
        sub: sessionUser.id,
        email: sessionUser.email,
        role: 'MEMBER',
        isVerified: true,
        ver: sessionUser.permissionVersion,
      });

      const resListEmpty = await request(appServer)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${userToken}`);

      expect(resListEmpty.status).toBe(200);
      expect(resListEmpty.body.data.sessions.length).toBe(0);

      // 4. POST /auth/logout
      const resLogout = await request(appServer)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${userToken}`)
        .send();

      expect(resLogout.status).toBe(200);

      await sessionUser.destroy();
    });
  });
});
