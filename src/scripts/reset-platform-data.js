#!/usr/bin/env node
/**
 * Reset the platform database before real customers go live. DESTRUCTIVE; read docs/runbooks/launch-wipe.md first.
 *
 *   node src/scripts/reset-platform-data.js --keep-admin a@x.com,b@y.com                 # dry run (the default)
 *   node src/scripts/reset-platform-data.js --keep-admin a@x.com --confirm --db <name> --host <host>
 *   ...  --drop-tenant-databases                                                         # also drops tenants.db_name databases
 *
 * Keeps schema_migrations, billing_plans, billing_plan_prices, platform_packages, cities, areas and the named platform
 * admins; empties every other platform table. A real run needs --confirm AND the exact database name AND host that the
 * environment points at. Writes logs/reset-<time>.jsonl (ids, names and counts only).
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../config/database.config');
const { runReset } = require('../services/platform-reset.service');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(name);

async function main() {
  const { platform, tenantServer } = dbConfig;
  const keepAdmins = (arg('--keep-admin') || '').split(',');
  const confirm = flag('--confirm');
  const dropTenantDatabases = flag('--drop-tenant-databases');

  const conn = await mysql.createConnection({
    host: platform.host,
    port: platform.port,
    user: platform.username,
    password: platform.password,
    database: platform.database,
  });
  let adminConn = null;
  try {
    if (confirm && dropTenantDatabases) {
      adminConn = await mysql.createConnection({
        host: tenantServer.host,
        port: tenantServer.port,
        user: tenantServer.adminUser,
        password: tenantServer.adminPass,
      });
    }
    const result = await runReset({
      conn,
      adminConn,
      config: { database: platform.database, host: platform.host },
      keepAdmins,
      confirm,
      db: arg('--db'),
      host: arg('--host'),
      dropTenantDatabases,
      logDir: arg('--log-dir') || path.join(process.cwd(), 'logs'),
    });
    console.log(`\n${result.mode}: log written to ${result.log.file}`);
    if (result.mode === 'DRY_RUN') console.log('Nothing was changed.');
  } finally {
    await conn.end().catch(() => {});
    if (adminConn) await adminConn.end().catch(() => {});
  }
}

const path = require('path');
main().catch((err) => {
  console.error(`REFUSED/FAILED: ${err.message}`);
  process.exit(err.refusal ? 2 : 1);
});
