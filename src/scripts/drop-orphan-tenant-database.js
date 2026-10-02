#!/usr/bin/env node
/**
 * Manually remove ONE leftover tenant database (NEW-34; spec §14 R-28 point 6).
 * Nothing runs this for you. Candidates come from the read-only
 * `node gymsera-flow02-provisioning-check.js` (verdict ORPHAN_DATABASE).
 *
 * Default is a DRY RUN: it says whether the database may be dropped and why not.
 *
 *   node src/scripts/drop-orphan-tenant-database.js gymsera_gym_abc123
 *   node src/scripts/drop-orphan-tenant-database.js gymsera_gym_abc123 --apply --confirm gymsera_gym_abc123
 *
 * Uses only TENANT_DB_ADMIN_USER / TENANT_DB_ADMIN_PASS (R-25). Refuses: live tenants,
 * tenants in the undo window, REJECTED < 90 days, DELETED < 6 years, databases with
 * payment/invoice/ledger rows, and databases no tenant row maps to.
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');
const { getTenantDbConfig, createSafeAdminConnection } = require('../services/tenant-provisioning.service');
const { dropOrphanTenantDatabase } = require('../services/orphan-database.service');

async function main() {
  const args = process.argv.slice(2);
  const dbName = args.find((a) => !a.startsWith('--') && a !== args[args.indexOf('--confirm') + 1]);
  const apply = args.includes('--apply');
  const confirm = args.includes('--confirm') ? args[args.indexOf('--confirm') + 1] : undefined;
  if (!dbName) throw new Error('Usage: drop-orphan-tenant-database.js <databaseName> [--apply --confirm <databaseName>]');

  await sequelize.authenticate();
  const adminConn = await createSafeAdminConnection(getTenantDbConfig());
  try {
    const res = await dropOrphanTenantDatabase({ dbName, adminConn, apply, confirm });
    console.log(JSON.stringify(res, null, 2));
    if (res.dryRun) console.log(res.eligible ? '\nDRY RUN: this database could be dropped. Re-run with --apply --confirm <name>.' : `\nDRY RUN: not eligible. ${res.reason}`);
  } finally {
    await adminConn.end().catch(() => {});
    await sequelize.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
