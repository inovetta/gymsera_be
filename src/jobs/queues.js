const Bull = require('bull');

/**
 * Creates a safe Bull queue instance wrapper.
 * If Redis is not configured (e.g. on Vercel without REDIS_HOST) or goes offline,
 * queue.add() will safely log a warning and return a dummy object without crashing HTTP requests.
 */
const createSafeQueue = (queueName) => {
  let bullQueue = null;

  const redisHost = process.env.REDIS_HOST;
  const redisUrl = process.env.REDIS_URL;
  const isRedisConfigured = Boolean(redisHost || redisUrl);

  if (isRedisConfigured) {
    try {
      bullQueue = new Bull(queueName, redisUrl || {
        redis: {
          host: redisHost,
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD || undefined,
          connectTimeout: 5000,
          maxRetriesPerRequest: null, // Required by Bull/ioredis to prevent maxRetries limit errors
          enableOfflineQueue: false,
          retryStrategy: (times) => (times > 3 ? null : Math.min(times * 500, 2000)),
        },
      });

      bullQueue.on('error', (err) => {
        console.warn(`[Queue:${queueName}] Redis connection warning:`, err.message);
      });
      bullQueue.on('failed', (job, err) => {
        console.error(`[Queue:${queueName}] Job ${job.id} failed:`, err.message);
      });
    } catch (err) {
      console.warn(`[Queue:${queueName}] Could not initialize Bull queue:`, err.message);
      bullQueue = null;
    }
  } else {
    console.log(`[Queue:${queueName}] No REDIS_HOST/REDIS_URL. Running with no-op background queue.`);
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
      console.log(`[Queue:${queueName}] (No-op) Skipped job add:`, data?.type || data);
      return { id: 'noop' };
    },
    on: (event, handler) => {
      if (bullQueue) bullQueue.on(event, handler);
    },
    process: (handler) => {
      if (bullQueue) bullQueue.process(handler);
    },
  };
};

/**
 * notifications
 * Used in Sprint 7: email/push notification jobs.
 * Job payload: { type, to, subject, templateData }
 */
const notificationsQueue = createSafeQueue('notifications');

module.exports = { notificationsQueue };
