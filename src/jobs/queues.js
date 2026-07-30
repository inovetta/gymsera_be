const Bull = require('bull');

// Fail fast instead of hanging: if Redis is unreachable/misconfigured, a
// serverless request awaiting queue.add() must not block until the platform's
// own function timeout kills it (this previously caused 500s after ~4 min).
const redisOpts = {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => (times > 2 ? null : Math.min(times * 500, 2000)),
  },
};

/**
 * notifications
 * Used in Sprint 7: email/push notification jobs.
 * Job payload: { type, to, subject, templateData }
 */
const notificationsQueue = new Bull('notifications', redisOpts);

// ── Error logging ─────────────────────────────────────────────────────────────
notificationsQueue.on('failed', (job, err) => {
  console.error(`[Queue:notifications] Job ${job.id} failed:`, err.message);
});

notificationsQueue.on('error', (err) => {
  console.error('[Queue:notifications] Redis connection error:', err.message);
});

module.exports = { notificationsQueue };
