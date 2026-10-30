// GymsEra API Server — Production v1.1.0
require('dotenv').config();

const app = require('./app');
const { connect: connectPlatformDb, sequelize: platformSequelize } = require('./src/database/platform');
const { getRedisClient } = require('./src/config/redis.config');
const TenantDbManager = require('./src/database/TenantDbManager');
const { runExpiryCheck, EXPIRY_CRON } = require('./src/jobs/subscription-expiry.cron');
const cron = require('node-cron');
const errorTracker = require('./src/utils/error-tracker');

// NEW-123: one boot line in the error journal and on the console (iisnode stdout file),
// before anything that can fail, so a deploy is checkable without waiting for a 5xx.
require('./src/utils/error-journal').boot();

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

    // 6. Send queued error reports (OBS-02): waits at most 2 s, never fails the shutdown
    await errorTracker.flush(2000);

    clearTimeout(forceTimer);
    console.log('[Shutdown] Graceful shutdown complete');
    process.exit(exitCode);
  } catch (err) {
    console.error('[Shutdown] Error during shutdown:', err);
    process.exit(1);
  }
}

// REL-05: Do not swallow uncaught exceptions; log unhandled rejections without terminating server
process.on('uncaughtException', (err) => {
  console.error('[Process FATAL] Uncaught Exception:', err);
  errorTracker.captureException(err, { tags: { source: 'uncaughtException' } });
  // Give the report up to 2 s to leave before the process goes down; flush never rejects.
  errorTracker.flush(2000).then(() => shutdown('uncaughtException', 1));
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process ERROR] Unhandled Rejection:', reason);
  errorTracker.captureException(reason instanceof Error ? reason : new Error(String(reason)), {
    tags: { source: 'unhandledRejection' },
  });
});

process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));

async function bootstrap() {
  try {
    // 0. Refuse to start without SMTP settings or database passwords — there
    //    is no built-in fallback for either — or as staging on the production
    //    platform database (NEW-131).
    require('./src/config/environment-guard').assertEnvironmentSafe();
    require('./src/config/smtp.config').assertSmtpConfigured();
    require('./src/config/database.config').assertDatabaseConfigured();

    // 1. Connect to Platform MySQL
    await connectPlatformDb();

    // 1b. Read-only tenant schema check (spec §6.5, NEW-126): a tenant behind the target or
    //     unreadable gets an error line, the TENANT_SCHEMA_BEHIND alert and a 503 on
    //     /api/v1/health/tenant-schema. Re-checked on a schedule (step 4d). Never throws.
    const { runTenantSchemaCheck } = require('./src/services/tenant-schema-health.service');
    await runTenantSchemaCheck();
    await require('./src/database/platform-migrations').checkPlatformSchemaVersion(platformSequelize);

    // 2. Warm up Redis connection
    getRedisClient();

    // 4 and 4b run here unless SCHEDULED_JOBS=external: under iisnode this process stops with
    // the IIS application pool, so production can run them from Windows Task Scheduler instead
    // (src/scripts/run-scheduled-job.js, P7c item 9, NEW-178).
    if (require('./src/jobs/scheduled-jobs').inProcessSchedulesEnabled()) {
      // 4. Register subscription-expiry cron (REL-03: runs with distributed lock)
      cron.schedule(EXPIRY_CRON, () => {
        runExpiryCheck().catch((err) =>
          console.error('[Cron] subscription-expiry error:', err.message)
        );
      });

      // 4b. Retry billing webhook events that failed to process (BILL-12, REL-03: runs with distributed lock)
      const { processPendingEvents, sweepBillingAlerts } = require('./src/services/billing-event.service');
      cron.schedule('* * * * *', () => {
        processPendingEvents()
          .catch((err) => console.error('[Cron] billing-events sweep error:', err.message))
          // OBS-05: alert on stuck / failing events and duplicate billing (never throws; one alert per code per hour)
          .then(() => sweepBillingAlerts());
      });
    } else {
      console.log('[Cron] SCHEDULED_JOBS=external: the daily job and the billing inbox retry run from Task Scheduler');
    }

    // 4c. Daily read-only check of Play Console prices against the plan catalog (BILL-15).
    // Inert without GOOGLE_PLAY_SERVICE_ACCOUNT_JSON; runs under the distributed lock; never changes a plan.
    const { withDistributedLock } = require('./src/utils/distributed-lock');
    cron.schedule(process.env.PRICE_VERIFICATION_CRON || '40 3 * * *', () => {
      withDistributedLock('cron:price-verification', 600000, () => require('./src/services/price-verification.service').runPriceVerification())
        .catch((err) => console.error('[Cron] price-verification error:', err.message));
    });

    // 4d. Tenant schema re-check (NEW-126), so a migration run or a new tenant behind the target
    //     shows on the health route without a restart. Read-only.
    cron.schedule(process.env.TENANT_SCHEMA_CHECK_CRON || '*/15 * * * *', () => {
      runTenantSchemaCheck();
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
