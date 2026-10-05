#!/usr/bin/env node
/**
 * gymsera-rbac09-stale-branch-assignments-check.js
 *
 * READ-ONLY audit of stale ACTIVE branch-scoped role assignments whose branch
 * is inactive or missing, across all tenant databases.
 *
 * What RBAC-09 addressed:
 *   When a branch is deleted or deactivated (gym.service.js:deleteBranch), any
 *   branch-scoped role assignments (RoleAssignment + RoleAssignmentBranch)
 *   must have that branch link revoked. If no active branches remain for the
 *   assignment, the RoleAssignment status must become REVOKED and the user's
 *   permissionVersion bumped.
 *
 * Prior to RBAC-09:
 *   deleteBranch only updated GymStaff to TERMINATED. Existing branch-scoped
 *   RoleAssignment and RoleAssignmentBranch rows remained ACTIVE indefinitely,
 *   leaving orphaned or dangling grants across tenant databases.
 *
 * This script identifies:
 *   1. ORPHAN_NO_BRANCH_LINKS:
 *      ra.status = 'ACTIVE' and ra.scope_type = 'BRANCH', but 0 rows exist in
 *      role_assignment_branches. (Stale assignment with no branch targets).
 *   2. DANGLING_BRANCH_LINK:
 *      rab.branch_id points to a branch ID that no longer exists in branches.
 *   3. INACTIVE_OR_DELETED_BRANCH:
 *      rab.branch_id points to a branch whose status is NOT 'ACTIVE' (e.g. INACTIVE,
 *      DELETED, TERMINATED).
 *
 * Verdicts per assignment:
 *   - STALE_ASSIGNMENT_NEEDS_REVOCATION:
 *     The assignment has NO remaining active branch links. The whole assignment
 *     should be REVOKED and permissionVersion bumped.
 *   - STALE_BRANCH_LINK_NEEDS_PRUNING:
 *     The assignment still has at least one other active branch, but contains
 *     stale links to deleted/inactive branches that should be removed.
 *
 * Safety:
 *   - Connects in READ ONLY mode (SET SESSION TRANSACTION READ ONLY).
 *   - Issues SELECT queries only. Zero writes or DDL.
 *   - Accepts connection parameters via environment variables.
 *   - DO NOT run on production without proper authorization.
 *
 * Environment variables:
 *   CHK_HOST                    Database host (default: 127.0.0.1)
 *   CHK_PORT                    Database port (default: 3306)
 *   CHK_USER                    Database user (default: root)
 *   CHK_PASSWORD                Database password (default: empty string)
 *   CHK_PLATFORM_DB             Platform database name (default: gymsera)
 *   TENANT_CONN_ENCRYPTION_KEY  (optional) Used to decrypt tenant connection strings.
 *   CHK_TENANTS                 (optional) Comma-separated tenant DB names to scan.
 *
 * Exit codes:
 *   0 = Clean (no stale branch role assignments found)
 *   1 = Stale branch assignments or links detected
 *   2 = Connection or configuration error
 */

'use strict';

const mysql = require('mysql2/promise');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const CHK_HOST = process.env.CHK_HOST || process.env.PLATFORM_DB_HOST || '127.0.0.1';
const CHK_PORT = parseInt(process.env.CHK_PORT || process.env.PLATFORM_DB_PORT || '3306', 10);
const CHK_USER = process.env.CHK_USER || process.env.PLATFORM_DB_USER || 'root';
const CHK_PASSWORD =
  process.env.CHK_PASSWORD !== undefined
    ? process.env.CHK_PASSWORD
    : process.env.PLATFORM_DB_PASS || '';
const CHK_PLATFORM_DB = process.env.CHK_PLATFORM_DB || process.env.PLATFORM_DB_NAME || 'gymsera';
const CHK_TENANTS = process.env.CHK_TENANTS
  ? process.env.CHK_TENANTS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

async function openReadOnly(config) {
  const conn = await mysql.createConnection({ ...config, dateStrings: true });
  await conn.query('SET SESSION TRANSACTION READ ONLY');
  await conn.query('START TRANSACTION READ ONLY');
  return conn;
}

async function tableExists(conn, db, table) {
  const [rows] = await conn.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1',
    [db, table]
  );
  return rows.length > 0;
}

