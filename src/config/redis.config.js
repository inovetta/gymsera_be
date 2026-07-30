const Redis = require('ioredis');

let client;

/**
 * Returns the singleton Redis client, creating it on first call.
 */
const getRedisClient = () => {
  if (!client) {
    client = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 2000);
        return delay;
      },
    });

    client.on('connect', () => console.log('[Redis] Connected'));
    client.on('error', (err) => console.error('[Redis] Error:', err.message));
    client.on('reconnecting', () => console.log('[Redis] Reconnecting...'));
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
    if (redis.status !== 'ready') return null;
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
    if (redis.status !== 'ready') return;
    await redis.setex(key, ttl, value);
  } catch (err) {
    console.warn(`[Redis Cache] SETEX failed for key "${key}":`, err.message);
  }
};

module.exports = { getRedisClient, safeRedisGet, safeRedisSetex };

