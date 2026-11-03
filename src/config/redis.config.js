const Redis = require('ioredis');

let client;
let isRedisDisabled = false;
// P10 item 4 (R-88): a CLI (run-scheduled-job.js) asks for no "Redis not configured" line; the API
// keeps its one boot line. An unreachable Redis is reported once per process in both.
let quietWhenNotConfigured = false;
let unreachableReported = false;
const setQuietWhenNotConfigured = (quiet = true) => {
  quietWhenNotConfigured = quiet;
};

/**
 * Returns the singleton Redis client, creating it on first call.
 * If REDIS_HOST / REDIS_URL is not provided or Redis is offline,
 * Redis caching is cleanly disabled without throwing connection errors or crashing.
 */
const getRedisClient = () => {
  if (isRedisDisabled) return null;

  const redisHost = process.env.REDIS_HOST || (process.env.NODE_ENV === 'test' && process.env.DISABLE_REDIS !== 'true' ? '127.0.0.1' : undefined);
  const redisUrl = process.env.REDIS_URL;

  // If no Redis host/url is configured or disabled
  if ((!redisHost && !redisUrl) || process.env.DISABLE_REDIS === 'true') {
    isRedisDisabled = true;
    if (!quietWhenNotConfigured) console.log('[Redis] No REDIS_HOST or REDIS_URL configured. Redis caching disabled.');
    return null;
  }

  if (!client) {
    client = new Redis(redisUrl || {
      host: redisHost || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      retryStrategy(times) {
        if (times > 3) {
          reportUnreachable('no answer after 3 reconnect attempts');
          isRedisDisabled = true;
          return null; // Stop reconnecting
        }
        return Math.min(times * 200, 1500);
      },
    });

    const where = redisUrl ? 'REDIS_URL' : `${redisHost || '127.0.0.1'}:${process.env.REDIS_PORT || '6379'}`;
    // One line per process, not one per reconnect attempt plus "Connection ended" (P10 item 4).
    const reportUnreachable = (why) => {
      if (unreachableReported) return;
      unreachableReported = true;
      console.warn(
        `[Redis] not reachable at ${where} (${why}); this process runs without Redis: locks use MySQL, ` +
          'caches stay in process. Set DISABLE_REDIS=true on a server without Redis.'
      );
    };
    const current = client;
    current.on('connect', () => console.log('[Redis] Connected'));
    current.on('error', (err) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH') {
        reportUnreachable(err.code);
        isRedisDisabled = true;
        current.disconnect(); // disabled for good in this process: stop reconnecting
        return;
      }
      console.warn('[Redis] Connection warning:', err.message);
    });
    current.on('end', () => {
      if (!unreachableReported) console.warn('[Redis] Connection ended. Bypassing Redis cache.');
      isRedisDisabled = true;
    });
  }
  return client;
};

/**
 * Quits the singleton client and forgets it, so its socket (and everything the client's callbacks
 * reference) can be released. Used by the test harness after every test file: Redis is on in CI, and a
 * client per file that never quit kept each file's whole module graph in memory. Never throws.
 * @returns {Promise<boolean>} true when there was a client to close
 */
const closeRedisClient = async () => {
  const current = client;
  client = undefined;
  if (!current) return false;
  try {
    if (current.status === 'ready') await current.quit();
    else current.disconnect();
  } catch (_) {
    try {
      current.disconnect();
    } catch (__) {
      /* already closed */
    }
  }
  return true;
};

/**
 * Safely ensures the Redis client is connected and ready to accept commands.
 * Awaits connection establishment if currently handshaking.
 * Returns null if Redis is disabled, offline, or failed to connect.
 */
const ensureRedisReady = async () => {
  if (isRedisDisabled) return null;
  const redis = getRedisClient();
  if (!redis) return null;
  if (redis.status === 'ready') return redis;
  if (redis.status === 'connecting' || redis.status === 'connect') {
    await new Promise((resolve) => {
      let resolved = false;
      const onDone = () => {
        if (resolved) return;
        resolved = true;
        redis.removeListener('ready', onDone);
        redis.removeListener('error', onDone);
        redis.removeListener('close', onDone);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(onDone, 1000);
      redis.once('ready', onDone);
      redis.once('error', onDone);
      redis.once('close', onDone);
    });
  }
  return redis.status === 'ready' ? redis : null;
};

/**
 * Safely performs a Redis GET operation.
 * Returns null if Redis is offline or if the command times out/fails.
 */
const safeRedisGet = async (key) => {
  try {
    const redis = await ensureRedisReady();
    if (!redis) return null;
    return await redis.get(key);
  } catch (err) {
    console.warn(`[Redis Cache] GET failed for key "${key}", bypassing cache:`, err.message);
    return null;
  }
};

/**
 * Safely performs a Redis SETEX operation.
 * Silently ignores errors if Redis is offline or if the command fails.
 */
const safeRedisSetex = async (key, ttl, value) => {
  try {
    const redis = await ensureRedisReady();
    if (!redis) return;
    await redis.setex(key, ttl, value);
  } catch (err) {
    console.warn(`[Redis Cache] SETEX failed for key "${key}":`, err.message);
  }
};

/**
 * Safely performs a Redis DEL operation.
 * Silently ignores errors if Redis is offline or if the command fails.
 */
const safeRedisDel = async (key) => {
  try {
    const redis = await ensureRedisReady();
    if (!redis) return;
    await redis.del(key);
  } catch (err) {
    console.warn(`[Redis Cache] DEL failed for key "${key}":`, err.message);
  }
};

module.exports = { getRedisClient, setQuietWhenNotConfigured, closeRedisClient, ensureRedisReady, safeRedisGet, safeRedisSetex, safeRedisDel };
