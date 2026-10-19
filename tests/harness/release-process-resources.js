/**
 * After every test file, release what would otherwise outlive it.
 *
 * Both are real, process-level resources, and each one keeps that file's whole module graph (app, routes,
 * models: ~22 MB) reachable. Over ~190 files in one process that ran CI out of heap (exit 134).
 *  - the rate limiters' repeating timers (src/utils/rate-limit-stores.js)
 *  - the Redis client, one socket per file when Redis is on (src/config/redis.config.js)
 * The reasoning and the measurements are in tests/regression/test-hygiene-rate-limit-stores.test.js.
 *
 * Cleanup must never break a test file: a file may replace either module with a mock that lacks these
 * functions (access.test.js mocks redis.config), so each step is looked up, guarded and isolated.
 */
const release = async (modulePath, fnName) => {
  try {
    const mod = require(modulePath);
    if (mod && typeof mod[fnName] === 'function') await mod[fnName]();
  } catch (_) {
    /* a failing cleanup is not a failing test */
  }
};

afterAll(async () => {
  await release('../../src/utils/rate-limit-stores', 'shutdownAll');
  await release('../../src/config/redis.config', 'closeRedisClient');
});
