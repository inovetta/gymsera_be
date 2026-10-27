/**
 * Repair one tenant database that has no `schema_migrations` table (NEW-127, GYM-4814C134).
 *
 *   node src/scripts/repair-tenant-schema.js --tenant GYM-XXXXXXXX                                  (dry run)
 *   node src/scripts/repair-tenant-schema.js --tenant GYM-XXXXXXXX --apply --confirm GYM-XXXXXXXX
 *
 * Read-only inspection first (src/database/tenant-schema-baseline.js): for every tenant migration,
 * is its effect already there (present), not there (missing), or there in another shape (conflict)?
 * It refuses and changes nothing when: the database already has `schema_migrations` (use
 * run-tenant-migrations.js), it is not a tenant database, any migration is in conflict, or the
 * models read a table / column that no tenant migration adds (NEW-126).
 *
 * With --apply and the matching --confirm: creates `schema_migrations`, records the present
 * migrations (baseline, no DDL), then runs only the missing ones through the normal runner, and
 * checks every version is recorded. Exit codes: 0 done (or dry run clean), 2 refused, 1 error or
 * incomplete. Uses the API's PLATFORM_DB_* settings and the tenant's stored connection; prints
 * no password and no personal data (tenant code and database name only).
 */
const { Sequelize } = require('sequelize');
const { inspectTenantSchema, repairTenantSchema } = require('../database/tenant-schema-baseline');
const { MIGRATIONS, TARGET_SCHEMA_VERSION } = require('../database/tenant-migration-runner');
const { decrypt } = require('../utils/crypto.utils');

const argValue = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const label = (v) => MIGRATIONS.find((m) => m.version === v)?.name || `v${v}`;

const printInspection = (write, inspection) => {
  for (const p of inspection.probes) {
    const state = { present: 'present  (baseline)', missing: 'missing  (will run)', conflict: 'CONFLICT' }[p.state];
    write(`  ${p.name.padEnd(52)} ${state}${p.detail ? `  - ${p.detail}` : ''}\n`);
  }
};

/**
 * @param {string[]} argv
 * @param {{ write?: (s: string) => void, connectPlatform?: () => Promise<void> }} [io]
 * @returns {Promise<number>} exit code
 */
async function main(argv, { write = (s) => process.stdout.write(s), connectPlatform } = {}) {
  const tenantCode = argValue(argv, '--tenant');
  const apply = argv.includes('--apply');
  const confirm = argValue(argv, '--confirm');
  if (!tenantCode) {
    write('Usage: node src/scripts/repair-tenant-schema.js --tenant <TENANT_CODE> [--apply --confirm <TENANT_CODE>]\n');
    return 2;
  }
  if (apply && confirm !== tenantCode) {
    write(`REFUSED: --apply needs --confirm ${tenantCode} (the exact tenant code). Nothing was changed.\n`);
    return 2;
  }

  if (connectPlatform) await connectPlatform();
  const { Tenant } = require('../models/platform');
  const tenant = await Tenant.findOne({ where: { tenantCode } });
  if (!tenant) {
    write(`REFUSED: no tenant with code ${tenantCode}. Nothing was changed.\n`);
    return 2;
  }
  if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') {
    write(`REFUSED: tenant ${tenantCode} has no provisioned database. Nothing was changed.\n`);
    return 2;
  }

  const seq = new Sequelize(decrypt(tenant.connectionStringEncrypted), {
    dialect: 'mysql',
    logging: false,
    pool: { max: 2, min: 0, acquire: 20000, idle: 10000 },
    dialectOptions: { connectTimeout: 15000 },
  });
  try {
    await seq.authenticate();
    const [{ db }] = await seq.query('SELECT DATABASE() AS db', { type: Sequelize.QueryTypes.SELECT });
    write(`Tenant ${tenantCode} (status ${tenant.status}), database ${db}, target schema v${TARGET_SCHEMA_VERSION}\n`);
    write(`Mode: ${apply ? 'APPLY' : 'DRY RUN (nothing is changed)'}\n\n`);

    const inspection = await inspectTenantSchema(seq);
    write(`schema_migrations: ${inspection.hasMigrationTable ? `present (${inspection.recordedVersions.length} recorded)` : 'MISSING'}\n`);
    printInspection(write, inspection);
    write('\n');

    if (inspection.refusals.length) {
      write('REFUSED, unexpected schema. Nothing was changed:\n');
      for (const r of inspection.refusals) write(`  - ${r}\n`);
      return 2;
    }

    const baseline = inspection.baseline.map(label);
    const toApply = inspection.toApply.map(label);
    if (!apply) {
      write(`Would record ${baseline.length} migration(s) as already applied (no schema change): ${baseline.join(', ') || 'none'}\n`);
      write(`Would run ${toApply.length} migration(s): ${toApply.join(', ') || 'none'}\n`);
      write(`DRY RUN complete. Nothing was changed. To apply: node src/scripts/repair-tenant-schema.js --tenant ${tenantCode} --apply --confirm ${tenantCode}\n`);
      return 0;
    }

    const result = await repairTenantSchema(seq, { apply: true, tenantId: tenant.id, tenantCode, gymName: tenantCode });
    if (result.refused) {
      // The schema changed between the two reads: report, change nothing.
      write('REFUSED on the second read. Nothing was changed:\n');
      for (const r of result.inspection.refusals) write(`  - ${r}\n`);
      return 2;
    }
    write(`Recorded as already applied: ${result.inspection.baseline.map(label).join(', ') || 'none'}\n`);
    write(`Ran: ${result.migrationResult.applied.join(', ') || 'none'}\n`);
    if (result.missingAfter.length) {
      write(`INCOMPLETE: still not recorded: ${result.missingAfter.map(label).join(', ')}. See the [TenantMigration] lines above.\n`);
      return 1;
    }
    write(`DONE: tenant ${tenantCode} is at v${TARGET_SCHEMA_VERSION}, every migration recorded.\n`);
    return 0;
  } finally {
    await seq.close().catch(() => {});
  }
}

if (require.main === module) {
  require('dotenv').config();
  const platform = require('../database/platform');
  // exitCode, not exit(): output written to a pipe is flushed before the process ends (NEW-128).
  main(process.argv.slice(2), { connectPlatform: platform.connect })
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stdout.write(`ERROR: ${err.code || err.name}: ${err.message}\nNothing after this point was done.\n`);
      process.exitCode = 1;
    })
    .finally(() => platform.sequelize.close().catch(() => {}));
}

module.exports = { main };
