// GymsEra API Server — Production v1.1.0 (Self-contained WebSocket real-time gateway - 2026-09-10)
process.on('uncaughtException', (err) => {
  console.error('[Process] Prevented crash from uncaught exception:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Prevented crash from unhandled rejection:', reason?.message || reason);
});

require('dotenv').config();

const app = require('./app');
const { connect: connectPlatformDb } = require('./src/database/platform');
const { getRedisClient } = require('./src/config/redis.config');
const TenantDbManager = require('./src/database/TenantDbManager');
const { notificationsQueue } = require('./src/jobs/queues');
const { processNotification } = require('./src/jobs/notifications.processor');
const { runExpiryCheck, EXPIRY_CRON } = require('./src/jobs/subscription-expiry.cron');
const cron = require('node-cron');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  try {
    // 1. Connect to Platform MySQL
    await connectPlatformDb();

    // 1b. Read-only startup check: warn if any active tenant schema is behind latest (spec §6.5)
    try {
      const { checkTenantSchemaVersions } = require('./src/database/tenant-migration-runner');
      await checkTenantSchemaVersions();
    } catch (checkErr) {
      console.warn('[Server Startup] Tenant schema check warning:', checkErr?.message || checkErr);
    }

    // 2. Warm up Redis connection
    getRedisClient();

    // 3. Register Bull job processors
    notificationsQueue.process(processNotification);

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

    // Safely attach Socket.IO if module is installed (never crash HTTP server)
    try {
      const socketGateway = require('./src/socket');
      if (socketGateway && typeof socketGateway.init === 'function') {
        socketGateway.init(server);
      }
    } catch (err) {
      console.warn('[Server] Socket.IO initialization skipped:', err.message);
    }

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

bootstrap(); // Force nodemon restart again
