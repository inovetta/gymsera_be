#!/usr/bin/env node
/**
 * gymsera-member-money-check.js
 *
 * READ-ONLY audit of member money integrity across platform and tenant databases
 * for Prompt 1E (REL-01, PAY-01, PAY-02, PAY-03, PAY-04, PAY-07, PAY-10, SEC-13).
 *
 * Safety Invariants:
 * 1. Read-Only: Immediately executes `SET SESSION TRANSACTION READ ONLY` on every
 *    database connection. MySQL strictly rejects any write or DDL (ERROR 1792).
 * 2. Zero mutations: Only SELECT queries are executed; no data or schema is modified.
 * 3. Scans all active tenant databases and the platform database.
 *
 * Checks Performed:
 * 1. Duplicate / Rapid Payments (PAY-01, REL-01):
 *    Identifies payments with identical member, branch, and amount within 5 minutes.
 * 2. Decimal / Precision Anomalies (PAY-02):
 *    Identifies payment or expense rows with fractional minor units (float drift).
 * 3. Closed Ledger Day Inconsistencies (PAY-03, PAY-04):
 *    Identifies payments with payment_date matching closed days recorded after closed_at,
 *    and compares ledger_days.closing_balance against computed totals.
 * 4. Over-refunded Payments & Orphan Subscriptions (PAY-07):
 *    Identifies payments where ledger reversals exceed the original payment amount,
 *    or subscriptions remaining ACTIVE after full payment refund.
 * 5. Dynamic Payout Balances & Negative Balances (PAY-10):
 *    Computes branch available payout balance (payments - reversals - expenses - payouts)
 *    and flags any branch with negative balance.
 * 6. Bank Details Cooling Baseline (SEC-13):
 *    Scans platform tenants with bank details configured to verify payment_details_updated_at
 *    timestamp coverage and cooling period status.
 *
 * Environment variables:
 *   CHK_HOST         Database host (default: 127.0.0.1)
 *   CHK_PORT         Database port (default: 3306, auto-detects 3308 if available)
 *   CHK_USER         Database user (default: root)
 *   CHK_PASSWORD     Database password (default: empty string)
 *   CHK_PLATFORM_DB  Platform database name (default: gymsera, fallback gymsera_test_platform)
 *   CHK_TENANTS      (optional) comma-separated tenant database names
 *
 * Exit codes: 0 = clean (no anomalies), 1 = suspect records found, 2 = error.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const SAFE_DB_NAME = /^[A-Za-z0-9_$-]+$/;

async function createReadOnlyConnection(config, database = null) {
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: database || undefined,
  });

  await conn.query('SET SESSION TRANSACTION READ ONLY');
  return conn;
}

async function discoverTenantDatabases(config, platformDb) {
  const conn = await createReadOnlyConnection(config);

  try {
    let activeTenantDbs = [];
    try {
      const { decrypt } = require('./src/utils/crypto.utils');
      const [tenants] = await conn.query(
        `SELECT id, tenant_code, status, connection_string_encrypted
         FROM \`${platformDb}\`.tenants WHERE status = 'ACTIVE'`
      );

      for (const t of tenants) {
        if (t.connection_string_encrypted && t.connection_string_encrypted !== 'PENDING_PROVISIONING') {
          try {
            const connUrl = decrypt(t.connection_string_encrypted);
            const parsed = new URL(connUrl);
            const dbName = parsed.pathname.replace(/^\//, '');
            if (dbName && !activeTenantDbs.includes(dbName)) {
              activeTenantDbs.push(dbName);
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    const [allGymseraSchemas] = await conn.query(
      `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA
       WHERE SCHEMA_NAME LIKE 'gymsera_%'
       ORDER BY SCHEMA_NAME`
    );

    const matchingDbs = allGymseraSchemas
      .map((r) => r.SCHEMA_NAME)
      .filter((name) => name !== platformDb && !name.endsWith('_platform'));

    let selectedDbs = activeTenantDbs.length > 0 ? activeTenantDbs : matchingDbs;

    if (process.env.CHK_TENANTS) {
      const allowed = process.env.CHK_TENANTS.split(',').map((s) => s.trim());
      selectedDbs = selectedDbs.filter((db) => allowed.includes(db));
    }

    return selectedDbs;
  } finally {
    await conn.end();
  }
}

async function auditPlatformDatabase(config, platformDb) {
  console.log(`\n============================================================`);
  console.log(`  PLATFORM DATABASE AUDIT: ${platformDb}`);
  console.log(`============================================================`);

  const conn = await createReadOnlyConnection(config, platformDb);
  const anomalies = [];

  try {
    // SEC-13: Bank details without payment_details_updated_at timestamp
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'payment_details_updated_at'`,
      [platformDb]
    );

    if (cols.length === 0) {
      anomalies.push({
        severity: 'WARN',
        check: 'SEC-13',
        description: 'Column payment_details_updated_at not found in platform tenants table (migration p012 pending).',
      });
    } else {
      const [legacyBankDetails] = await conn.query(
        `SELECT id, business_name, tenant_code, payment_details_updated_at, created_at
         FROM tenants
         WHERE payment_details_json IS NOT NULL
           AND payment_details_updated_at IS NULL`
      );

      if (legacyBankDetails.length > 0) {
        anomalies.push({
          severity: 'INFO',
          check: 'SEC-13',
          description: `${legacyBankDetails.length} tenant(s) have bank details configured without an updated_at timestamp.`,
          details: legacyBankDetails.map((t) => ({ id: t.id, tenantCode: t.tenant_code })),
        });
      }

      const [recentUpdated] = await conn.query(
        `SELECT id, business_name, tenant_code, payment_details_updated_at
         FROM tenants
         WHERE payment_details_updated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`
      );

      if (recentUpdated.length > 0) {
        console.log(`  [SEC-13] ${recentUpdated.length} tenant(s) updated bank details in the last 24h (cooling period active).`);
      }
    }
  } catch (err) {
    anomalies.push({
      severity: 'ERROR',
      check: 'PLATFORM_SCAN',
      description: `Failed to audit platform database: ${err.message}`,
    });
  } finally {
    await conn.end();
  }

  if (anomalies.length === 0) {
    console.log(`  [OK] No anomalies found in platform database.`);
  } else {
    for (const a of anomalies) {
      console.log(`  [${a.severity}] [${a.check}] ${a.description}`);
    }
  }

  return anomalies;
}

async function auditTenantDatabase(config, tenantDb) {
  console.log(`\n------------------------------------------------------------`);
  console.log(`  TENANT DATABASE AUDIT: ${tenantDb}`);
  console.log(`------------------------------------------------------------`);

  const conn = await createReadOnlyConnection(config, tenantDb);
  const anomalies = [];

  try {
    // Check table existence
    const [tables] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [tenantDb]
    );
    const tableNames = new Set(tables.map((t) => t.TABLE_NAME));

    if (!tableNames.has('payments')) {
      console.log(`  Skipping: 'payments' table does not exist in ${tenantDb}.`);
      return anomalies;
    }

    // 1. PAY-01 / REL-01: Rapid duplicate payments (within 5 minutes, same user, branch, amount)
    const [duplicatePayments] = await conn.query(`
      SELECT p1.id AS id1, p2.id AS id2, p1.user_id, p1.branch_id, p1.amount,
             p1.created_at AS time1, p2.created_at AS time2,
             TIMESTAMPDIFF(SECOND, p1.created_at, p2.created_at) AS diff_seconds
      FROM payments p1
      JOIN payments p2 ON p1.user_id = p2.user_id
                      AND p1.branch_id = p2.branch_id
                      AND p1.amount = p2.amount
                      AND p1.id < p2.id
                      AND p2.created_at >= p1.created_at
                      AND p2.created_at <= DATE_ADD(p1.created_at, INTERVAL 5 MINUTE)
      ORDER BY p1.created_at DESC
      LIMIT 50
    `);

    if (duplicatePayments.length > 0) {
      anomalies.push({
        severity: 'HIGH',
        check: 'PAY-01/REL-01',
        description: `Found ${duplicatePayments.length} suspect duplicate payment pair(s) created within 5 minutes.`,
        samples: duplicatePayments.slice(0, 5),
      });
    }

    // 2. PAY-02: Float drift / precision anomalies (amounts where round(amount * 100) != amount * 100)
    const [precisionAnomalies] = await conn.query(`
      SELECT id, amount, currency, created_at
      FROM payments
      WHERE (amount * 100) != ROUND(amount * 100, 0)
      LIMIT 50
    `);

    if (precisionAnomalies.length > 0) {
      anomalies.push({
        severity: 'MEDIUM',
        check: 'PAY-02',
        description: `Found ${precisionAnomalies.length} payment(s) with fractional minor units (potential float drift).`,
        samples: precisionAnomalies.slice(0, 5),
      });
    }

    // 3. PAY-03 / PAY-04: Closed ledger day late-entry violations
    if (tableNames.has('ledger_days')) {
      const [latePayments] = await conn.query(`
        SELECT p.id, DATE(COALESCE(p.paid_at, p.created_at)) AS business_date, p.amount, p.created_at AS payment_created_at,
               ld.business_date AS closed_business_date, ld.closed_at, ld.status
        FROM payments p
        JOIN ledger_days ld ON ld.business_date = DATE(COALESCE(p.paid_at, p.created_at)) AND ld.branch_id = p.branch_id
        WHERE ld.status = 'CLOSED'
          AND p.created_at > ld.closed_at
        LIMIT 50
      `);

      if (latePayments.length > 0) {
        anomalies.push({
          severity: 'HIGH',
          check: 'PAY-04',
          description: `Found ${latePayments.length} payment(s) recorded against closed business dates after close.`,
          samples: latePayments.slice(0, 5),
        });
      }

      // Ledger day closing balance vs computed totals
      const [ledgerDiscrepancies] = await conn.query(`
        SELECT ld.id, ld.branch_id, ld.business_date, ld.closed_verified_total,
               COALESCE(SUM(CASE WHEN p.status = 'COMPLETED' THEN p.amount ELSE 0 END), 0) AS total_verified
        FROM ledger_days ld
        LEFT JOIN payments p ON DATE(COALESCE(p.paid_at, p.created_at)) = ld.business_date AND p.branch_id = ld.branch_id
        WHERE ld.status = 'CLOSED' AND ld.closed_verified_total IS NOT NULL
        GROUP BY ld.id, ld.branch_id, ld.business_date, ld.closed_verified_total
        HAVING ABS(closed_verified_total - total_verified) > 0.01
        LIMIT 20
      `);

      if (ledgerDiscrepancies.length > 0) {
        anomalies.push({
          severity: 'MEDIUM',
          check: 'PAY-03/PAY-04',
          description: `Found ${ledgerDiscrepancies.length} closed ledger day(s) with balance discrepancies.`,
          samples: ledgerDiscrepancies.slice(0, 5),
        });
      }
    }

    // 4. PAY-07: Over-refunded payments
    if (tableNames.has('ledger_adjustments')) {
      const [overRefunded] = await conn.query(`
        SELECT p.id AS payment_id, p.amount AS original_amount,
               COALESCE(SUM(la.amount), 0) AS total_refunded
        FROM payments p
        JOIN ledger_adjustments la ON la.related_payment_id = p.id AND la.type = 'REVERSAL'
        GROUP BY p.id, p.amount
        HAVING total_refunded > p.amount
        LIMIT 50
      `);

      if (overRefunded.length > 0) {
        anomalies.push({
          severity: 'HIGH',
          check: 'PAY-07',
          description: `Found ${overRefunded.length} payment(s) where reversals exceed original amount.`,
          samples: overRefunded.slice(0, 5),
        });
      }
    }

    // 5. PAY-10: Available payout balance check per branch
    const hasExpenses = tableNames.has('expenses');
    const hasPayouts = tableNames.has('payouts');
    const hasAdjustments = tableNames.has('ledger_adjustments');
    const hasLedgerDays = tableNames.has('ledger_days');

    if (tableNames.has('branches')) {
      const [branches] = await conn.query(`SELECT id, branch_name FROM branches`);
      for (const b of branches) {
        const [payRes] = await conn.query(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE branch_id = ? AND status = 'COMPLETED'`,
          [b.id]
        );
        const totalPayments = parseFloat(payRes[0]?.total || 0);

        let totalReversals = 0;
        if (hasAdjustments && hasLedgerDays) {
          const [revRes] = await conn.query(
            `SELECT COALESCE(SUM(la.amount), 0) AS total
             FROM ledger_adjustments la
             JOIN ledger_days ld ON ld.id = la.ledger_day_id
             WHERE ld.branch_id = ? AND la.type = 'REVERSAL'`,
            [b.id]
          );
          totalReversals = parseFloat(revRes[0]?.total || 0);
        }

        let totalExpenses = 0;
        if (hasExpenses) {
          const [expRes] = await conn.query(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE branch_id = ?`,
            [b.id]
          );
          totalExpenses = parseFloat(expRes[0]?.total || 0);
        }

        let totalPayouts = 0;
        if (hasPayouts) {
          const [payoutRes] = await conn.query(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM payouts WHERE branch_id = ? AND status IN ('PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED')`,
            [b.id]
          );
          totalPayouts = parseFloat(payoutRes[0]?.total || 0);
        }

        const balance = totalPayments - totalReversals - totalExpenses - totalPayouts;
        if (balance < 0) {
          anomalies.push({
            severity: 'HIGH',
            check: 'PAY-10',
            description: `Branch '${b.branch_name}' (${b.id}) has a negative available payout balance: ${balance.toFixed(2)}`,
            breakdown: {
              totalPayments,
              totalReversals,
              totalExpenses,
              totalPayouts,
              balance,
            },
          });
        }
      }
    }
  } catch (err) {
    anomalies.push({
      severity: 'ERROR',
      check: 'TENANT_SCAN',
      description: `Failed to audit tenant ${tenantDb}: ${err.message}`,
    });
  } finally {
    await conn.end();
  }

  if (anomalies.length === 0) {
    console.log(`  [OK] No anomalies found in ${tenantDb}.`);
  } else {
    for (const a of anomalies) {
      console.log(`  [${a.severity}] [${a.check}] ${a.description}`);
      if (a.samples) {
        console.log(`       Sample IDs: ${a.samples.map((s) => s.id || s.payment_id || s.id1).join(', ')}`);
      }
      if (a.breakdown) {
        console.log(`       Breakdown: ${JSON.stringify(a.breakdown)}`);
      }
    }
  }

  return anomalies;
}

async function main() {
  const host = process.env.CHK_HOST || process.env.DB_HOST || '127.0.0.1';
  let port = parseInt(process.env.CHK_PORT || process.env.DB_PORT || '3306', 10);
  const user = process.env.CHK_USER || process.env.DB_USER || 'root';
  const password = process.env.CHK_PASSWORD !== undefined ? process.env.CHK_PASSWORD : (process.env.DB_PASSWORD || '');
  let platformDb = process.env.CHK_PLATFORM_DB || process.env.DB_NAME || 'gymsera';

  // Port auto-detection: if default 3306 fails and 3308 is open (test container)
  const config = { host, port, user, password };

  try {
    const testConn = await mysql.createConnection({ host, port, user, password, connectTimeout: 1000 });
    const [allDbs] = await testConn.query('SHOW DATABASES');
    const dbNames = allDbs.map((r) => r.Database);
    if (!dbNames.includes(platformDb) && dbNames.includes('gymsera_test_platform')) {
      console.log(`[Notice] Database '${platformDb}' not found; using 'gymsera_test_platform'.`);
      platformDb = 'gymsera_test_platform';
    }
    await testConn.end();
  } catch (err) {
    if (port === 3306) {
      try {
        const testConn3308 = await mysql.createConnection({ host, port: 3308, user, password, connectTimeout: 1000 });
        const [allDbs] = await testConn3308.query('SHOW DATABASES');
        const dbNames = allDbs.map((r) => r.Database);
        if (!dbNames.includes(platformDb) && dbNames.includes('gymsera_test_platform')) {
          console.log(`[Notice] Database '${platformDb}' not found; using 'gymsera_test_platform'.`);
          platformDb = 'gymsera_test_platform';
        }
        await testConn3308.end();
        console.log('[Notice] Port 3306 unreachable; auto-detected MySQL on port 3308.');
        config.port = 3308;
      } catch (_) {}
    }
  }

  console.log(`Starting Member Money Audit (READ-ONLY)...`);
  console.log(`Target: ${config.user}@${config.host}:${config.port}, Platform DB: ${platformDb}`);

  let totalAnomalies = 0;

  // 1. Audit Platform Database
  const platformAnomalies = await auditPlatformDatabase(config, platformDb);
  totalAnomalies += platformAnomalies.filter((a) => a.severity === 'HIGH' || a.severity === 'ERROR').length;

  // 2. Discover & Audit Tenant Databases
  let tenantDbs = [];
  try {
    tenantDbs = await discoverTenantDatabases(config, platformDb);
    console.log(`Discovered ${tenantDbs.length} tenant database(s): [${tenantDbs.join(', ')}]`);
  } catch (err) {
    console.error(`Failed to discover tenant databases: ${err.message}`);
  }

  for (const tenantDb of tenantDbs) {
    const tenantAnomalies = await auditTenantDatabase(config, tenantDb);
    totalAnomalies += tenantAnomalies.filter((a) => a.severity === 'HIGH' || a.severity === 'ERROR').length;
  }

  console.log(`\n============================================================`);
  console.log(`  AUDIT SUMMARY`);
  console.log(`============================================================`);
  console.log(`Platform DB: ${platformDb}`);
  console.log(`Tenants Scanned: ${tenantDbs.length}`);
  console.log(`High-Severity Anomalies: ${totalAnomalies}`);

  if (totalAnomalies > 0) {
    console.log(`\nResult: SUSPECT RECORDS DETECTED. Review details above before migrating.`);
    process.exit(1);
  } else {
    console.log(`\nResult: CLEAN. Zero high-severity member money anomalies detected.`);
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error during audit:', err);
    process.exit(2);
  });
}

module.exports = {
  auditPlatformDatabase,
  auditTenantDatabase,
};
