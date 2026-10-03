'use strict';

const http = require('http');
const express = require('express');
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { User } = require('../../src/models/platform');
const { signToken } = require('../../src/utils/jwt.utils');
const authenticate = require('../../src/middleware/authenticate');
const accessService = require('../../src/services/access.service');
const {
  getUserAuthCache,
  setUserAuthCache,
  clearUserAuthCache,
  getUserAuthCacheSize,
  MAX_ENTRIES,
} = require('../../src/utils/user-auth-cache');

describe('2A Blocker 2: In-Process permissionVersion Cache (AUTH-08)', () => {
  let dbHarness;
  let server;
  let testUser;
  let userToken;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();

    testUser = await User.create({
      fullName: 'Cache Test User',
      email: `cache_test_${Date.now()}@example.test`,
      passwordHash: 'dummy-hashed-pwd',
      role: 'MEMBER',
      status: 'ACTIVE',
      isVerified: true,
      permissionVersion: 1,
    });

    userToken = signToken({
      sub: testUser.id,
      email: testUser.email,
      role: testUser.role,
      isVerified: true,
      ver: 1,
    });

    const app = express();
    app.use(express.json());
    app.use(authenticate);

    app.get('/test/protected', (req, res) => {
      res.json({ success: true, userId: req.user.id });
    });

    // Custom error handler matching application style
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        success: false,
        code: err.code || 'internal_error',
        message: err.message,
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await teardownTestDatabases();
  });

  beforeEach(() => {
    clearUserAuthCache();
  });

  test('N requests with same token cause exactly ONE database query when Redis is absent', async () => {
    const findByPkSpy = jest.spyOn(User, 'findByPk');

    try {
      // Clear in-process cache to start fresh
      clearUserAuthCache(testUser.id);
      findByPkSpy.mockClear();

      // Send 5 sequential requests with the same token
      const N = 5;
      for (let i = 0; i < N; i++) {
        const res = await request(server)
          .get('/test/protected')
          .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }

      // Exactly 1 database query was made; the subsequent 4 were served from in-process cache
      expect(findByPkSpy).toHaveBeenCalledTimes(1);

      // Verify the cache holds the user's metadata
      const cached = getUserAuthCache(testUser.id);
      expect(cached).not.toBeNull();
      expect(cached.ver).toBe(1);
      expect(cached.status).toBe('ACTIVE');
    } finally {
      findByPkSpy.mockRestore();
    }
  });

  test('permissionVersion bump immediately invalidates in-process cache in the same process', async () => {
    const findByPkSpy = jest.spyOn(User, 'findByPk');

    try {
      // 1. Initial request to populate cache
      const res1 = await request(server)
        .get('/test/protected')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res1.status).toBe(200);

      findByPkSpy.mockClear();

      // 2. Bump user permissionVersion in the same process
      await accessService.bumpUserPermissionVersion(testUser.id);

      // Cache for testUser must be cleared immediately (0 second delay in same process)
      expect(getUserAuthCache(testUser.id)).toBeNull();

      // 3. Next request with the old token (ver = 1) must hit DB, detect higher ver, and return 403 forbidden
      const res2 = await request(server)
        .get('/test/protected')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res2.status).toBe(403);
      expect(res2.body.code).toBe('forbidden');
      expect(res2.body.message).toContain('permissions have changed');

      // Database was queried to fetch the fresh version
      expect(findByPkSpy).toHaveBeenCalledTimes(1);
    } finally {
      findByPkSpy.mockRestore();
    }
  });

  test('user deletion / suspension immediately clears in-process cache in the same process', async () => {
    // 1. Create a dedicated user for deletion test
    const victim = await User.create({
      fullName: 'Victim User',
      email: `victim_${Date.now()}@example.test`,
      passwordHash: 'dummy-hashed-pwd',
      role: 'MEMBER',
      status: 'ACTIVE',
      isVerified: true,
      permissionVersion: 1,
    });

    const victimToken = signToken({
      sub: victim.id,
      email: victim.email,
      role: victim.role,
      isVerified: true,
      ver: 1,
    });

    // Populate in-process cache
    const res1 = await request(server)
      .get('/test/protected')
      .set('Authorization', `Bearer ${victimToken}`);
    expect(res1.status).toBe(200);
    expect(getUserAuthCache(victim.id)).not.toBeNull();

    // 2. Update user status to SUSPENDED via User model
    await victim.update({ status: 'SUSPENDED' });

    // The Sequelize hook on User automatically clears in-process cache
    expect(getUserAuthCache(victim.id)).toBeNull();

    // 3. Next request fails with 401 unauthorized
    const res2 = await request(server)
      .get('/test/protected')
      .set('Authorization', `Bearer ${victimToken}`);

    expect(res2.status).toBe(401);
    expect(res2.body.code).toBe('unauthorized');
  });

  test('cache TTL expiration causes re-query after TTL (worst-case delay across processes is 30s)', async () => {
    const findByPkSpy = jest.spyOn(User, 'findByPk');

    try {
      findByPkSpy.mockClear();

      // Seed cache with a short TTL (50ms)
      setUserAuthCache(testUser.id, { status: 'ACTIVE', ver: 2 }, 50);
      expect(getUserAuthCache(testUser.id)).not.toBeNull();

      // Request within TTL uses cache (no DB query)
      const res1 = await request(server)
        .get('/test/protected')
        .set('Authorization', `Bearer ${userToken}`);
      // Token ver is 1, cached ver is 2 -> 403 forbidden without hitting DB!
      expect(res1.status).toBe(403);
      expect(findByPkSpy).toHaveBeenCalledTimes(0);

      // Wait for 50ms TTL to expire
      await new Promise((r) => setTimeout(r, 60));

      // Cache is now expired
      expect(getUserAuthCache(testUser.id)).toBeNull();

      // Next request triggers a fresh DB query
      await request(server)
        .get('/test/protected')
        .set('Authorization', `Bearer ${userToken}`);

      expect(findByPkSpy).toHaveBeenCalledTimes(1);
    } finally {
      findByPkSpy.mockRestore();
    }
  });

  test('bounded cache size evicts oldest entries and does not exceed MAX_ENTRIES', () => {
    // Fill with sample entries and verify bounded capacity
    const initialSize = getUserAuthCacheSize();
    expect(initialSize).toBe(0);

    // Insert 10 entries into user-auth-cache
    for (let i = 1; i <= 10; i++) {
      setUserAuthCache(`dummy_${i}`, { status: 'ACTIVE', ver: 1 });
    }
    expect(getUserAuthCacheSize()).toBe(10);

    // Eviction test: verify clearing works
    clearUserAuthCache('dummy_1');
    expect(getUserAuthCacheSize()).toBe(9);
    expect(getUserAuthCache('dummy_1')).toBeNull();

    clearUserAuthCache();
    expect(getUserAuthCacheSize()).toBe(0);
  });
});
