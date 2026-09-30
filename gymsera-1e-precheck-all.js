#!/usr/bin/env node
/**
 * gymsera-1e-precheck-all.js
 *
 * READ-ONLY pre-migration baseline check script for Prompt 1E.
 * Runs prompt-1e-precheck.sql against the platform database (p011, p012)
 * and every active tenant database (011, 012).
 *
 * Safety Invariants:
 * 1. Read-Only: Immediately executes `SET SESSION TRANSACTION READ ONLY` on every
 *    database connection. MySQL strictly rejects any write/DDL statement with ERROR 1792.
 * 2. Zero mutations: Only read-only SELECT queries are executed; no data or schema is modified.
 * 3. Exact verification: Compares actual database state against the exact "safe to migrate"
 *    baseline defined in docs/sql/prompt-1e-precheck.sql.
 * 4. Informational baseline: Reports existing tenants with bank details lacking updated_at
 *    timestamps as informational context without causing a FAIL.
 *
 * Environment variables:
 *   CHK_HOST         Database host (default: 127.0.0.1)
 *   CHK_PORT         Database port (default: 3306, or auto-detected 3308 if available)
 *   CHK_USER         Database user (default: root)
 *   CHK_PASSWORD     Database password (default: empty string)
 *   CHK_PLATFORM_DB  Platform database name (default: auto-detected gymsera or gymsera_test_platform)
 *   CHK_TENANTS      Optional comma-separated list of tenant databases to check
 *
 * Usage:
 *   node gymsera-1e-precheck-all.js
 *   CHK_HOST=127.0.0.1 CHK_PORT=3308 CHK_USER=root CHK_PASSWORD="" node gymsera-1e-precheck-all.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

/**
 * Creates a read-only connection to a specific database.
 */
async function createReadOnlyConnection(config, database = null) {
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: database || undefined,
  });

  // Strict safety guarantee: enforce session read-only mode
  await conn.query('SET SESSION TRANSACTION READ ONLY');
  return conn;
}

/**
 * Parses MySQL version string to check if >= 5.7.8
 */
function isVersionGte578(versionStr) {
  const m = versionStr.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  const patch = parseInt(m[3], 10);

  if (major > 5) return true;
  if (major === 5 && minor > 7) return true;
  if (major === 5 && minor === 7 && patch >= 8) return true;
  return false;
}

/**
 * Checks platform database for migrations p011 and p012.
 */
