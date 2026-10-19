/**
 * CI memory (found when PR #125's CI crashed with "JavaScript heap out of memory" at ~3.35 GB).
 * Two things that outlive a test file kept its whole module graph (~22 MB: app, routes, models)
 * reachable, so `jest --runInBand` over ~190 files grew by ~25 MB per file until Node gave up:
 *
 * 1. Rate limiter timers.
 *    Every `rateLimit()` limiter has a MemoryStore whose init() starts a repeating, unref'd 15-minute
 * setInterval in the REAL Node process. Jest does not clear it when a test file ends, and the timer's
 * closure keeps the whole module graph of that test file (app, routes, models: ~22 MB) reachable. With
 * `jest --runInBand` over ~190 suites the retained heap grew by ~25 MB per suite until Node gave up.
 *
 *    Fix: each limiter gets a store created by src/utils/rate-limit-stores.js, which can shut them all
 *    down. Production behaviour is unchanged (same MemoryStore, same interval).
 *
 * 2. The Redis client.
 *    Redis is on in CI; every test file created an ioredis client (one socket to port 6379) and never
 *    quit it. Fix: closeRedisClient() in src/config/redis.config.js.
 *
 * tests/harness/release-process-resources.js (jest setupFilesAfterEnv) does both after every test file.
 * Measured with a forced GC after each file: 25 identical suites kept 22 MB each before, and stay flat after.
 */
const fs = require('fs');
const path = require('path');
const { MemoryStore } = require('express-rate-limit');
const stores = require('../../src/utils/rate-limit-stores');

const ROOT = path.join(__dirname, '../..');

describe('rate limiter stores can be shut down', () => {
  afterEach(() => stores.shutdownAll());

  test('createMemoryStore returns a real MemoryStore and keeps track of it', () => {
    const before = stores.activeStores().length;
    const s = stores.createMemoryStore();
    expect(s).toBeInstanceOf(MemoryStore);
    expect(stores.activeStores()).toContain(s);
    expect(stores.activeStores().length).toBe(before + 1);
  });

  test('shutdownAll clears every store timer and forgets the stores', () => {
    const a = stores.createMemoryStore();
    const b = stores.createMemoryStore();
    a.init({ windowMs: 60000 });
    b.init({ windowMs: 60000 });
    expect(a.interval._destroyed).toBe(false);
    expect(b.interval._destroyed).toBe(false);
    stores.shutdownAll();
    expect(a.interval._destroyed).toBe(true);
    expect(b.interval._destroyed).toBe(true);
    expect(stores.activeStores()).toHaveLength(0);
  });

  test('a store that throws on shutdown does not stop the others', () => {
    const bad = stores.createMemoryStore();
    const good = stores.createMemoryStore();
    good.init({ windowMs: 60000 });
    bad.shutdown = () => {
      throw new Error('boom');
    };
    expect(() => stores.shutdownAll()).not.toThrow();
    expect(good.interval._destroyed).toBe(true);
  });

  test('calling shutdownAll twice is harmless', () => {
    stores.createMemoryStore();
    stores.shutdownAll();
    expect(() => stores.shutdownAll()).not.toThrow();
  });
});

