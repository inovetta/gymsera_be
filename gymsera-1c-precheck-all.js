#!/usr/bin/env node
/**
 * gymsera-1c-precheck-all.js
 *
 * READ-ONLY pre-migration baseline check script for Prompt 1C.
 * Runs prompt-1c-precheck.sql (commit 9d6db27) against the platform database
 * and every active tenant database.
 *
 * Safety Invariants:
 * 1. Read-Only: Immediately executes `SET SESSION TRANSACTION READ ONLY` on every
 *    database connection. MySQL strictly rejects any write/DDL statement with ERROR 1792.
 * 2. Zero mutations: Only read-only SELECT queries are executed; no data or schema is modified.
 * 3. Exact verification: Compares actual database state against the exact "safe to migrate"
 *    baseline defined in docs/sql/prompt-1c-precheck.sql header comment.
 *
 * Environment variables:
 *   CHK_HOST         Database host (default: 127.0.0.1)
 *   CHK_PORT         Database port (default: 3306, or auto-detected 3308 if available)
 *   CHK_USER         Database user (default: root)
 *   CHK_PASSWORD     Database password (default: empty string)
 *   CHK_PLATFORM_DB  Platform database name (default: gymsera, fallback gymsera_test_platform)
 *
 * Usage:
 *   node gymsera-1c-precheck-all.js
 *   CHK_HOST=127.0.0.1 CHK_PORT=3308 CHK_USER=root CHK_PASSWORD="" node gymsera-1c-precheck-all.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

// Pre-p007 allowed capacity_events actions
const PRE_P007_ACTIONS = new Set([
  'BRANCH_DELETED',
  'BRANCH_RESTORED',
  'SLOT_TRANSFERRED',
  'SLOT_TRIMMED_DOWNGRADE',
  'SLOT_ATTRIBUTED_UPGRADE',
  'SLOT_CONSUMED_BUILD',
  'ORG_DELETED',
  'ORG_BRANCHES_MOVED',
]);

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
 * Checks platform database against Section 1 of prompt-1c-precheck.sql.
 */
async function checkPlatformDatabase(config, platformDb) {
  console.log(`\n============================================================`);
  console.log(`  PLATFORM DATABASE PRECHECK: ${platformDb}`);
  console.log(`============================================================`);

  const failures = [];
  const conn = await createReadOnlyConnection(config, platformDb);

  try {
    // 0. MySQL version check (expect >= 5.7.8)
    const [verRows] = await conn.query('SELECT VERSION() AS mysql_version');
    const mysqlVer = verRows[0]?.mysql_version || 'unknown';
    if (!isVersionGte578(mysqlVer)) {
      failures.push(`MySQL version (${mysqlVer}) is lower than required 5.7.8`);
    }

    // 1. Platform schema_migrations (expect versions 1..6 applied, p007 / version 7 absent)
    let appliedVersions = [];
    try {
      const [migRows] = await conn.query('SELECT version FROM schema_migrations ORDER BY version');
      appliedVersions = migRows.map((r) => r.version);
    } catch (err) {
      failures.push(`Failed to read schema_migrations: ${err.message}`);
    }

    if (appliedVersions.includes(7)) {
      failures.push(`Platform migration p007 is already applied (found version 7 in schema_migrations)`);
    }
    const expectedPlatformVersions = [1, 2, 3, 4, 5, 6];
    const missingPlatformVersions = expectedPlatformVersions.filter((v) => !appliedVersions.includes(v));
    if (missingPlatformVersions.length > 0) {
      failures.push(
        `Platform migrations 1..6 expected, but missing versions: [${missingPlatformVersions.join(', ')}] (found: [${appliedVersions.join(', ')}])`
      );
    }

    // 2. Check 4: capacity_events.action column definition
    const [colRows] = await conn.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capacity_events' AND COLUMN_NAME = 'action'`
    );
    if (colRows.length === 0) {
      failures.push(`Table 'capacity_events' or column 'action' not found`);
    } else {
      const colType = colRows[0].COLUMN_TYPE || '';
      if (colType.includes('BRANCH_DELETED_PERMANENT')) {
        failures.push(`capacity_events.action ENUM already contains BRANCH_DELETED_PERMANENT: ${colType}`);
      }
    }

    // Action values in use in capacity_events
    try {
      const [actRows] = await conn.query('SELECT action, COUNT(*) AS n FROM capacity_events GROUP BY action ORDER BY action');
      const unknownActions = [];
      for (const row of actRows) {
        if (!PRE_P007_ACTIONS.has(row.action)) {
          unknownActions.push(`${row.action} (${row.n})`);
        }
      }
      if (unknownActions.length > 0) {
        failures.push(`Unknown action values in capacity_events: [${unknownActions.join(', ')}]`);
      }
    } catch (err) {
      failures.push(`Failed to query capacity_events action counts: ${err.message}`);
    }

    // Table size for capacity_events
    let capEventCount = 0;
    try {
      const [countRows] = await conn.query('SELECT COUNT(*) AS rows_in_capacity_events FROM capacity_events');
      capEventCount = countRows[0]?.rows_in_capacity_events ?? 0;
    } catch (err) {
      failures.push(`Failed to query capacity_events row count: ${err.message}`);
    }

    if (failures.length === 0) {
      console.log(`PLATFORM [${platformDb}]: PASS — MySQL ${mysqlVer}, schema_migrations 1..6 applied (p007 absent), pre-p007 ENUM intact, ${capEventCount} capacity_events rows.`);
      return { pass: true, failures: [] };
    } else {
      console.log(`PLATFORM [${platformDb}]: FAIL`);
      failures.forEach((f) => console.log(`  - ${f}`));
      return { pass: false, failures };
    }
  } finally {
    await conn.end();
  }
}

