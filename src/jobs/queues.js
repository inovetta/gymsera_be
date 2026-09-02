const Bull = require('bull');
const Redis = require('ioredis');

/**
 * Creates a safe Bull queue instance wrapper.
 * If Redis is offline or not configured, all internal clients (client, bclient, eclient)
 * have attached error handlers to prevent unhandled ECONNREFUSED from crashing the process.
 */
const createSafeQueue = (queueName) => {
  let bullQueue = null;

  const redisHost = process.env.REDIS_HOST;
  const redisUrl = process.env.REDIS_URL;
  const isRedisConfigured = Boolean(redisHost || redisUrl);

  if (isRedisConfigured && process.env.DISABLE_REDIS !== 'true') {
    try {
      const createClient = (type) => {
        const client = new Redis(redisUrl || {
          host: redisHost || '127.0.0.1',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD || undefined,
          connectTimeout: 5000,
          maxRetriesPerRequest: null,
          enableOfflineQueue: false,
          retryStrategy: (times) => (times > 3 ? null : Math.min(times * 300, 1500)),
        });

        client.on('error', (err) => {
          console.warn(`[Queue:${queueName}:${type}] Redis connection warning:`, err.message);
        });

        return client;
      };

      bullQueue = new Bull(queueName, { createClient });

      bullQueue.on('error', (err) => {
        console.warn(`[Queue:${queueName}] Queue warning:`, err.message);
      });
      bullQueue.on('failed', (job, err) => {
        console.error(`[Queue:${queueName}] Job ${job.id} failed:`, err.message);
      });
    } catch (err) {
      console.warn(`[Queue:${queueName}] Could not initialize Bull queue:`, err.message);
      bullQueue = null;
    }
  } else {
    console.log(`[Queue:${queueName}] Redis not active. Running with no-op background queue.`);
  }

  return {
    add: async (data, opts) => {
      if (bullQueue) {
        try {
          return await bullQueue.add(data, opts);
        } catch (err) {
          console.warn(`[Queue:${queueName}] Failed to add job:`, err.message);
          return { id: 'noop' };
        }
      }
      return { id: 'noop' };
    },
    on: (event, handler) => {
      if (bullQueue) bullQueue.on(event, handler);
    },
    process: (handler) => {
      if (bullQueue) {
        try {
          bullQueue.process(handler);
        } catch (err) {
          console.warn(`[Queue:${queueName}] Failed to start processor:`, err.message);
        }
      }
    },
  };
};

/**
 * notifications queue
 * Used for background email/push notification jobs.
 */
const notificationsQueue = createSafeQueue('notifications');

module.exports = { notificationsQueue };
