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
    safeRedisGet: jest.fn(async (key) => (mockStore.has(key) ? mockStore.get(key).value : null)),
    safeRedisSetex: jest.fn(async (key, ttl, value) => {
      mockStore.set(key, { ttl, value });
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
    expect(mockStore.get(key)).toEqual({ ttl: 60, value: JSON.stringify({ status: 'ACTIVE', ver: user.permissionVersion || 1 }) });
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
});