/**
 * Checks a single tenant database against Section 2 of prompt-1c-precheck.sql.
 */
async function checkTenantDatabase(config, dbName) {
  const failures = [];
  const conn = await createReadOnlyConnection(config, dbName);

  try {
    // 3. Tenant schema_migrations (expect versions 1..7 applied, 8..10 absent)
    let appliedVersions = [];
    try {
      const [migRows] = await conn.query('SELECT version FROM schema_migrations ORDER BY version');
      appliedVersions = migRows.map((r) => r.version);
    } catch (err) {
      failures.push(`Check 3: schema_migrations error: ${err.message}`);
    }

    const applied8to10 = appliedVersions.filter((v) => [8, 9, 10].includes(v));
    if (applied8to10.length > 0) {
      failures.push(`Check 3 (schema_migrations): Expected versions 8, 9, 10 absent, but found applied: [${applied8to10.join(', ')}]`);
    }
    if (!appliedVersions.includes(7)) {
      failures.push(`Check 3 (schema_migrations): Expected versions 1..7 applied, but version 7 is missing (applied: [${appliedVersions.join(', ')}])`);
    }

    // 4. Check 1: Tenant migration 008 columns on branches (expect 0 rows)
    const [c1Rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches'
         AND COLUMN_NAME IN ('admin_suspended', 'admin_suspended_reason', 'admin_suspended_at', 'admin_suspended_by')`
    );
    if (c1Rows.length > 0) {
      const foundCols = c1Rows.map((r) => r.COLUMN_NAME).join(', ');
      failures.push(`Check 1 (migration 008): Expected 0 rows, found existing column(s): ${foundCols}`);
    }

    // 5. Check 2: Tenant migration 009 capacity_outbox table (expect 0 rows)
    const [c2Rows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capacity_outbox'`
    );
    if (c2Rows.length > 0) {
      failures.push(`Check 2 (migration 009): Expected 0 rows, table 'capacity_outbox' already exists`);
    }

    // 6. Check 3: Tenant migration 010 billing_locked_at columns on branches (expect 0 rows)
    const [c3Rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches'
         AND COLUMN_NAME IN ('billing_locked_at', 'billing_lock_reason')`
    );
    if (c3Rows.length > 0) {
      const foundCols = c3Rows.map((r) => r.COLUMN_NAME).join(', ');
      failures.push(`Check 3 (migration 010): Expected 0 rows, found existing column(s): ${foundCols}`);
    }

    // 7. Check (c): Pre-existing column conflict check on branches (expect exactly 0)
    const [ccRows] = await conn.query(
      `SELECT COUNT(*) AS admin_suspended_column_exists
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches' AND COLUMN_NAME = 'admin_suspended'`
    );
    const colExistsCount = ccRows[0]?.admin_suspended_column_exists ?? 0;
    if (colExistsCount !== 0) {
      failures.push(`Check (c): Expected admin_suspended_column_exists = 0, but column already exists (admin_suspended_column_exists = ${colExistsCount})`);
    }

    // 8. Table size for branches (expect valid non-negative count)
    let branchCount = 0;
    try {
      const [brRows] = await conn.query('SELECT COUNT(*) AS rows_in_branches FROM branches');
      branchCount = brRows[0]?.rows_in_branches ?? 0;
    } catch (err) {
      failures.push(`Check 8: Failed to query rows_in_branches: ${err.message}`);
    }

    if (failures.length === 0) {
      console.log(`PASS: [${dbName}] — schema v${Math.max(...appliedVersions, 0)}, 0 unapplied columns/tables, ${branchCount} branches.`);
      return { dbName, pass: true, failures: [] };
    } else {
      console.log(`FAIL: [${dbName}]`);
      failures.forEach((f) => console.log(`  - ${f}`));
      return { dbName, pass: false, failures };
    }
  } catch (err) {
    const errorMsg = `Database connection/query error: ${err.message}`;
    console.log(`FAIL: [${dbName}] — ${errorMsg}`);
    return { dbName, pass: false, failures: [errorMsg] };
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
  console.log(`  TENANT DATABASE PRECHECKS (prompt-1c-precheck.sql Section 2)`);
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
  console.log(`  FINAL PRECHECK SUMMARY`);
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
