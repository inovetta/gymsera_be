#!/usr/bin/env node
/**
 * gymsera-auth07-deletion-check.js
 *
 * READ-ONLY report of data the OLD account "deletion" and the NEW-34 gap may already
 * have left behind (spec §12.1 AUTH-07, §12.13.11 NEW-34). Run it BEFORE deploying
 * Prompt 1I, so the owner can decide whether any data correction is needed.
 * It works both before and after platform migrations p014/p015.
 *
 * What the old code did: `POST /me/request-deletion` only set `users.status = INACTIVE`.
 * Nothing was deleted, the tenant kept running, and signing in with Google/Apple set the
 * account straight back to ACTIVE. So today:
 *
 * Verdicts:
 *   LEGACY_DELETION_REQUEST        a VERIFIED user still INACTIVE. A user is only INACTIVE before
 *                                  verifying their e-mail, or after the old deletion request, so a verified
 *                                  INACTIVE user asked for deletion and nothing was done (the privacy page
 *                                  promised it). `ownsTenant` says whether they own a gym.
 *   LEGACY_DELETION_LIVE_TENANT    such a user owns a tenant that is still APPROVED / ACTIVE / SUSPENDED.
 *   REJECTED_TENANT_DATABASE       a REJECTED tenant whose database still exists (NEW-34 orphans);
 *                                  `eligibleToDrop` = rejected more than 90 days ago (the manual drop
 *                                  script would still refuse one with payment rows).
 *   DELETION_DUE                   (after p014/p015) PENDING_DELETION past its 30 days: run the sweep.
 *   DELETION_STATE_MISMATCH        (after p014/p015) a user PENDING_DELETION whose owned tenant is not
 *                                  PENDING_DELETION/DELETED, or the reverse.
 *   DELETED_ROW_NOT_ANONYMIZED     (after p014) a DELETED user that still has a real e-mail, name or phone.
 *
 * Safety:
 *   - Every connection runs `SET SESSION TRANSACTION READ ONLY` and works inside a READ ONLY
 *     transaction: MySQL rejects any write (ERROR 1792). There is no --apply.
 *   - Only SELECTs on the platform DB and information_schema. NO personal data is printed: ids,
 *     statuses, ages in days and database names only (never names, e-mails or phones).
 *
 * Environment variables (same as the other check scripts):
 *   CHK_HOST / CHK_PORT, CHK_USER / CHK_PASSWORD (required, no default), CHK_PLATFORM_DB (default gymsera),
 *   CHK_TENANT_HOST / CHK_TENANT_PORT / CHK_TENANT_USER / CHK_TENANT_PASSWORD (tenant server, default: same).
 *
 * Exit codes: 0 = nothing found, 1 = findings listed for review, 2 = error.
 *
 * Usage:
 *   CHK_HOST=<host> CHK_USER=<user> CHK_PASSWORD='<password>' CHK_PLATFORM_DB=gymsera \
 *     node gymsera-auth07-deletion-check.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const SAFE_DB_NAME = /^[A-Za-z0-9_$-]+$/;
const q = (name) => {
  if (!SAFE_DB_NAME.test(name)) throw new Error(`Refusing unexpected database name: ${name}`);
  return `\`${name}\``;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_TENANT = new Set(['APPROVED', 'ACTIVE', 'SUSPENDED']);
const FINISHED_TENANT = new Set(['PENDING_DELETION', 'DELETED']);

/** Same rule as tenant-provisioning.service.js#buildDbName. */
const dbNameFor = (tenantCode) => `gymsera_${String(tenantCode).toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;

/**
 * Pure classification.
 * @param {object} data
 *   users:     [{ id, status, is_verified, deletion_scheduled_for?, deleted_at?, anonymized? }]
 *   tenants:   [{ id, tenant_code, status, db_name, owner_user_id, rejected_at?, updated_at, deletion_scheduled_for? }]
 *   databases: string[]        gymsera_* databases on the tenant server
 *   now:       Date
 */
function classify({ users, tenants, databases, now = new Date() }) {
  const dbSet = new Set(databases);
  const tenantsByOwner = {};
  for (const t of tenants) (tenantsByOwner[t.owner_user_id] = tenantsByOwner[t.owner_user_id] || []).push(t);
  const userById = new Map(users.map((u) => [u.id, u]));
  const findings = [];
  const add = (f) => findings.push(f);
  const daysSince = (d) => Math.floor((now - new Date(d)) / DAY_MS);

  for (const u of users) {
    const owned = tenantsByOwner[u.id] || [];
    if (u.status === 'INACTIVE' && Number(u.is_verified) === 1) {
      const verdicts = ['LEGACY_DELETION_REQUEST'];
      if (owned.some((t) => LIVE_TENANT.has(t.status))) verdicts.push('LEGACY_DELETION_LIVE_TENANT');
      add({ kind: 'USER', id: u.id, status: u.status, ownsTenant: owned.length > 0, liveTenants: owned.filter((t) => LIVE_TENANT.has(t.status)).length, verdicts });
    }
    if (u.status === 'PENDING_DELETION') {
      const verdicts = [];
      if (u.deletion_scheduled_for && new Date(u.deletion_scheduled_for) <= now) verdicts.push('DELETION_DUE');
      if (owned.some((t) => !FINISHED_TENANT.has(t.status) && t.status !== 'REJECTED')) verdicts.push('DELETION_STATE_MISMATCH');
      if (verdicts.length) add({ kind: 'USER', id: u.id, status: u.status, scheduledFor: u.deletion_scheduled_for || null, verdicts });
    }
    if (u.status === 'DELETED' && Number(u.anonymized) === 0) {
      add({ kind: 'USER', id: u.id, status: u.status, verdicts: ['DELETED_ROW_NOT_ANONYMIZED'] });
    }
  }

  for (const t of tenants) {
    const dbName = t.db_name || dbNameFor(t.tenant_code);
    const verdicts = [];
    if (t.status === 'REJECTED' && dbSet.has(dbName)) verdicts.push('REJECTED_TENANT_DATABASE');
    if (t.status === 'PENDING_DELETION') {
      if (t.deletion_scheduled_for && new Date(t.deletion_scheduled_for) <= now) verdicts.push('DELETION_DUE');
      const owner = userById.get(t.owner_user_id);
      if (owner && owner.status !== 'PENDING_DELETION' && owner.status !== 'DELETED') verdicts.push('DELETION_STATE_MISMATCH');
    }
    if (verdicts.length) {
      add({
        kind: 'TENANT',
        id: t.id,
        tenantCode: t.tenant_code,
        status: t.status,
        dbName,
        dbExists: dbSet.has(dbName),
        ageDays: t.status === 'REJECTED' ? daysSince(t.rejected_at || t.updated_at) : null,
        eligibleToDrop: t.status === 'REJECTED' ? daysSince(t.rejected_at || t.updated_at) >= 90 : null,
        verdicts,
      });
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
  let users, tenants, migrated;
  try {
    await readOnly(pconn);
    const colSet = async (table) => {
      const [cols] = await pconn.query(
        'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [platformDb, table]
      );
      return new Set(cols.map((r) => r.c));
    };
    const userCols = await colSet('users');
    const tenantCols = await colSet('tenants');
    migrated = userCols.has('deletion_scheduled_for') && tenantCols.has('deletion_scheduled_for');
    [users] = await pconn.query(
      `SELECT id, status, is_verified${migrated ? ', deletion_scheduled_for, deleted_at' : ''}, ` +
        `(CASE WHEN status = 'DELETED' THEN (email LIKE 'deleted-%@deleted.gymsera.invalid' AND full_name = 'Deleted user' AND phone IS NULL) ELSE 1 END) AS anonymized ` +
        `FROM ${q(platformDb)}.users`
    );
    [tenants] = await pconn.query(
      `SELECT id, tenant_code, status, db_name, owner_user_id, rejected_at, updated_at${migrated ? ', deletion_scheduled_for' : ''} FROM ${q(platformDb)}.tenants`
    );
    await pconn.query('ROLLBACK');
  } finally {
    await pconn.end().catch(() => {});
  }

  const tconn = await mysql.createConnection(tenantCfg);
  let databases;
  try {
    await readOnly(tconn);
    const [schemas] = await tconn.query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'gymsera\\_%'");
    databases = schemas.map((s) => s.name).filter((n) => n !== platformDb);
    await tconn.query('ROLLBACK');
  } finally {
    await tconn.end().catch(() => {});
  }

  const findings = classify({ users, tenants, databases });
  const counts = {};
  for (const f of findings) for (const v of f.verdicts) counts[v] = (counts[v] || 0) + 1;

  console.log('AUTH-07 / NEW-34 deletion check (read-only)');
  console.log(`Platform DB: ${platformDb}   users: ${users.length}   tenants: ${tenants.length}   tenant databases: ${databases.length}   p014/p015 applied: ${migrated ? 'yes' : 'no'}`);
  if (findings.length === 0) {
    console.log('Nothing found.');
    return 0;
  }
  console.log(`Findings: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('   ')}\n`);
  for (const f of findings) {
    if (f.kind === 'USER') {
      console.log(
        `  user=${f.id} status=${f.status}${f.ownsTenant !== undefined ? ` ownsTenant=${f.ownsTenant} liveTenants=${f.liveTenants}` : ''}` +
          `${f.scheduledFor ? ` scheduledFor=${f.scheduledFor}` : ''}  → ${f.verdicts.join(', ')}`
      );
    } else {
      console.log(
        `  tenant=${f.id} code=${f.tenantCode} status=${f.status} db=${f.dbName} dbExists=${f.dbExists}` +
          `${f.ageDays !== null ? ` rejectedDaysAgo=${f.ageDays} eligibleToDrop=${f.eligibleToDrop}` : ''}  → ${f.verdicts.join(', ')}`
      );
    }
  }
  console.log(
    '\nNothing was changed. LEGACY_* users asked to be deleted under the old flow: decide whether to honour those requests ' +
      '(ask each to request again after Prompt 1I, or process them by hand). REJECTED_TENANT_DATABASE: report only; drop by hand with ' +
      'src/scripts/drop-orphan-tenant-database.js (dry run first).'
  );
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
