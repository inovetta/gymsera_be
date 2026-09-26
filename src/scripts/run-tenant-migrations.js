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
  const isDryRun = process.argv.includes('--dry-run');

  console.log(`🚀 Starting tenant database migrations (target version: v${TARGET_SCHEMA_VERSION}, mode: ${isDryRun ? 'DRY-RUN' : 'LIVE'})...\n`);

  await connectPlatform();

  const startTime = Date.now();
  const summary = await runAllTenantMigrations({ dryRun: isDryRun });
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n=========================================');
  console.log(`       TENANT MIGRATION REPORT (${isDryRun ? 'DRY-RUN' : 'LIVE'})`);
  console.log('=========================================');
  console.log(`Total tenants:   ${summary.totalTenants}`);
  console.log(`Successful:      ${summary.successCount}`);
  console.log(`Failed:          ${summary.failedCount}`);
  console.log(`Elapsed time:    ${elapsedSec}s`);
  console.log('-----------------------------------------');

  for (const rep of summary.reports) {
    const tenantLabel = rep.tenantCode ? `[${rep.tenantCode}] ${rep.gymName}` : rep.gymName;
    const versionLabel = `(from v${rep.initialVersion} to v${rep.finalVersion})`;
    if (rep.success) {
      const migCount = rep.applied?.length || 0;
      const detail = isDryRun
        ? (migCount > 0 ? `WOULD RUN: ${rep.applied.join(', ')}` : 'UP TO DATE (no migrations needed)')
        : (migCount > 0 ? `applied ${migCount} migration(s): ${rep.applied.join(', ')}` : 'UP TO DATE (0 applied)');
      console.log(` ✅ ${tenantLabel} ${versionLabel}: OK — ${detail}`);
    } else {
      console.log(` ❌ ${tenantLabel} ${versionLabel}: FAILED — Error: ${rep.error}`);
    }
  }

  console.log('=========================================\n');

  if (summary.failedCount > 0) {
    console.error('❌ One or more tenant migrations failed.');
    process.exit(1);
  }

  console.log(`🎉 All tenant migrations ${isDryRun ? 'dry-run checked' : 'completed'} successfully.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
