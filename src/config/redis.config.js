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
      enableReadyCheck: true,
      lazyConnect: false,
    });

    client.on('connect', () => console.log('[Redis] Connected'));
    client.on('error', (err) => console.error('[Redis] Error:', err.message));
    client.on('reconnecting', () => console.log('[Redis] Reconnecting...'));
  }
  return client;
};

module.exports = { getRedisClient };