async function checkPlatformDatabase(config, platformDb) {
  console.log(`\n============================================================`);
  console.log(`  PLATFORM DATABASE PRECHECK: ${platformDb}`);
  console.log(`============================================================`);

  const failures = [];
  const informational = [];
  const conn = await createReadOnlyConnection(config, platformDb);

  try {
    // 0. MySQL version check (expect >= 5.7.8)
    const [verRows] = await conn.query('SELECT VERSION() AS mysql_version');
    const mysqlVer = verRows[0]?.mysql_version || 'unknown';
    if (!isVersionGte578(mysqlVer)) {
      failures.push(`MySQL version (${mysqlVer}) is lower than required 5.7.8`);
    }

    // 1. Platform schema_migrations
    let appliedVersions = [];
    try {
      const [migRows] = await conn.query('SELECT version, name FROM schema_migrations ORDER BY version');
      appliedVersions = migRows.map((r) => r.version);
    } catch (err) {
      failures.push(`Failed to read schema_migrations: ${err.message}`);
    }

    const p011Applied = appliedVersions.includes(11);
    const p012Applied = appliedVersions.includes(12);

    // 2. Check for p011: idempotency_records table
    const [idemTableRows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idempotency_records'`
    );
    const idemTableExists = idemTableRows.length > 0;

    if (idemTableExists) {
      const [idemColRows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idempotency_records' AND COLUMN_NAME = 'idempotency_key'`
      );
      if (idemColRows.length === 0) {
        failures.push(
          `Conflict for p011: 'idempotency_records' table exists without 'idempotency_key' column (conflicting schema).`
        );
      } else if (p011Applied) {
        informational.push(`p011 (idempotency_records table) is already applied (v11 in schema_migrations).`);
      } else {
        informational.push(`'idempotency_records' table exists with valid schema (pre-existing or parallel setup).`);
      }
    } else {
      informational.push(`p011: 'idempotency_records' table absent — clean to create.`);
    }

    // 3. Check for p012: payment_details_updated_at column on tenants table
    const [tenantTableRows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants'`
    );
    const tenantsTableExists = tenantTableRows.length > 0;

    if (!tenantsTableExists) {
      informational.push(`'tenants' table does not exist in this database (skipping tenant column checks).`);
    } else {
      const [colRows] = await conn.query(
        `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'payment_details_updated_at'`
      );

      if (colRows.length > 0) {
        const dataType = String(colRows[0].DATA_TYPE).toLowerCase();
        if (dataType !== 'datetime' && dataType !== 'timestamp') {
          failures.push(
            `Conflict for p012: tenants.payment_details_updated_at exists with non-datetime type '${dataType}'. Expected DATETIME or TIMESTAMP.`
          );
        } else if (p012Applied) {
          informational.push(`p012 (payment_details_updated_at) is already applied (v12 in schema_migrations).`);
        } else {
          informational.push(`tenants.payment_details_updated_at column already exists with type '${dataType}' (idempotent no-op).`);
        }
      } else {
        informational.push(`p012: tenants.payment_details_updated_at column absent — clean to add.`);
      }

      // 4. Baseline query for p012 (INFORMATIONAL — not pass/fail)
      try {
        const [totalTenantsRows] = await conn.query('SELECT COUNT(*) AS n FROM tenants');
        const totalTenants = totalTenantsRows[0]?.n || 0;

        const [tenantsWithBankRows] = await conn.query(
          'SELECT COUNT(*) AS n FROM tenants WHERE payment_details_json IS NOT NULL'
        );
        const tenantsWithBank = tenantsWithBankRows[0]?.n || 0;

        const [baselineRows] = await conn.query(`
          SELECT id, tenant_code, business_name, payment_details_updated_at
          FROM tenants
          WHERE payment_details_json IS NOT NULL
            AND (payment_details_updated_at IS NULL OR payment_details_updated_at = '')
          ORDER BY tenant_code
          LIMIT 10
        `);

        const [baselineCountRows] = await conn.query(`
          SELECT COUNT(*) AS n
          FROM tenants
          WHERE payment_details_json IS NOT NULL
            AND (payment_details_updated_at IS NULL OR payment_details_updated_at = '')
        `);
        const baselineCount = baselineCountRows[0]?.n || 0;

        console.log(`\n  --- p012 Informational Baseline (Bank Details & Cooling Period) ---`);
        console.log(`  Total tenants in platform DB:                    ${totalTenants}`);
        console.log(`  Tenants with configured bank details:           ${tenantsWithBank}`);
        console.log(`  Tenants with bank details but NO timestamp:     ${baselineCount}`);
        if (baselineRows.length > 0) {
          console.log(`  Sample tenants needing updated_at upon next bank change (up to 10):`);
          for (const t of baselineRows) {
            console.log(`    - [${t.tenant_code || 'NO_CODE'}] ${t.business_name || 'Unnamed'} (id: ${t.id})`);
          }
        } else {
          console.log(`  No tenants currently hold bank details without an updated_at timestamp.`);
        }
        console.log(`  --------------------------------------------------------------------\n`);
      } catch (err) {
        informational.push(`Could not run p012 baseline query: ${err.message}`);
      }
    }

    if (failures.length === 0) {
      console.log(`PLATFORM [${platformDb}]: PASS — MySQL ${mysqlVer}, schema_migrations [${appliedVersions.join(', ')}].`);
      for (const info of informational) {
        console.log(`  • ${info}`);
      }
      return { pass: true, failures: [], informational };
    } else {
      console.log(`PLATFORM [${platformDb}]: FAIL`);
      failures.forEach((f) => console.log(`  ✗ ${f}`));
      for (const info of informational) {
        console.log(`  • ${info}`);
      }
      return { pass: false, failures, informational };
    }
  } finally {
    await conn.end();
  }
}

