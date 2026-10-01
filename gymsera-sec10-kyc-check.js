#!/usr/bin/env node
/**
 * gymsera-sec10-kyc-check.js
 *
 * READ-ONLY audit report of tenant KYC documents and retention status (SEC-10, R-16, R-27).
 *
 * Checks:
 *   1. Storage exposure: detects KYC documents stored as raw public URLs (/uploads/ or public CDN)
 *      vs secure private storage keys.
 *   2. Retention policy (R-16): detects tenants rejected or deleted more than 90 days ago whose
 *      KYC documents have not yet been purged.
 *
 * Safety:
 *   - Runs under SET SESSION TRANSACTION READ ONLY.
 *   - Only SELECT queries on the platform `tenants` table.
 *   - Zero writes. There is no --apply flag.
 *
 * Environment variables:
 *   CHK_HOST          Database host (default: 127.0.0.1)
 *   CHK_PORT          Database port (default: 3306)
 *   CHK_USER          Database user (default: root)
 *   CHK_PASSWORD      Database password (default: empty string)
 *   CHK_PLATFORM_DB   Platform database name (default: gymsera)
 *
 * Exit codes:
 *   0 = Clean (no exposed public URLs and zero retention overdue violations)
 *   1 = Findings require attention (legacy public URLs or overdue retention documents exist)
 *   2 = Connection / execution error
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const SAFE_DB_NAME = /^[A-Za-z0-9_$-]+$/;
const q = (name) => {
  if (!SAFE_DB_NAME.test(name)) throw new Error(`Refusing unexpected database name: ${name}`);
  return `\`${name}\``;
};

async function main() {
  const host = process.env.CHK_HOST || process.env.PLATFORM_DB_HOST || '127.0.0.1';
  const port = Number(process.env.CHK_PORT || process.env.PLATFORM_DB_PORT || 3306);
  const user = process.env.CHK_USER || process.env.PLATFORM_DB_USER || 'root';
  const password = process.env.CHK_PASSWORD !== undefined ? process.env.CHK_PASSWORD : (process.env.PLATFORM_DB_PASS || '');
  const platformDb = process.env.CHK_PLATFORM_DB || process.env.PLATFORM_DB_NAME || 'gymsera';

  console.log('================================================================');
  console.log('       GYMSERA SEC-10 KYC DATA & RETENTION READ-ONLY AUDIT      ');
  console.log('================================================================');
  console.log(`Connecting to ${user}@${host}:${port}/${platformDb} (READ ONLY)...\n`);

  let conn;
  try {
    conn = await mysql.createConnection({ host, port, user, password });
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query(`USE ${q(platformDb)}`);
  } catch (err) {
    console.error(`ERROR: Failed to connect to MySQL: ${err.message}`);
    process.exit(2);
  }

  try {
    const [rows] = await conn.query(
      `SELECT id, tenant_code, business_name, email, status, kyc_status, 
              kyc_documents_json, rejected_at, created_at, updated_at
       FROM \`tenants\`
       ORDER BY created_at ASC`
    );

    const now = Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

    let totalTenants = rows.length;
    let tenantsWithKyc = 0;
    let exposedPublicCount = 0;
    let securePrivateCount = 0;
    let overdueRetentionCount = 0;
    let compliantPurgedCount = 0;

    const findings = [];

    for (const r of rows) {
      let docs = [];
      if (r.kyc_documents_json) {
        if (typeof r.kyc_documents_json === 'string') {
          try {
            docs = JSON.parse(r.kyc_documents_json);
          } catch (_) {
            docs = [r.kyc_documents_json];
          }
        } else if (Array.isArray(r.kyc_documents_json)) {
          docs = r.kyc_documents_json;
        }
      }

      const hasDocs = Array.isArray(docs) && docs.length > 0;
      if (hasDocs) tenantsWithKyc++;

      let tenantExposed = 0;
      let tenantSecure = 0;

      if (hasDocs) {
        for (const d of docs) {
          if (typeof d === 'string') {
            tenantExposed++;
            exposedPublicCount++;
          } else if (d && typeof d === 'object') {
            if (d.isLegacyUrl || (d.url && !d.key)) {
              tenantExposed++;
              exposedPublicCount++;
            } else if (d.key && d.key.startsWith('tenants/')) {
              tenantSecure++;
              securePrivateCount++;
            } else {
              tenantExposed++;
              exposedPublicCount++;
            }
          }
        }
      }

      // Check retention status
      const isRejected = r.status === 'REJECTED' || r.kyc_status === 'REJECTED';
      const isInactive = r.status === 'INACTIVE';
      const refDate = r.rejected_at ? new Date(r.rejected_at).getTime() : new Date(r.updated_at || r.created_at).getTime();
      const ageMs = now - refDate;
      const isOver90Days = ageMs > ninetyDaysMs;

      if ((isRejected || isInactive) && isOver90Days) {
        if (hasDocs) {
          overdueRetentionCount++;
          findings.push({
            tenantCode: r.tenant_code || r.id,
            businessName: r.business_name,
            status: r.status,
            kycStatus: r.kyc_status,
            rejectedAt: r.rejected_at,
            daysSinceRejection: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
            docCount: docs.length,
            issue: 'OVERDUE_RETENTION_PURGE_REQUIRED',
          });
        } else {
          compliantPurgedCount++;
        }
      } else if (tenantExposed > 0) {
        findings.push({
          tenantCode: r.tenant_code || r.id,
          businessName: r.business_name,
          status: r.status,
          kycStatus: r.kyc_status,
          rejectedAt: r.rejected_at,
          daysSinceRejection: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
          docCount: docs.length,
          issue: `EXPOSED_LEGACY_PUBLIC_URLS (${tenantExposed} docs)`,
        });
      }
    }

    console.log('----------------------------------------------------------------');
    console.log('AUDIT SUMMARY:');
    console.log(`  Total tenants evaluated:             ${totalTenants}`);
    console.log(`  Tenants with KYC documents:          ${tenantsWithKyc}`);
    console.log(`  Secure private documents (R-27):     ${securePrivateCount}`);
    console.log(`  Exposed public legacy URLs:          ${exposedPublicCount}`);
    console.log(`  Tenants overdue for retention purge: ${overdueRetentionCount}`);
    console.log(`  Compliant purged rejected tenants:   ${compliantPurgedCount}`);
    console.log('----------------------------------------------------------------\n');

    if (findings.length > 0) {
      console.log('TENANTS REQUIRING ATTENTION:');
      for (const f of findings) {
        console.log(`  - [${f.tenantCode}] "${f.businessName}" (${f.status}/${f.kycStatus}): ${f.issue} (Docs: ${f.docCount})`);
      }
      console.log('\nRECOMMENDED ACTIONS:');
      if (overdueRetentionCount > 0) {
        console.log('  1. Run `node src/scripts/run-kyc-retention-sweep.js` to purge documents older than 90 days (R-16).');
      }
      if (exposedPublicCount > 0) {
        console.log('  2. Review tenants with legacy public URLs to migrate files to private storage if required.');
      }
      console.log('================================================================\n');
      process.exit(1);
    } else {
      console.log('VERDICT: ALL CLEAN. No retention violations or exposed documents found.');
      console.log('================================================================\n');
      process.exit(0);
    }
  } catch (err) {
    console.error('Audit execution failed:', err);
    process.exit(2);
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

main();
