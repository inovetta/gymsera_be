/**
 * CLI runner for tenant database migrations.
 *
 * Usage:
 *   node src/scripts/run-tenant-migrations.js
 *
 * Runs all pending migrations across all active tenant databases,
 * tracking schema_migrations per tenant and reporting results.
 */
require('dotenv').config();
const { connect: connectPlatform } = require('../database/platform');
const { runAllTenantMigrations, TARGET_SCHEMA_VERSION } = require('../database/tenant-migration-runner');

async function main() {
  console.log(`🚀 Starting tenant database migrations (target version: v${TARGET_SCHEMA_VERSION})...\n`);

  await connectPlatform();

  const startTime = Date.now();
  const summary = await runAllTenantMigrations();
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n=========================================');
  console.log('       TENANT MIGRATION REPORT           ');
  console.log('=========================================');
  console.log(`Total tenants:   ${summary.totalTenants}`);
  console.log(`Successful:      ${summary.successCount}`);
  console.log(`Failed:          ${summary.failedCount}`);
  console.log(`Elapsed time:    ${elapsedSec}s`);
  console.log('-----------------------------------------');

  for (const rep of summary.reports) {
    if (rep.success) {
      console.log(` ✅ ${rep.gymName} (v${rep.initialVersion} -> v${rep.finalVersion}) — applied ${rep.applied?.length || 0} migration(s)`);
    } else {
      console.log(` ❌ ${rep.gymName} — ERROR: ${rep.error}`);
    }
  }

  console.log('=========================================\n');

  if (summary.failedCount > 0) {
    console.error('❌ One or more tenant migrations failed.');
    process.exit(1);
  }

  console.log('🎉 All tenant migrations completed successfully.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