async function discoverTenantDatabases(conn, platformDb) {
  const byDb = new Map();
  const warnings = [];

  let tenants = [];
  if (await tableExists(conn, platformDb, 'tenants')) {
    const [rows] = await conn.query(
      `SELECT id, business_name, status, connection_string_encrypted FROM \`${platformDb}\`.tenants`
    );
    tenants = rows;
  }

  let decrypt = null;
  try {
    ({ decrypt } = require('./src/utils/crypto.utils'));
  } catch (_) {
    // helper unavailable; fallback to schema scan
  }

  let decryptFailures = 0;
  if (decrypt && tenants.length > 0) {
    for (const t of tenants) {
      const enc = t.connection_string_encrypted;
      if (!enc || enc === 'PENDING_PROVISIONING') continue;
      try {
        const dbName = new URL(decrypt(enc)).pathname.replace(/^\//, '');
        if (dbName) byDb.set(dbName, t);
      } catch (_) {
        decryptFailures++;
      }
    }
  }

  if (decryptFailures > 0) {
    warnings.push(
      `${decryptFailures} tenant connection string(s) could not be decrypted. Set TENANT_CONN_ENCRYPTION_KEY if available.`
    );
  }

  if (byDb.size === 0) {
    const [schemas] = await conn.query(
      "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'gymsera\\_%' ORDER BY SCHEMA_NAME"
    );
    for (const s of schemas) {
      if (s.name !== platformDb && !s.name.endsWith('_platform')) {
        byDb.set(s.name, null);
      }
    }
  }

  // Filter against schemas existing on this MySQL instance
  const [existing] = await conn.query('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA');
  const serverSchemas = new Set(existing.map((s) => s.name));
  const validDbs = [];

  for (const [dbName, tenant] of byDb.entries()) {
    if (serverSchemas.has(dbName)) {
      if (!CHK_TENANTS || CHK_TENANTS.includes(dbName)) {
        validDbs.push({ dbName, tenant });
      }
    }
  }

  return { validDbs, warnings };
}

async function auditTenantDatabase(conn, dbName, tenant) {
  const issues = [];

  const hasRoleAssignments = await tableExists(conn, dbName, 'role_assignments');
  const hasBranches = await tableExists(conn, dbName, 'branches');
  const hasJunction = await tableExists(conn, dbName, 'role_assignment_branches');

  if (!hasRoleAssignments || !hasBranches || !hasJunction) {
    return {
      dbName,
      tenantId: tenant ? tenant.id : null,
      tenantName: tenant ? (tenant.business_name || tenant.name) : null,
      skipped: true,
      reason: 'Missing RBAC or branch tables',
      issues: [],
    };
  }

  // 1. Fetch all ACTIVE branch-scoped assignments with their branch links and branch statuses
  const [rows] = await conn.query(`
    SELECT
      ra.id AS assignment_id,
      ra.user_id,
      ra.email,
      ra.role_key,
      ra.role_level,
      ra.scope_type,
      ra.status AS assignment_status,
      rab.branch_id AS linked_branch_id,
      b.id AS branch_actual_id,
      b.branch_name,
      b.status AS branch_status
    FROM \`${dbName}\`.role_assignments ra
    LEFT JOIN \`${dbName}\`.role_assignment_branches rab ON rab.assignment_id = ra.id
    LEFT JOIN \`${dbName}\`.branches b ON b.id = rab.branch_id
    WHERE ra.status = 'ACTIVE'
      AND ra.scope_type = 'BRANCH'
    ORDER BY ra.id, rab.branch_id
  `);

  // Group by assignment_id
  const assignments = new Map();
  for (const r of rows) {
    if (!assignments.has(r.assignment_id)) {
      assignments.set(r.assignment_id, {
        assignmentId: r.assignment_id,
        userId: r.user_id,
        email: r.email,
        roleKey: r.role_key,
        roleLevel: r.role_level,
        scopeType: r.scope_type,
        status: r.assignment_status,
        links: [],
      });
    }
    if (r.linked_branch_id) {
      assignments.get(r.assignment_id).links.push({
        branchId: r.linked_branch_id,
        branchExists: !!r.branch_actual_id,
        branchName: r.branch_name || null,
        branchStatus: r.branch_status || null,
        isActiveBranch: r.branch_actual_id && r.branch_status === 'ACTIVE',
      });
    }
  }

  // Evaluate each assignment
  for (const asg of assignments.values()) {
    const totalLinks = asg.links.length;
    const activeLinks = asg.links.filter((l) => l.isActiveBranch);
    const staleLinks = asg.links.filter((l) => !l.isActiveBranch);

    if (totalLinks === 0) {
      issues.push({
        assignmentId: asg.assignmentId,
        userId: asg.userId,
        email: asg.email,
        roleKey: asg.roleKey,
        defectType: 'ORPHAN_NO_BRANCH_LINKS',
        verdict: 'STALE_ASSIGNMENT_NEEDS_REVOCATION',
        detail: 'Assignment is ACTIVE with scopeType BRANCH, but has 0 branch links.',
        staleBranchCount: 0,
        activeBranchCount: 0,
      });
    } else if (staleLinks.length > 0) {
      const isCompleteOrphan = activeLinks.length === 0;
      for (const link of staleLinks) {
        const defect = !link.branchExists
          ? 'DANGLING_BRANCH_LINK'
          : `INACTIVE_BRANCH_${link.branchStatus || 'UNKNOWN'}`;

        issues.push({
          assignmentId: asg.assignmentId,
          userId: asg.userId,
          email: asg.email,
          roleKey: asg.roleKey,
          branchId: link.branchId,
          branchName: link.branchName,
          defectType: defect,
          verdict: isCompleteOrphan
            ? 'STALE_ASSIGNMENT_NEEDS_REVOCATION'
            : 'STALE_BRANCH_LINK_NEEDS_PRUNING',
          detail: !link.branchExists
            ? `Branch ID ${link.branchId} does not exist in branches table.`
            : `Branch '${link.branchName || link.branchId}' has status '${link.branchStatus}'.`,
          staleBranchCount: staleLinks.length,
          activeBranchCount: activeLinks.length,
        });
      }
    }
  }

  return {
    dbName,
    tenantId: tenant ? tenant.id : null,
    tenantName: tenant ? (tenant.business_name || tenant.name) : null,
    totalScanned: assignments.size,
    issues,
  };
}

async function main() {
  console.log('========================================================================');
  console.log('GymsEra — Stale Branch Role Assignments Audit (RBAC-09 Read-Only Check)');
  console.log('========================================================================\n');
  console.log(`Connecting to MySQL host: ${CHK_HOST}:${CHK_PORT} (user: ${CHK_USER})`);
  console.log(`Platform DB: ${CHK_PLATFORM_DB}`);
  console.log('Mode: READ ONLY (Zero data or schema mutations will occur)\n');

  let conn = null;
  try {
    conn = await openReadOnly({
      host: CHK_HOST,
      port: CHK_PORT,
      user: CHK_USER,
      password: CHK_PASSWORD,
      database: CHK_PLATFORM_DB,
    });
  } catch (err) {
    console.error(`ERROR: Failed to connect to MySQL database: ${err.message}`);
    process.exit(2);
  }

  try {
    const { validDbs, warnings } = await discoverTenantDatabases(conn, CHK_PLATFORM_DB);
    for (const w of warnings) {
      console.warn(`[WARNING] ${w}`);
    }

    console.log(`Discovered ${validDbs.length} tenant database(s) to scan.\n`);

    let totalAssignmentsScanned = 0;
    let totalIssuesFound = 0;
    const summary = [];

    for (const { dbName, tenant } of validDbs) {
      const result = await auditTenantDatabase(conn, dbName, tenant);
      if (result.skipped) {
        console.log(`[SKIP] ${dbName}: ${result.reason}`);
        continue;
      }

      totalAssignmentsScanned += result.totalScanned;
      if (result.issues.length > 0) {
        totalIssuesFound += result.issues.length;
        summary.push(result);
      }
    }

    console.log('\n------------------------------------------------------------------------');
    console.log('AUDIT RESULTS');
    console.log('------------------------------------------------------------------------');
    console.log(`Tenant databases scanned:          ${validDbs.length}`);
    console.log(`Total branch assignments checked:  ${totalAssignmentsScanned}`);
    console.log(`Stale assignments / links found:   ${totalIssuesFound}\n`);

    if (summary.length === 0) {
      console.log('SUCCESS: All ACTIVE branch-scoped role assignments have valid, active branch links.');
      console.log('No orphan or dangling branch role assignments detected.\n');
      process.exit(0);
    }

    console.log('STALE ASSIGNMENTS BREAKDOWN:\n');
    for (const item of summary) {
      console.log(`Database: ${item.dbName} (Tenant: ${item.tenantName || 'Unknown'} / ${item.tenantId || 'N/A'})`);
      for (const issue of item.issues) {
        console.log(
          `  - Assignment ID: ${issue.assignmentId} | User ID: ${issue.userId || 'N/A'} | Role: ${issue.roleKey}`
        );
        console.log(`    Defect:  ${issue.defectType}`);
        console.log(`    Verdict: ${issue.verdict}`);
        console.log(`    Details: ${issue.detail}`);
        console.log(
          `    Context: ${issue.activeBranchCount} active branch(es) remain, ${issue.staleBranchCount} stale link(s).`
        );
      }
      console.log('');
    }

    console.log('Recommended Remediation:');
    console.log('1. For STALE_ASSIGNMENT_NEEDS_REVOCATION: Update status to REVOKED and bump user permissionVersion.');
    console.log('2. For STALE_BRANCH_LINK_NEEDS_PRUNING: Delete stale role_assignment_branches row and bump permissionVersion.');
    console.log('3. Use the RBAC-09 branch deletion cascade logic to keep data synchronized.\n');

    process.exit(1);
  } catch (err) {
    console.error(`ERROR: Audit interrupted: ${err.message}`);
    process.exit(2);
  } finally {
    if (conn) {
      await conn.rollback().catch(() => {});
      await conn.end().catch(() => {});
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  openReadOnly,
  auditTenantDatabase,
  discoverTenantDatabases,
};
