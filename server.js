// GymsEra API Server — Production v1.0.4 (Fail-proof pre-flight CORS & staging domain config)
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

    // Run one-time payments branchId backfill
    (async () => {
        try {
          console.log('[Backfill] Running payments branchId backfill...');
          const { Tenant } = require('./src/models/platform');
          const tenants = await Tenant.findAll();
          for (const tenant of tenants) {
            try {
              const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
              const { Payment, MemberSubscription } = tenantDb.models;
              const payments = await Payment.findAll({
                where: { paymentFor: 'MEMBERSHIP', branchId: null }
              });
              let updated = 0;
              for (const payment of payments) {
                if (payment.referenceEntityId) {
                  const sub = await MemberSubscription.findByPk(payment.referenceEntityId);
                  if (sub && sub.branchId) {
                    await payment.update({ branchId: sub.branchId });
                    updated++;
                  }
                }
              }
              if (updated > 0) {
                console.log(`[Backfill] Backfilled branchId for ${updated} payments in tenant: ${tenant.gymName}`);
              }
            } catch (e) {
              console.error(`[Backfill] Tenant ${tenant.gymName} failed:`, e.message);
            }
          }
          console.log('[Backfill] Payments branchId backfill finished.');
        } catch (err) {
          console.error('[Backfill] Global error:', err.message);
        }
      })();

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
