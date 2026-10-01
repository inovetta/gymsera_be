'use strict';

/**
 * Manual removal of ONE leftover tenant database (NEW-34; owner decision spec §14 R-28 point 6).
 *
 * Nothing calls this automatically. It is used by `src/scripts/drop-orphan-tenant-database.js`,
 * which is run by a person, for one database, with `--apply --confirm <databaseName>`.
 * The default is a dry run. Finding candidates is the read-only
 * `gymsera-flow02-provisioning-check.js` (verdict ORPHAN_DATABASE).
 *
 * Hard refusals (the database is kept):
 *   - not a `gymsera_*` name, unsafe characters, or the platform database;
 *   - no tenant row maps to it (unknown data: the owner decides by hand);
 *   - the tenant is live (APPROVED / ACTIVE / SUSPENDED), inside its 30-day undo window
 *     (PENDING_DELETION), or still in review;
 *   - a provisioning run holds a live lease on it;
 *   - REJECTED less than 90 days ago (R-16 window);
 *   - DELETED less than 6 years ago (R-16: financial records are kept 6 years);
 *   - a REJECTED tenant's database holds payment / invoice / ledger / payout rows (money is never dropped;
 *     after the 6 years a DELETED tenant's records may go, that is what the retention period is for).
 */
const { Op } = require('sequelize');
const { Tenant, PlatformAuditLog } = require('../models/platform');
const { provisioningSummary, buildDbName } = require('./tenant-provisioning.service');

const DAY_MS = 24 * 60 * 60 * 1000;
const REJECTED_RETENTION_DAYS = 90;
const DELETED_RETENTION_YEARS = 6;
const SAFE_NAME = /^gymsera_[A-Za-z0-9_]+$/;
const MONEY_TABLES = ['payments', 'invoices', 'payouts', 'ledger_days', 'ledger_adjustments'];

const _refuse = (reason) => ({ eligible: false, reason });

/** Pure decision: may this tenant's database be dropped? */
const assessOrphanDrop = ({ tenant, paymentRows = 0, now = new Date() }) => {
  if (!tenant) return _refuse('No tenant row maps to this database; decide by hand, this tool will not drop unknown data.');
  if (provisioningSummary(tenant, now).inProgress) {
    return _refuse('A provisioning run holds a live lease on this tenant; wait for it to stop.');
  }

  const since = (date) => (now.getTime() - new Date(date).getTime()) / DAY_MS;
  switch (tenant.status) {
    case 'REJECTED': {
      const days = since(tenant.rejectedAt || tenant.updatedAt || now);
      if (days < REJECTED_RETENTION_DAYS) return _refuse(`Rejected ${Math.floor(days)} days ago; wait ${REJECTED_RETENTION_DAYS} days (R-16).`);
      // A rejected tenant never handled money; rows here mean something is wrong, so a person looks first.
      if (paymentRows > 0) return _refuse(`The database holds ${paymentRows} payment/invoice/ledger row(s); money records are never dropped.`);
      break;
    }
    case 'DELETED': {
      const years = since(tenant.deletedAt || now) / 365;
      if (years < DELETED_RETENTION_YEARS) {
        return _refuse(`Deleted ${years.toFixed(1)} years ago; financial records are kept ${DELETED_RETENTION_YEARS} years (R-16).`);
      }
      break;
    }
    case 'PENDING_DELETION':
      return _refuse('The tenant is inside its 30-day undo window; not eligible.');
    default:
      return _refuse(`Tenant status ${tenant.status} is not eligible: only REJECTED (after 90 days) or DELETED (after 6 years).`);
  }
  return { eligible: true, reason: null };
};

const _findTenant = async (dbName) => {
  const byName = await Tenant.findOne({ where: { dbName } });
  if (byName) return byName;
  const unnamed = await Tenant.findAll({ where: { dbName: { [Op.is]: null } } });
  return unnamed.find((t) => buildDbName(t.tenantCode) === dbName) || null;
};

const _countMoneyRows = async (adminConn, dbName) => {
  let total = 0;
  for (const table of MONEY_TABLES) {
    const [exists] = await adminConn.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [dbName, table]
    );
    if (exists.length === 0) continue;
    const [[row]] = await adminConn.query(`SELECT COUNT(*) AS n FROM \`${dbName}\`.\`${table}\``);
    total += Number(row.n);
  }
  return total;
};

/**
 * @param {{ dbName: string, adminConn: object, apply?: boolean, confirm?: string, now?: Date }} options
 *   adminConn: a mysql2 connection with DROP privilege (the CLI uses TENANT_DB_ADMIN_USER, R-25).
 */
const dropOrphanTenantDatabase = async ({ dbName, adminConn, apply = false, confirm, now = new Date() }) => {
  if (!SAFE_NAME.test(String(dbName))) throw new Error(`Refusing "${dbName}": only gymsera_* database names are handled.`);
  if (dbName === (process.env.PLATFORM_DB_NAME || 'gymsera')) throw new Error('Refusing: that is the platform database.');
  if (apply && confirm !== dbName) {
    throw new Error(`Refusing: pass --confirm ${dbName} (the exact database name) together with --apply.`);
  }

  const [exists] = await adminConn.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [dbName]);
  if (exists.length === 0) throw new Error(`Database ${dbName} does not exist on this server.`);

  const tenant = await _findTenant(dbName);
  const paymentRows = tenant ? await _countMoneyRows(adminConn, dbName) : 0;
  const verdict = assessOrphanDrop({ tenant, paymentRows, now });
  const base = { dbName, tenantId: tenant?.id || null, tenantCode: tenant?.tenantCode || null, tenantStatus: tenant?.status || null };

  if (!apply) return { ...base, ...verdict, dropped: false, dryRun: true };
  if (!verdict.eligible) throw new Error(`Refusing to drop ${dbName}: ${verdict.reason}`);

  await adminConn.query(`DROP DATABASE \`${dbName}\``);
  await tenant.update({ connectionStringEncrypted: 'PENDING_PROVISIONING' });
  await PlatformAuditLog.create({
    actorUserId: null,
    action: 'TENANT_DATABASE_DROPPED',
    targetType: 'Tenant',
    targetId: tenant.id,
    details: { dbName, tenantStatus: tenant.status, policy: 'R-16 / R-28 (manual, confirmed)' },
    createdAt: new Date(),
  });
  return { ...base, ...verdict, dropped: true, dryRun: false };
};

module.exports = { dropOrphanTenantDatabase, assessOrphanDrop, REJECTED_RETENTION_DAYS, DELETED_RETENTION_YEARS };
