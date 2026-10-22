#!/usr/bin/env node
/**
 * Staging test script. Refuses to run unless told it is staging (scripts/staging/lib/guard.js).
 *
 *   GYMSERA_ENV=staging STAGING_DB_HOSTS=<host> PRODUCTION_DB_HOSTS=<prod host> \
 *   node scripts/staging/staging-check.js --env=staging <check…>
 *
 * Checks (any combination; none = all except `purchases`, which needs a token):
 *   --purchases --google-token <t> --apple-transaction <id>   read-only: is it a store sandbox purchase, and in what state
 *       add --apply --tenant <id> to run the real sync into that staging tenant and confirm its subscription row
 *   --audit        auditCapacity over every ACTIVE tenant (read-only)
 *   --reconcile    stuck/failed billing events and lapsed-but-entitling subscriptions (read-only)
 *   --restore-drill  dump the platform DB into restore_drill_<stamp> on the same server, compare row counts, drop it
 *       --keep-drill keeps it; --drop-old-drills drops leftover restore_drill_* databases (only those names)
 * Exit codes: 0 all green, 1 a check failed, 2 refused. Output is ids and counts only.
 */
require('dotenv').config();
const { assertStaging } = require('./lib/guard');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };

async function main() {
  const dbConfig = require('../../src/config/database.config');
  assertStaging({ argv, env: process.env, platformHost: dbConfig.platform.host });

  const { Op } = require('sequelize');
  const mysql = require('mysql2/promise');
  const wantsAny = ['--purchases', '--audit', '--reconcile', '--restore-drill', '--drop-old-drills'].some(flag);
  const want = (n) => flag(n) || (!wantsAny && n !== '--purchases');
  const report = {};

  if (flag('--purchases')) {
    const { verifySandboxPurchases } = require('./lib/checks');
    const google = arg('--google-token') ? { purchaseToken: arg('--google-token') } : null;
    const apple = arg('--apple-transaction') ? { transactionId: arg('--apple-transaction') } : null;
    const { playApi } = require('../../src/services/google-play-billing.service');
    const { appleApi } = require('../../src/services/apple-billing.service');
    report.purchases = await verifySandboxPurchases({ google, apple, playApi, appleApi });
    if (flag('--apply') && report.purchases.ok) {
      const tenantId = arg('--tenant');
      if (!tenantId) throw Object.assign(new Error('--apply needs --tenant <id>'), { refusal: true });
      const sync = [];
      if (google) sync.push(['GOOGLE', () => require('../../src/services/google-play-billing.service').syncFromGoogle({ purchaseToken: google.purchaseToken, tenantId })]);
      if (apple) sync.push(['APPLE', () => require('../../src/services/apple-billing.service').syncFromApple({ transactionId: apple.transactionId, tenantId })]);
      report.purchases.applied = [];
      for (const [provider, fn] of sync) {
        const sub = await fn();
        report.purchases.applied.push({ provider, subscriptionId: sub?.id || sub?.subscription?.id || null, status: sub?.status || sub?.subscription?.status || (sub?.pending ? 'PENDING' : null) });
      }
    }
  }

  if (want('--audit')) {
    const { Tenant } = require('../../src/models/platform');
    const TenantDbManager = require('../../src/database/TenantDbManager');
    const { auditCapacity } = require('../../src/services/subscription-quota.service');
    const { auditActiveTenants } = require('./lib/checks');
    report.audit = await auditActiveTenants({
      listActiveTenants: () => Tenant.findAll({ where: { status: 'ACTIVE' }, attributes: ['id', 'connectionStringEncrypted'] }),
      getTenantDb: (t) => (t.connectionStringEncrypted ? TenantDbManager.getConnection(t.id, t.connectionStringEncrypted) : null),
      auditCapacity,
    });
  }

  if (want('--reconcile')) {
    const { BillingEvent, TenantSubscription } = require('../../src/models/platform');
    const { ENTITLING_STATUSES } = require('../../src/services/subscription-quota.service');
    const { reconcileBilling } = require('./lib/checks');
    report.reconcile = await reconcileBilling({
      countEvents: ({ status, receivedBefore }) =>
        BillingEvent.count({ where: { status, ...(receivedBefore ? { receivedAt: { [Op.lt]: receivedBefore } } : {}) } }),
      countLapsed: ({ endedBefore }) =>
        TenantSubscription.count({ where: { status: { [Op.in]: ENTITLING_STATUSES }, endDate: { [Op.lt]: endedBefore } } }),
    });
  }

  if (flag('--restore-drill') || flag('--drop-old-drills')) {
    const { restoreDrill, listDrillDatabases, dropDrillDatabase } = require('./lib/restore-drill');
    const p = dbConfig.platform;
    const adminConn = await mysql.createConnection({ host: p.host, port: p.port, user: p.username, password: p.password });
    try {
      if (flag('--drop-old-drills')) {
        const old = await listDrillDatabases(adminConn);
        for (const name of old) await dropDrillDatabase(adminConn, name, p.database);
        report.droppedOldDrills = old;
      }
      if (flag('--restore-drill')) {
        report.restoreDrill = await restoreDrill({
          adminConn,
          server: { host: p.host, port: p.port, user: p.username, password: p.password },
          sourceDb: p.database,
          keep: flag('--keep-drill'),
        });
      }
    } finally {
      await adminConn.end().catch(() => {});
    }
  }

  console.log(JSON.stringify(report, null, 2));
  const failed = Object.entries(report).filter(([, v]) => v && v.ok === false).map(([k]) => k);
  if (failed.length) {
    console.error(`FAILED: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
  try { await require('../../src/database/platform').sequelize.close(); } catch { /* never connected */ }
}

main().catch((err) => {
  console.error(err.refusal ? err.message : `Staging check failed: ${err.message}`);
  process.exit(err.refusal ? 2 : 1);
});
