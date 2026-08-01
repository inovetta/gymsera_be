const Redis = require('ioredis');

let client;
let isRedisDisabled = false;

/**
 * Returns the singleton Redis client, creating it on first call.
 * If REDIS_HOST / REDIS_URL is not provided (e.g. on Vercel without Redis),
 * Redis caching is cleanly disabled without throwing connection errors.
 */
const getRedisClient = () => {
  if (isRedisDisabled) return null;

  const redisHost = process.env.REDIS_HOST;
  const redisUrl = process.env.REDIS_URL;

  // If no Redis host/url is configured, disable Redis caching cleanly
  if (!redisHost && !redisUrl) {
    isRedisDisabled = true;
    console.log('[Redis] No REDIS_HOST or REDIS_URL configured. Redis caching disabled.');
    return null;
  }

  if (!client) {
    client = new Redis(redisUrl || {
      host: redisHost,
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null, // Required to prevent ioredis "Reached the max retries per request limit"
      enableOfflineQueue: false,
      connectTimeout: 5000,
      retryStrategy(times) {
        if (times > 3) {
          console.warn('[Redis] Max reconnect attempts reached. Disabling Redis cache.');
          return null; // Stop reconnecting
        }
        return Math.min(times * 200, 2000);
      },
    });

    client.on('connect', () => console.log('[Redis] Connected'));
    client.on('error', (err) => console.warn('[Redis] Connection warning:', err.message));
  }
  return client;
};

/**
 * Safely performs a Redis GET operation.
 * Returns null if Redis is offline or if the command times out/fails.
 */
const safeRedisGet = async (key) => {
  try {
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
    const redis = getRedisClient();
    if (!redis || redis.status !== 'ready') return;
    await redis.setex(key, ttl, value);
  } catch (err) {
    console.warn(`[Redis Cache] SETEX failed for key "${key}":`, err.message);
  }
};

module.exports = { getRedisClient, safeRedisGet, safeRedisSetex };

