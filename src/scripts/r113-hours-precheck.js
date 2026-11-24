/**
 * R-113 deploy precheck (owner decision R-116 item 4). READ-ONLY: it runs SELECT statements only.
 *
 *   node src/scripts/r113-hours-precheck.js
 *
 * Prints counts and tenant codes only, never a host, user, password or connection string.
 * Credentials come from the environment the API already uses (.env / IIS app settings): the platform
 * DB for the tenant list, and each tenant's own encrypted connection string (TENANT_CONN_ENCRYPTION_KEY),
 * exactly as `run-tenant-migrations.js --check` connects.
 *
 * It answers, with real numbers:
 *  1. how many tenants have a database (`tenants.db_name`) and how many the migration runner touches
 *     (ACTIVE, SUSPENDED, PENDING_DELETION with a connection string): the databases migration 029 must reach;
 *  2. per tenant database, how many branches have an equal opening / closing pair (e.g. 00:00 / 00:00),
 *     the legacy pairs NEW-292 makes a no-op when an old form sends them back unchanged, and whether
 *     `branches.hours_json` (migration 029) already exists there.
 */
require('dotenv').config();
const { Sequelize, QueryTypes, Op } = require('sequelize');
const { decrypt } = require('../utils/crypto.utils');
const { MIGRATABLE_TENANT_STATUSES } = require('../database/tenant-migration-runner');

async function precheck() {
  const { Tenant } = require('../models/platform');
  const withDbName = await Tenant.count({ where: { dbName: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] } } });
  const tenants = (await Tenant.findAll({
    where: { status: { [Op.in]: MIGRATABLE_TENANT_STATUSES }, connectionStringEncrypted: { [Op.ne]: null } },
    attributes: ['id', 'organizationCode', 'status', 'connectionStringEncrypted'],
    order: [['organizationCode', 'ASC']],
  })).filter((t) => t.connectionStringEncrypted !== 'PENDING_PROVISIONING');

  const rows = [];
  for (const t of tenants) {
    let seq = null;
    try {
      seq = new Sequelize(decrypt(t.connectionStringEncrypted), {
        dialect: 'mysql', logging: false, pool: { max: 1, min: 0, acquire: 10000, idle: 5000 },
        dialectOptions: { connectTimeout: 10000 },
      });
      const cols = await seq.query(
        'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'branches\'',
        { type: QueryTypes.SELECT }
      );
      const names = cols.map((r) => r.c);
      if (!names.includes('opening_time')) {
        rows.push({ organizationCode: t.organizationCode, status: t.status, branches: 0, equalPairs: 0, hoursJsonColumn: false, note: 'no branches table' });
        continue;
      }
      const hasHours = names.includes('hours_json');
      const [r] = await seq.query(
        `SELECT COUNT(*) AS branches,
                SUM(opening_time IS NOT NULL AND opening_time = closing_time) AS equalPairs
                ${hasHours ? ', SUM(opening_time IS NOT NULL AND opening_time = closing_time AND hours_json IS NULL) AS equalPairsNoSchedule' : ''}
           FROM branches`,
        { type: QueryTypes.SELECT }
      );
      rows.push({
        organizationCode: t.organizationCode,
        status: t.status,
        branches: Number(r.branches || 0),
        equalPairs: Number(r.equalPairs || 0),
        hoursJsonColumn: hasHours,
        ...(hasHours ? { equalPairsNoSchedule: Number(r.equalPairsNoSchedule || 0) } : {}),
      });
    } catch (err) {
      // The error's class only: a driver message can name the host or the user.
      rows.push({ organizationCode: t.organizationCode, status: t.status, error: err && err.name ? err.name : 'Error' });
    } finally {
      if (seq) await seq.close().catch(() => {});
    }
  }
  return { tenantsWithDbName: withDbName, migratableTenants: tenants.length, tenants: rows };
}

function report(result, write = (s) => process.stdout.write(s)) {
  write(`Tenants with a database (tenants.db_name set): ${result.tenantsWithDbName}\n`);
  write(`Tenant databases the migration runner touches: ${result.migratableTenants}\n`);
  let equal = 0;
  let unreadable = 0;
  for (const r of result.tenants) {
    if (r.error) {
      unreadable += 1;
      write(`UNREADABLE ${r.organizationCode} (${r.status}): ${r.error}\n`);
      continue;
    }
    equal += r.equalPairs;
    write(`${r.organizationCode} (${r.status}): ${r.branches} branch(es), ${r.equalPairs} with an equal opening / closing pair`
      + `${r.hoursJsonColumn ? `, ${r.equalPairsNoSchedule} of them with no schedule; hours_json present` : '; hours_json NOT present (migration 029 not applied)'}`
      + `${r.note ? ` (${r.note})` : ''}\n`);
  }
  write(`Total branches with an equal pair: ${equal}. Unreadable tenant databases: ${unreadable}.\n`);
}

async function main() {
  const { connect, sequelize } = require('../database/platform');
  await connect();
  try {
    report(await precheck());
  } finally {
    await sequelize.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`r113-hours-precheck failed: ${err && err.name ? err.name : 'Error'}`);
    process.exitCode = 1;
  });
}

module.exports = { precheck, report };