describe('the app uses registered stores for every limiter', () => {
  test('requiring the app registers its limiters (API, auth, metrics), each with a live timer, and shutdownAll stops them all', () => {
    jest.isolateModules(() => {
      const isolatedStores = require('../../src/utils/rate-limit-stores');
      require('../../app');
      const list = isolatedStores.activeStores();
      expect(list.length).toBeGreaterThanOrEqual(3);
      expect(list.every((s) => s.interval && s.interval._destroyed === false)).toBe(true);
      isolatedStores.shutdownAll();
      expect(list.every((s) => s.interval._destroyed === true)).toBe(true);
    });
  });

  test('source guard: every rateLimit(...) call passes an explicit store (a new limiter cannot be forgotten)', () => {
    const files = [path.join(ROOT, 'app.js')];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js') && !e.name.includes('socket-bundle')) files.push(full);
      }
    };
    walk(path.join(ROOT, 'src'));
    const offenders = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const re = /\brateLimit\(\s*\{/g;
      let m;
      while ((m = re.exec(text))) {
        // the options object of this call: up to the matching close at the same nesting
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (let i = end; i < text.length; i++) {
          if (text[i] === '{') depth += 1;
          if (text[i] === '}') {
            depth -= 1;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        const body = text.slice(m.index, end);
        if (!/\bstore\s*:/.test(body)) offenders.push(`${path.relative(ROOT, file)}:${text.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('jest releases the timers after every test file (setupFilesAfterEnv)', () => {
    const config = require('../../jest.config');
    expect(config.setupFilesAfterEnv).toEqual(expect.arrayContaining(['<rootDir>/tests/harness/release-process-resources.js']));
    const hook = fs.readFileSync(path.join(ROOT, 'tests/harness/release-process-resources.js'), 'utf8');
    expect(hook).toMatch(/afterAll\(/);
    expect(hook).toMatch(/release\(\s*'..\/..\/src\/utils\/rate-limit-stores',\s*'shutdownAll'\s*\)/);
    expect(hook).toMatch(/release\(\s*'..\/..\/src\/config\/redis.config',\s*'closeRedisClient'\s*\)/);
  });
});

describe('the cleanup hook never breaks a test file', () => {
  // The hook is an afterAll in setupFilesAfterEnv; capture the function instead of letting jest register it.
  const loadHook = () => {
    let hook;
    const realAfterAll = global.afterAll;
    global.afterAll = (fn) => {
      hook = fn;
    };
    try {
      jest.isolateModules(() => require('../harness/release-process-resources'));
    } finally {
      global.afterAll = realAfterAll;
    }
    return hook;
  };

  test('it runs cleanly against the real modules', async () => {
    await expect(loadHook()()).resolves.toBeUndefined();
  });

  test('a test file that mocks redis.config without closeRedisClient (as access.test.js does) is not broken by it', async () => {
    jest.resetModules();
    jest.doMock('../../src/config/redis.config', () => ({ getRedisClient: () => null }));
    try {
      await expect(loadHook()()).resolves.toBeUndefined();
    } finally {
      jest.dontMock('../../src/config/redis.config');
    }
  });

  test('a closing error is swallowed, not thrown', async () => {
    jest.resetModules();
    jest.doMock('../../src/config/redis.config', () => ({
      closeRedisClient: async () => {
        throw new Error('quit failed');
      },
    }));
    try {
      await expect(loadHook()()).resolves.toBeUndefined();
    } finally {
      jest.dontMock('../../src/config/redis.config');
    }
  });
});

describe('the Redis client can be closed', () => {
  const redisConfig = require('../../src/config/redis.config');
  const redisSockets = () => process._getActiveHandles().filter((h) => h && h.remotePort === Number(process.env.REDIS_PORT || 6379)).length;

  test('closeRedisClient quits the client, drops its socket, and a second call is harmless', async () => {
    const client = redisConfig.getRedisClient();
    if (!client) {
      // DISABLE_REDIS=true (spec 0.1 rule 10): nothing to close, and closing must not fail
      expect(await redisConfig.closeRedisClient()).toBe(false);
      return;
    }
    await redisConfig.ensureRedisReady();
    expect(redisSockets()).toBeGreaterThanOrEqual(1);
    expect(await redisConfig.closeRedisClient()).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(client.status).toBe('end');
    expect(redisSockets()).toBe(0);
    expect(await redisConfig.closeRedisClient()).toBe(false);
  });

  test('after closing, the safe helpers answer null instead of throwing (Redis is an optional accelerator)', async () => {
    await redisConfig.closeRedisClient();
    await expect(redisConfig.safeRedisGet('anything')).resolves.toBeNull();
    await expect(redisConfig.safeRedisDel('anything')).resolves.not.toBeInstanceOf(Error);
  });
});
