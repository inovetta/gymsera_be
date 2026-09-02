const Redis = require('ioredis');

let client;
let isRedisDisabled = false;

/**
 * Returns the singleton Redis client, creating it on first call.
 * If REDIS_HOST / REDIS_URL is not provided or Redis is offline,
 * Redis caching is cleanly disabled without throwing connection errors or crashing.
 */
const getRedisClient = () => {
  if (isRedisDisabled) return null;

  const redisHost = process.env.REDIS_HOST;
  const redisUrl = process.env.REDIS_URL;

  // If no Redis host/url is configured or disabled
  if ((!redisHost && !redisUrl) || process.env.DISABLE_REDIS === 'true') {
    isRedisDisabled = true;
    console.log('[Redis] No REDIS_HOST or REDIS_URL configured. Redis caching disabled.');
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
          console.warn('[Redis] Max reconnect attempts reached. Disabling Redis cache.');
          isRedisDisabled = true;
          return null; // Stop reconnecting
        }
        return Math.min(times * 200, 1500);
      },
    });

    client.on('connect', () => console.log('[Redis] Connected'));
    client.on('error', (err) => {
      console.warn('[Redis] Connection warning:', err.message);
      if (err.code === 'ECONNREFUSED') {
        isRedisDisabled = true;
      }
    });
    client.on('end', () => {
      console.warn('[Redis] Connection ended. Bypassing Redis cache.');
      isRedisDisabled = true;
    });
  }
  return client;
};

/**
 * Safely performs a Redis GET operation.
 * Returns null if Redis is offline or if the command times out/fails.
 */
const safeRedisGet = async (key) => {
  try {
    if (isRedisDisabled) return null;
    const redis = getRedisClient();
    if (!redis || redis.status !== 'ready') return null;
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
    if (isRedisDisabled) return;
    const redis = getRedisClient();
    if (!redis || redis.status !== 'ready') return;
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
    if (isRedisDisabled) return;
    const redis = getRedisClient();
    if (!redis || redis.status !== 'ready') return;
    await redis.del(key);
  } catch (err) {
    console.warn(`[Redis Cache] DEL failed for key "${key}":`, err.message);
  }
};

module.exports = { getRedisClient, safeRedisGet, safeRedisSetex, safeRedisDel };
