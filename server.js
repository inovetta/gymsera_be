require('dotenv').config();

const app = require('./app');
const { connect: connectPlatformDb } = require('./src/database/platform');
const { getRedisClient } = require('./src/config/redis.config');
const TenantDbManager = require('./src/database/TenantDbManager');
const { tenantProvisioningQueue, notificationsQueue } = require('./src/jobs/queues');
const { processTenantProvisioning } = require('./src/services/tenant-provisioning.service');
const { processNotification } = require('./src/jobs/notifications.processor');
const { runExpiryCheck, EXPIRY_CRON } = require('./src/jobs/subscription-expiry.cron');
const cron = require('node-cron');

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  try {
    // 1. Connect to Platform MySQL
    await connectPlatformDb();

    // 2. Warm up Redis connection
    getRedisClient();

    // 3. Register Bull job processors
    tenantProvisioningQueue.process(1, processTenantProvisioning);
    notificationsQueue.process(5, processNotification);

    // 4. Register subscription-expiry cron (node-cron; fallback if Bull repeat not desired)
    cron.schedule(EXPIRY_CRON, () => {
      runExpiryCheck().catch((err) =>
        console.error('[Cron] subscription-expiry error:', err.message)
      );
    });

    // 5. Start HTTP server
    const server = app.listen(PORT, () => {
      console.log(`\n🚀 GymsEra API running on port ${PORT}`);
      console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
      console.log(`   API base    : http://localhost:${PORT}/api/v1`);
      console.log(`   Swagger     : http://localhost:${PORT}/api/docs\n`);
    });

    // 6. Graceful shutdown
    const shutdown = async (signal) => {
      console.log(`\n[${signal}] Shutting down gracefully...`);

      server.close(async () => {
        await TenantDbManager.releaseAll();
        console.log('All tenant DB connections closed');
        process.exit(0);
      });

      // Force exit after 10 s if connections won't close
      setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('Failed to start GymsEra API:', err);
    process.exit(1);
  }
}

bootstrap();
