const Bull = require('bull');

const redisOpts = {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
  },
};

/**
 * tenant-provisioning
 * Used in Sprint 3: TenantProvisioningService adds jobs when admin approves a tenant.
 * Job payload: { tenantId }
 */
const tenantProvisioningQueue = new Bull('tenant-provisioning', redisOpts);

/**
 * notifications
 * Used in Sprint 7: email/push notification jobs.
 * Job payload: { type, to, subject, templateData }
 */
const notificationsQueue = new Bull('notifications', redisOpts);

// ── Error logging ─────────────────────────────────────────────────────────────
tenantProvisioningQueue.on('failed', (job, err) => {
  console.error(`[Queue:tenant-provisioning] Job ${job.id} failed:`, err.message);
});

notificationsQueue.on('failed', (job, err) => {
  console.error(`[Queue:notifications] Job ${job.id} failed:`, err.message);
});

tenantProvisioningQueue.on('completed', (job) => {
  console.log(`[Queue:tenant-provisioning] Job ${job.id} completed`);
});

module.exports = { tenantProvisioningQueue, notificationsQueue };