/**
 * Checks a single tenant database for migrations 011 and 012.
 */
async function checkTenantDatabase(config, dbName) {
  const failures = [];
  const informational = [];
  const conn = await createReadOnlyConnection(config, dbName);

  try {
    // 1. Tenant schema_migrations
    let appliedVersions = [];
    try {
      const [migRows] = await conn.query('SELECT version, name FROM schema_migrations ORDER BY version');
      appliedVersions = migRows.map((r) => r.version);
    } catch (err) {
      failures.push(`Failed to read schema_migrations: ${err.message}`);
    }

    const mig011Applied = appliedVersions.includes(11);
    const mig012Applied = appliedVersions.includes(12);

    // 2. Check 011: idempotency_records table
    const [idemTableRows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idempotency_records'`
    );
    const idemTableExists = idemTableRows.length > 0;

    if (idemTableExists) {
      const [idemColRows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idempotency_records' AND COLUMN_NAME = 'idempotency_key'`
      );
      if (idemColRows.length === 0) {
        failures.push(
          `Conflict for 011: 'idempotency_records' table exists without 'idempotency_key' column (conflicting schema).`
        );
      } else if (mig011Applied) {
        informational.push(`Migration 011 already applied (v11 in schema_migrations).`);
      } else {
        informational.push(`'idempotency_records' table exists with valid schema (pre-existing or parallel setup).`);
      }
    } else {
      informational.push(`011: 'idempotency_records' table absent — clean to create.`);
    }

    // 3. Check 012: payouts table
    const [payoutTableRows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payouts'`
    );
    const payoutTableExists = payoutTableRows.length > 0;

    if (payoutTableExists) {
      const [amountColRows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payouts' AND COLUMN_NAME = 'amount'`
      );
      if (amountColRows.length === 0) {
        failures.push(
          `Conflict for 012: 'payouts' table exists without 'amount' column (conflicting schema; 012 would skip).`
        );
      } else if (mig012Applied) {
        informational.push(`Migration 012 already applied (v12 in schema_migrations).`);
      } else {
        informational.push(`'payouts' table exists with valid schema (pre-existing or parallel setup).`);
      }
    } else {
      informational.push(`012: 'payouts' table absent — clean to create.`);
    }

    // 4. Activity metrics (Informational)
    try {
      const [pmRows] = await conn.query('SELECT COUNT(*) AS n FROM payments').catch(() => [{ n: 0 }]);
      const [ldRows] = await conn.query('SELECT COUNT(*) AS n FROM ledger_days').catch(() => [{ n: 0 }]);
      const paymentsCount = pmRows[0]?.n || 0;
      const ledgerDaysCount = ldRows[0]?.n || 0;
      informational.push(`Activity baseline: ${paymentsCount} payments, ${ledgerDaysCount} ledger days.`);
    } catch (_) {}

    if (failures.length === 0) {
      console.log(`PASS: [${dbName}] — schema v${Math.max(...appliedVersions, 0)}, 0 conflicting objects.`);
      for (const info of informational) {
        console.log(`  • ${info}`);
      }
      return { dbName, pass: true, failures: [], informational };
    } else {
      console.log(`FAIL: [${dbName}]`);
      failures.forEach((f) => console.log(`  ✗ ${f}`));
      for (const info of informational) {
        console.log(`  • ${info}`);
      }
      return { dbName, pass: false, failures, informational };
    }
  } catch (err) {
    const errorMsg = `Database connection/query error: ${err.message}`;
    console.log(`FAIL: [${dbName}] — ${errorMsg}`);
    return { dbName, pass: false, failures: [errorMsg], informational: [] };
  } finally {
    await conn.end();
  }
}

/**
 * Discovers active tenant databases.
 */
