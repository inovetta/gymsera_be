#!/usr/bin/env node
/**
 * gymsera-flow02-provisioning-check.js
 *
 * READ-ONLY report of tenants that the old, non-resumable provisioning may have
 * left half-done or duplicated (spec §12.3 FLOW-02). Run it before deploying
 * Prompt 1G, so the owner can decide whether any data correction is needed.
 * It works both before and after platform migration p013.
 *
 * What the old code did (src/services/tenant-provisioning.service.js before FLOW-02):
 *   - everything ran in one request; a failure or timeout left the tenant APPROVED,
 *     sometimes with a database, listing, gym or branch already created;
 *   - two approvals at the same time both ran (no lock);
 *   - a failed GymListing insert was swallowed: the tenant became ACTIVE with no
 *     listing and a branch attached to none;
 *   - a failed plan insert (legacy package step) was swallowed: ACTIVE with no plan.
 *
 * Verdicts (a tenant can have several):
 *   STUCK_APPROVED_NO_DB    APPROVED, no tenant database: stopped at or before step 1.
 *   STUCK_APPROVED_PARTIAL  APPROVED, its database exists: stopped halfway.
 *                           After 1G the admin's Resume (re-approve) finishes both.
 *   ACTIVE_NO_CONNECTION    ACTIVE without a stored connection string.
 *   ACTIVE_NO_LISTING       ACTIVE with no GymListing.
 *   ACTIVE_NO_PLAN          ACTIVE with no tenant_subscriptions row at all.
 *   DUPLICATE_GYM           more than one row in the tenant DB `gyms` table.
 *   BRANCH_WITHOUT_LISTING  a tenant DB branch with no gym_listing_id.
 *   DUPLICATE_LISTING_AT_APPROVAL  two or more listings created within 5 minutes of
 *                           each other before any other (a double approval).
 *   UNREACHABLE_TENANT_DB   the tenant database could not be read (listed, not guessed).
 * And databases on the tenant server:
 *   ORPHAN_DATABASE         a `gymsera_*` database no tenant's code maps to, or whose
 *                           tenant is not APPROVED/ACTIVE/SUSPENDED (e.g. REJECTED).
 *
 * Safety:
 *   - Every connection runs `SET SESSION TRANSACTION READ ONLY` and works inside a
 *     READ ONLY transaction: MySQL rejects any write (ERROR 1792). There is no --apply.
 *   - Only SELECTs on the platform DB, information_schema, and each tenant DB's
 *     `gyms` / `branches` tables (counts only). No personal data is printed:
 *     tenant ids, codes, statuses, database names and counts.
 *
 * Environment variables:
 *   CHK_HOST / CHK_PORT  platform DB server (defaults 127.0.0.1 / 3306)
 *   CHK_USER / CHK_PASSWORD  required, no default user or password (an explicitly empty password is allowed)
 *   CHK_PLATFORM_DB     platform database name (default: gymsera)
 *   CHK_TENANT_HOST / CHK_TENANT_PORT / CHK_TENANT_USER / CHK_TENANT_PASSWORD
 *                       tenant DB server, if different (default: same as CHK_*). A SELECT-only user is enough.
 *
 * Exit codes: 0 = nothing found, 1 = findings listed for review, 2 = error.
 *
 * Usage:
 *   CHK_HOST=<host> CHK_USER=<user> CHK_PASSWORD='<password>' CHK_PLATFORM_DB=gymsera \
 *     node gymsera-flow02-provisioning-check.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const SAFE_DB_NAME = /^[A-Za-z0-9_$-]+$/;
const q = (name) => {
  if (!SAFE_DB_NAME.test(name)) throw new Error(`Refusing unexpected database name: ${name}`);
  return `\`${name}\``;
};

/** Same rule as tenant-provisioning.service.js#buildDbName. */
const dbNameFor = (tenantCode) => `gymsera_${String(tenantCode).toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;

const LIVE_STATUSES = new Set(['APPROVED', 'ACTIVE', 'SUSPENDED']);
const DOUBLE_APPROVAL_WINDOW_MS = 5 * 60 * 1000;

/**
 * Pure classification.
 * @param {object} data
 *   tenants:   [{ id, tenant_code, status, db_name, has_connection, provisioning_state? }]
 *   listings:  [{ tenant_id, created_at }]
 *   planCounts: { [tenantId]: n }
 *   databases: string[]                          gymsera_* databases on the tenant server
 *   tenantDbs: { [dbName]: { gyms, branchesWithoutListing } | { error } }
 *   platformDb: string
 */
function classify({ tenants, listings, planCounts, databases, tenantDbs, platformDb }) {
  const dbSet = new Set(databases);
  const listingsByTenant = {};
  for (const l of listings) (listingsByTenant[l.tenant_id] = listingsByTenant[l.tenant_id] || []).push(l);

  const findings = [];
  const expectedDbs = new Map();
  for (const t of tenants) {
    const dbName = t.db_name || dbNameFor(t.tenant_code);
    expectedDbs.set(dbName, t);
    const verdicts = [];
    const exists = dbSet.has(dbName);
    const tl = (listingsByTenant[t.id] || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (t.status === 'APPROVED') verdicts.push(exists ? 'STUCK_APPROVED_PARTIAL' : 'STUCK_APPROVED_NO_DB');
    if (t.status === 'ACTIVE') {
      if (!t.has_connection) verdicts.push('ACTIVE_NO_CONNECTION');
      if (tl.length === 0) verdicts.push('ACTIVE_NO_LISTING');
      if (!planCounts[t.id]) verdicts.push('ACTIVE_NO_PLAN');
    }
    if (tl.length >= 2 && new Date(tl[1].created_at) - new Date(tl[0].created_at) <= DOUBLE_APPROVAL_WINDOW_MS) {
      verdicts.push('DUPLICATE_LISTING_AT_APPROVAL');
    }
    const info = exists ? tenantDbs[dbName] : undefined;
    if (info?.error) verdicts.push('UNREACHABLE_TENANT_DB');
    else if (info) {
      if (info.gyms > 1) verdicts.push('DUPLICATE_GYM');
      if (info.branchesWithoutListing > 0) verdicts.push('BRANCH_WITHOUT_LISTING');
    }
    if (verdicts.length) {
      findings.push({
        kind: 'TENANT',
        id: t.id,
        tenantCode: t.tenant_code,
        status: t.status,
        provisioningState: t.provisioning_state ?? null,
        dbName,
        dbExists: exists,
        listings: tl.length,
        plans: planCounts[t.id] || 0,
        gyms: info && !info.error ? info.gyms : null,
        branchesWithoutListing: info && !info.error ? info.branchesWithoutListing : null,
        error: info?.error || null,
        verdicts,
      });
    }
  }

  for (const db of databases) {
    if (db === platformDb) continue;
    const t = expectedDbs.get(db);
    if (!t || !LIVE_STATUSES.has(t.status)) {
      findings.push({ kind: 'DATABASE', dbName: db, tenantId: t?.id || null, tenantStatus: t?.status || null, verdicts: ['ORPHAN_DATABASE'] });
    }
  }
  return findings;
}

const readOnly = async (conn) => {
  await conn.query('SET SESSION TRANSACTION READ ONLY');
  await conn.query('START TRANSACTION READ ONLY');
};

async function main() {
  const platformDb = process.env.CHK_PLATFORM_DB || 'gymsera';
  if (!process.env.CHK_USER || process.env.CHK_PASSWORD === undefined) {
    throw new Error('Set CHK_USER and CHK_PASSWORD (there is no default user or password).');
  }
  const platformCfg = {
    host: process.env.CHK_HOST || '127.0.0.1',
    port: parseInt(process.env.CHK_PORT || '3306', 10),
    user: process.env.CHK_USER,
    password: process.env.CHK_PASSWORD,
    dateStrings: true,
  };
  const tenantCfg = {
    host: process.env.CHK_TENANT_HOST || platformCfg.host,
    port: parseInt(process.env.CHK_TENANT_PORT || String(platformCfg.port), 10),
    user: process.env.CHK_TENANT_USER || platformCfg.user,
    password: process.env.CHK_TENANT_PASSWORD ?? platformCfg.password,
    dateStrings: true,
  };

  const pconn = await mysql.createConnection(platformCfg);
  let tenants, listings, plans, hasState;
  try {
    await readOnly(pconn);
    const [cols] = await pconn.query(
      "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'provisioning_state'",
      [platformDb]
    );
    hasState = cols.length === 1;
    [tenants] = await pconn.query(
      `SELECT id, tenant_code, status, db_name, (connection_string_encrypted IS NOT NULL AND connection_string_encrypted <> 'PENDING_PROVISIONING') AS has_connection` +
        `${hasState ? ', provisioning_state' : ''} FROM ${q(platformDb)}.tenants ORDER BY created_at, id`
    );
    [listings] = await pconn.query(`SELECT tenant_id, created_at FROM ${q(platformDb)}.gym_listings`);
    [plans] = await pconn.query(`SELECT tenant_id, COUNT(*) AS n FROM ${q(platformDb)}.tenant_subscriptions GROUP BY tenant_id`);
    await pconn.query('ROLLBACK');
  } finally {
    await pconn.end().catch(() => {});
  }
  const planCounts = Object.fromEntries(plans.map((p) => [p.tenant_id, Number(p.n)]));
  tenants = tenants.map((t) => ({ ...t, has_connection: Boolean(Number(t.has_connection)) }));

  const tconn = await mysql.createConnection(tenantCfg);
  const tenantDbs = {};
  let databases;
  try {
    await readOnly(tconn);
    const [schemas] = await tconn.query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'gymsera\\_%'");
    databases = schemas.map((s) => s.name);
    const [tables] = await tconn.query(
      "SELECT TABLE_SCHEMA AS db, TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA LIKE 'gymsera\\_%' AND TABLE_NAME IN ('gyms','branches')"
    );
    const has = new Set(tables.map((r) => `${r.db}.${r.t}`));
    for (const db of databases) {
      if (db === platformDb) continue;
      try {
        const gyms = has.has(`${db}.gyms`) ? Number((await tconn.query(`SELECT COUNT(*) AS n FROM ${q(db)}.gyms`))[0][0].n) : 0;
        const branchesWithoutListing = has.has(`${db}.branches`)
          ? Number((await tconn.query(`SELECT COUNT(*) AS n FROM ${q(db)}.branches WHERE gym_listing_id IS NULL`))[0][0].n)
          : 0;
        tenantDbs[db] = { gyms, branchesWithoutListing };
      } catch (err) {
        tenantDbs[db] = { error: err.code || 'ERROR' };
      }
    }
    await tconn.query('ROLLBACK');
  } finally {
    await tconn.end().catch(() => {});
  }

  const findings = classify({ tenants, listings, planCounts, databases, tenantDbs, platformDb });
  const counts = {};
  for (const f of findings) for (const v of f.verdicts) counts[v] = (counts[v] || 0) + 1;

  console.log('FLOW-02 provisioning check (read-only)');
  console.log(`Platform DB: ${platformDb}   tenants: ${tenants.length}   tenant databases: ${databases.length}   p013 applied: ${hasState ? 'yes' : 'no'}`);
  if (findings.length === 0) {
    console.log('Nothing found.');
    return 0;
  }
  console.log(`Findings: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('   ')}\n`);
  for (const f of findings) {
    if (f.kind === 'TENANT') {
      console.log(
        `  tenant=${f.id} code=${f.tenantCode} status=${f.status} state=${f.provisioningState ?? '-'} db=${f.dbName} dbExists=${f.dbExists} ` +
          `listings=${f.listings} plans=${f.plans} gyms=${f.gyms ?? '-'} branchesWithoutListing=${f.branchesWithoutListing ?? '-'}` +
          `${f.error ? ` error=${f.error}` : ''}  → ${f.verdicts.join(', ')}`
      );
    } else {
      console.log(`  database=${f.dbName} tenant=${f.tenantId ?? '-'} tenantStatus=${f.tenantStatus ?? '-'}  → ${f.verdicts.join(', ')}`);
    }
  }
  console.log('\nNothing was changed. Resume (re-approve) finishes STUCK_* tenants after Prompt 1G; anything else is a data correction for the owner to decide.');
  return 1;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Check failed:', err.code || err.message);
      process.exit(2);
    });
}

module.exports = { classify, dbNameFor };
