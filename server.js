// GymsEra API Server — Production v1.1.0
require('dotenv').config();

const app = require('./app');
const { connect: connectPlatformDb, sequelize: platformSequelize } = require('./src/database/platform');
const { getRedisClient } = require('./src/config/redis.config');
const TenantDbManager = require('./src/database/TenantDbManager');
const { runExpiryCheck, EXPIRY_CRON } = require('./src/jobs/subscription-expiry.cron');
const cron = require('node-cron');

const PORT = process.env.PORT || 3000;
let server = null;
let socketGateway = null;
let isShuttingDown = false;

// ── Graceful shutdown (REL-05 / spec §12) ────────────────────────────────────
async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[${signal}] Shutting down gracefully...`);

  // Force exit after 30s if in-flight requests or pools fail to close (spec REL-05)
  const forceTimer = setTimeout(() => {
    console.error('[Shutdown] Forced exit: 30s drain timeout reached');
    process.exit(1);
  }, 30000);
  forceTimer.unref();

  try {
    // 1. Close HTTP server (stop accepting new connections, drain in-flight)
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log('[Shutdown] HTTP server closed, in-flight requests drained');
    }

    // 2. Close WebSockets / Socket.IO gateway
    if (socketGateway && typeof socketGateway.close === 'function') {
      await socketGateway.close();
      console.log('[Shutdown] Socket.IO gateway closed');
    }

    // 3. Release Tenant DB connection pools
    await TenantDbManager.releaseAll();
    console.log('[Shutdown] All tenant DB connections released');

    // 4. Close Platform DB pool
    if (platformSequelize) {
      await platformSequelize.close();
      console.log('[Shutdown] Platform DB pool closed');
    }

    // 5. Close Redis client
    try {
      const redis = getRedisClient();
      if (redis && redis.status === 'ready') {
        await redis.quit();
        console.log('[Shutdown] Redis connection closed');
      }
    } catch (redisErr) {
      console.warn('[Shutdown] Redis quit error:', redisErr.message);
    }

    clearTimeout(forceTimer);
    console.log('[Shutdown] Graceful shutdown complete');
    process.exit(exitCode);
  } catch (err) {
    console.error('[Shutdown] Error during shutdown:', err);
    process.exit(1);
  }
}

// REL-05: Do not swallow uncaught exceptions or unhandled rejections
process.on('uncaughtException', (err) => {
  console.error('[Process FATAL] Uncaught Exception:', err);
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process FATAL] Unhandled Rejection:', reason);
  shutdown('unhandledRejection', 1);
});

process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));

async function bootstrap() {
  try {
    // 0. Refuse to start without SMTP settings or database passwords — there
    //    is no built-in fallback for either.
    require('./src/config/smtp.config').assertSmtpConfigured();
    require('./src/config/database.config').assertDatabaseConfigured();

    // 1. Connect to Platform MySQL
    await connectPlatformDb();

    // 1b. Read-only startup check: warn if any active tenant schema is behind latest (spec §6.5)
    try {
      const { checkTenantSchemaVersions } = require('./src/database/tenant-migration-runner');
      await checkTenantSchemaVersions();
    } catch (checkErr) {
      console.warn('[Server Startup] Tenant schema check warning:', checkErr?.message || checkErr);
    }
    await require('./src/database/platform-migrations').checkPlatformSchemaVersion(platformSequelize);

    // 2. Warm up Redis connection
    getRedisClient();

    // 4. Register subscription-expiry cron (REL-03: runs with distributed lock)
    cron.schedule(EXPIRY_CRON, () => {
      runExpiryCheck().catch((err) =>
        console.error('[Cron] subscription-expiry error:', err.message)
      );
    });

    // 4b. Retry billing webhook events that failed to process (BILL-12, REL-03: runs with distributed lock)
    const { processPendingEvents } = require('./src/services/billing-event.service');
    cron.schedule('* * * * *', () => {
      processPendingEvents().catch((err) =>
        console.error('[Cron] billing-events sweep error:', err.message)
      );
    });

    // 5. Start HTTP server
    server = app.listen(PORT, () => {
      console.log(`\n🚀 GymsEra API running on port ${PORT}`);
      console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
      console.log(`   API base    : http://localhost:${PORT}/api/v1`);
      console.log(`   Swagger     : http://localhost:${PORT}/api/docs\n`);
    });

    // Safely attach Socket.IO if module is installed (never crash HTTP server)
    try {
      socketGateway = require('./src/socket');
      if (socketGateway && typeof socketGateway.init === 'function') {
        socketGateway.init(server);
      }
    } catch (err) {
      console.warn('[Server] Socket.IO initialization skipped:', err.message);
    }
  } catch (err) {
    console.error('Failed to start GymsEra API:', err);
    process.exit(1);
  }
}

bootstrap();