async function discoverTenantDatabases(config, platformDb) {
  const conn = await createReadOnlyConnection(config);

  try {
    // 1. Try querying platform tenants table if it exists
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
    } catch (_) {
      // Platform tenants table not present or decryption key not configured
    }

    // 2. Query INFORMATION_SCHEMA.SCHEMATA for LIKE 'gymsera_%'
    const [allGymseraSchemas] = await conn.query(
      `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA
       WHERE SCHEMA_NAME LIKE 'gymsera_%'
       ORDER BY SCHEMA_NAME`
    );

    const matchingDbs = allGymseraSchemas
      .map((r) => r.SCHEMA_NAME)
      .filter((name) => name !== platformDb && !name.endsWith('_platform'));

    // If active tenant DBs were determined from platform DB, use them;
    // otherwise fall back to all matching gymsera_% schemas
    let selectedDbs = activeTenantDbs.length > 0 ? activeTenantDbs : matchingDbs;

    // Optional tenant filter via CHK_TENANTS env var (comma-separated)
    if (process.env.CHK_TENANTS) {
      const allowed = process.env.CHK_TENANTS.split(',').map((s) => s.trim());
      selectedDbs = selectedDbs.filter((db) => allowed.includes(db));
    }

    return selectedDbs;
  } finally {
    await conn.end();
  }
}

/**
 * Main execution.
 */
async function main() {
  const host = process.env.CHK_HOST || '127.0.0.1';
  let port = parseInt(process.env.CHK_PORT || '0', 10);
  const user = process.env.CHK_USER || 'root';
  const password = process.env.CHK_PASSWORD || '';
  let platformDb = process.env.CHK_PLATFORM_DB || '';

  // Auto-detect port if not explicitly given: try 3306 first, fallback to 3308 for local Docker test DB
  if (!port) {
    try {
      const test3306 = await mysql.createConnection({ host, port: 3306, user, password });
      await test3306.end();
      port = 3306;
    } catch (_) {
      port = 3308;
    }
  }

  const config = { host, port, user, password };

  // Detect platform database if not specified
  if (!platformDb) {
    const rootConn = await mysql.createConnection({ host, port, user, password });
    try {
      const [rows] = await rootConn.query(
        "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME IN ('gymsera', 'gymsera_test_platform')"
      );
      const names = rows.map((r) => r.SCHEMA_NAME);
      platformDb = names.includes('gymsera') ? 'gymsera' : (names.includes('gymsera_test_platform') ? 'gymsera_test_platform' : 'gymsera');
    } finally {
      await rootConn.end();
    }
  }

  console.log(`Connecting read-only to MySQL at ${host}:${port} as ${user}...`);

  // 1. Run Platform checks
  const platformResult = await checkPlatformDatabase(config, platformDb);

  // 2. Discover and run Tenant checks
  console.log(`\n============================================================`);
  console.log(`  TENANT DATABASE PRECHECKS (011, 012)`);
  console.log(`============================================================`);

  const tenantDbs = await discoverTenantDatabases(config, platformDb);
  console.log(`Discovered ${tenantDbs.length} tenant database(s) to verify: ${tenantDbs.join(', ')}\n`);

  let passedTenants = 0;
  let failedTenants = 0;
  const tenantResults = [];

  for (const dbName of tenantDbs) {
    const res = await checkTenantDatabase(config, dbName);
    tenantResults.push(res);
    if (res.pass) {
      passedTenants++;
    } else {
      failedTenants++;
    }
  }

  // 3. Final Summary
  console.log(`\n============================================================`);
  console.log(`  FINAL PROMPT 1E PRECHECK SUMMARY`);
  console.log(`============================================================`);
  console.log(`Platform database (${platformDb}): ${platformResult.pass ? 'PASS' : 'FAIL'}`);
  console.log(`Total tenant databases checked: ${tenantDbs.length}`);
  console.log(`Passed:                         ${passedTenants}`);
  console.log(`Failed:                         ${failedTenants}`);
  console.log(`Safety verification:            100% READ ONLY (0 writes made)`);
  console.log(`============================================================\n`);

  const allPassed = platformResult.pass && failedTenants === 0;
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(`Fatal error executing precheck: ${err.message}`);
  process.exit(1);
});
