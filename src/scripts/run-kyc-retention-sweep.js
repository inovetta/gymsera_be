#!/usr/bin/env node
/**
 * CLI runner for 90-day KYC document retention sweep (spec §14 Rule R-16).
 *
 * Usage:
 *   node src/scripts/run-kyc-retention-sweep.js --dry-run
 *   node src/scripts/run-kyc-retention-sweep.js
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');
const { runKycRetentionSweep } = require('../jobs/kyc-retention.sweep');

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log(`🧹 KYC Document Retention Sweep (R-16, mode: ${isDryRun ? 'DRY-RUN' : 'LIVE'})...\n`);

  await sequelize.authenticate();

  const result = await runKycRetentionSweep({
    sequelize,
    dryRun: isDryRun,
    olderThanDays: 90,
  });

  console.log('=========================================');
  console.log(`    KYC RETENTION SWEEP REPORT (${isDryRun ? 'DRY-RUN' : 'LIVE'})`);
  console.log('=========================================');
  console.log(`Evaluated eligible tenants: ${result.evaluatedTenantsCount}`);
  console.log(`Purged tenants count:       ${result.purgedTenantsCount}`);
  console.log(`Purged documents count:     ${result.purgedDocumentsCount}`);
  if (result.details.length > 0) {
    console.log('\nTenants processed:');
    for (const d of result.details) {
      console.log(` - Tenant [${d.tenantCode || d.tenantId}] (${d.status}, rejected: ${d.rejectedAt}): ${d.documentCount} docs`);
    }
  }
  console.log('=========================================\n');

  await sequelize.close().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal retention sweep error:', err);
  process.exit(1);
});
