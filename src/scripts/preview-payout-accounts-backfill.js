/**
 * READ-ONLY preview of platform migration p027 (P7b, R-94): which tenants' saved bank details
 * (tenants.payment_details_json) would become their tenant default payout account.
 * SELECT statements only; prints tenant ids and field NAMES, never the account values.
 *
 * Usage:  node src/scripts/preview-payout-accounts-backfill.js
 * Then:   node src/scripts/run-platform-migrations.js --dry-run, then without the flag.
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');
const { planPayoutAccountBackfill } = require('../database/payout-accounts-backfill');

const printPlan = (plan, log = console.log) => {
  log('=========================================');
  log('   p027 PAYOUT ACCOUNTS BACKFILL (PREVIEW, NO WRITES)');
  log('=========================================');
  log(`Tenants with saved bank details: ${plan.tenantsScanned}`);
  log(`WOULD COPY to a tenant default payout account: ${plan.copy.length}`);
  for (const item of plan.copy) {
    log(`  - tenant ${item.tenantId}: fields [${item.keys.join(', ')}], changed at ${item.detailsUpdatedAt || 'unknown'}`);
  }
  log(`Already have a tenant default (left alone): ${plan.alreadyHaveDefault.length}`);
  plan.alreadyHaveDefault.forEach((id) => log(`  - tenant ${id}`));
  log(`Empty or unreadable (not copied): ${plan.emptyOrUnreadable.length}`);
  plan.emptyOrUnreadable.forEach((r) => log(`  - tenant ${r.tenantId}: ${r.reason}`));
  log('=========================================');
};

async function main() {
  // authenticate() only: platform.js#connect runs boot-time ALTERs, which would write.
  await sequelize.authenticate();
  printPlan(await planPayoutAccountBackfill(sequelize));
  await sequelize.close().catch(() => {});
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Preview failed:', err.message || err.code || err.name);
    process.exit(1);
  });
}

module.exports = { printPlan };
