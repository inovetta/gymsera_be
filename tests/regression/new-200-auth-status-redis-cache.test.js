/**
 * NEW-200: authenticate.js imported `safeRedisSet`, which redis.config.js never exported, so the
 * Redis write of a user's auth status threw inside a try/catch and nothing was ever cached.
 *
 * Fixing the write alone would open a hole: the User model hooks cleared only the in-process copy,
 * so after a suspension another process (or this one, once its 30 s copy expired) would read the
 * old ACTIVE status from Redis for up to 60 s. A change to a user now clears both copies.
 *
 * Redis is replaced by an in-memory store with the same helpers; the platform DB is real.
 */
const mockStore = new Map();
jest.mock('../../src/config/redis.config', () => {
  const actual = jest.requireActual('../../src/config/redis.config');
  return {
    ...actual,
    getRedisClient: () => null,
    ensureRedisReady: async () => null,
    safeRedisGet: jest.fn(async (key) => {
      const entry = mockStore.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() >= entry.expiresAt) {
        mockStore.delete(key);
        return null;
      }
      return entry.value;
    }),
    safeRedisSetex: jest.fn(async (key, ttl, value) => {
      mockStore.set(key, { ttl, value, expiresAt: Date.now() + ttl * 1000 });
    }),
    safeRedisDel: jest.fn(async (key) => {
      mockStore.delete(key);
    }),
  };
});

const { setupTestDatabases, teardownTestDatabases, factories } = require('../harness');
const authenticate = require('../../src/middleware/authenticate');
const { signToken } = require('../../src/utils/jwt.utils');
const { clearUserAuthCache } = require('../../src/utils/user-auth-cache');
const { User } = require('../../src/models/platform');

const run = async (token) => {
  const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: '/api/v1/me/profile' };
  let passed;
  await authenticate(req, {}, (err) => {
    passed = err || null;
  });
  return passed;
};

describe('NEW-200 auth status cache in Redis', () => {
  let user;
  let token;
  let key;

  beforeAll(async () => {
    await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    mockStore.clear();
    user = await factories.createUser();
    token = signToken({ sub: user.id, role: user.role, ver: user.permissionVersion || 1 });
    key = `user:${user.id}:auth`;
    clearUserAuthCache(user.id);
  });

  it('authenticate imports only helpers that redis.config exports', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../src/middleware/authenticate.js'), 'utf8');
    const imported = /const \{([^}]+)\} = require\('\.\.\/config\/redis\.config'\)/.exec(src)[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const exported = Object.keys(jest.requireActual('../../src/config/redis.config'));
    expect(imported.filter((name) => !exported.includes(name))).toEqual([]);
  });

  it('a database read is written to Redis for 60 seconds', async () => {
    expect(await run(token)).toBeNull();
    const stored = mockStore.get(key);
    expect(stored).toBeDefined();
    expect(stored.ttl).toBe(60);
    expect(stored.value).toBe(JSON.stringify({ status: 'ACTIVE', ver: user.permissionVersion || 1 }));
  });

  it('suspending a user clears the Redis copy, so a stale ACTIVE copy cannot let them in', async () => {
    // Another process cached the user as ACTIVE.
    mockStore.set(key, { ttl: 60, value: JSON.stringify({ status: 'ACTIVE', ver: user.permissionVersion || 1 }) });

    await user.update({ status: 'SUSPENDED' });

    expect(mockStore.has(key)).toBe(false);
    const err = await run(token);
    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(401);
  });

  it('deleting a user clears the Redis copy', async () => {
    mockStore.set(key, { ttl: 60, value: JSON.stringify({ status: 'ACTIVE', ver: 1 }) });
    await User.destroy({ where: { id: user.id }, individualHooks: true });
    expect(mockStore.has(key)).toBe(false);
  });

  it('a user change (permissionVersion bump or user update) clears the Redis copy', async () => {
    // 1. Populate Redis copy
    mockStore.set(key, { ttl: 60, value: JSON.stringify({ status: 'ACTIVE', ver: user.permissionVersion || 1 }) });
    expect(mockStore.has(key)).toBe(true);

    // 2. Bump user permission version (accessService.bumpUserPermissionVersion)
    const accessService = require('../../src/services/access.service');
    await accessService.bumpUserPermissionVersion(user.id);

    // Proves that permissionVersion bump clears the Redis copy
    expect(mockStore.has(key)).toBe(false);

    // 3. User model update (afterUpdate hook) also clears Redis copy
    mockStore.set(key, { ttl: 60, value: JSON.stringify({ status: 'ACTIVE', ver: user.permissionVersion || 1 }) });
    expect(mockStore.has(key)).toBe(true);
    await user.update({ fullName: 'Renamed User' });
    expect(mockStore.has(key)).toBe(false);
  });

  it('Redis TTL expiry causes authenticate to re-query the database', async () => {
    const findByPkSpy = jest.spyOn(User, 'findByPk');
    try {
      // 1. Initial request: misses cache, reads from DB, writes to Redis and in-process cache
      clearUserAuthCache(user.id);
      mockStore.clear();
      findByPkSpy.mockClear();

      const err1 = await run(token);
      expect(err1).toBeNull();
      expect(findByPkSpy).toHaveBeenCalledTimes(1);
      expect(mockStore.has(key)).toBe(true);

      // 2. Clear in-process cache to simulate another process or expired in-process cache:
      // Request uses Redis copy -> NO DB query!
      clearUserAuthCache(user.id);
      findByPkSpy.mockClear();

      const err2 = await run(token);
      expect(err2).toBeNull();
      expect(findByPkSpy).toHaveBeenCalledTimes(0);

      // 3. Simulate TTL expiry on the Redis key (expiresAt in the past) and clear in-process cache
      clearUserAuthCache(user.id);
      const entry = mockStore.get(key);
      expect(entry).toBeDefined();
      entry.expiresAt = Date.now() - 1000; // TTL expired!

      // 4. Next request cannot use expired Redis copy -> triggers fresh DB query
      findByPkSpy.mockClear();
      const err3 = await run(token);
      expect(err3).toBeNull();
      expect(findByPkSpy).toHaveBeenCalledTimes(1);

      // Fresh data is written back to Redis with a new 60s TTL
      const refreshed = mockStore.get(key);
      expect(refreshed).toBeDefined();
      expect(refreshed.ttl).toBe(60);
      expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      findByPkSpy.mockRestore();
    }
  });
});
