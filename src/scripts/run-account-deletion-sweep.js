#!/usr/bin/env node
/**
 * CLI runner for day 30 of account deletion (AUTH-07; spec §14 R-16 / R-28).
 *
 * Finishes every deletion whose 30-day undo window has passed: anonymizes in place,
 * cancels the memberships of deleted tenants, keeps the financial records. It never
 * drops a database.
 *
 * Usage (preview first):
 *   node src/scripts/run-account-deletion-sweep.js --dry-run
 *   node src/scripts/run-account-deletion-sweep.js
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');
const { runDeletionFinalizeSweep } = require('../services/account-deletion-finalize.service');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Account deletion sweep (R-16 / R-28, mode: ${dryRun ? 'DRY-RUN' : 'LIVE'})...\n`);
  await sequelize.authenticate();

  const result = await runDeletionFinalizeSweep({ dryRun });

  console.log('=========================================');
  console.log(`  ACCOUNT DELETION SWEEP (${dryRun ? 'DRY-RUN' : 'LIVE'})`);
  console.log('=========================================');
  console.log(`Tenants due: ${result.tenants.length}   Users due: ${result.users.length}`);
  for (const t of result.tenants) console.log(` - tenant ${t.tenantCode || t.id} (window ended ${t.scheduledFor})`);
  for (const u of result.users) console.log(` - user ${u.id} (window ended ${u.scheduledFor})`);
  if (!dryRun) {
    console.log(`Finalized tenants: ${result.finalizedTenants.length}   Finalized users: ${result.finalizedUsers.length}`);
    for (const f of result.failed) console.log(` ! ${f.type} ${f.id} will be retried: ${f.error}`);
  }
  console.log('=========================================\n');

  await sequelize.close().catch(() => {});
  process.exit(result.failed.length > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error('Fatal account deletion sweep error:', err);
  process.exit(1);
});
