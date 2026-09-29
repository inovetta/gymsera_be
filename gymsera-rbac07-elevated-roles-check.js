#!/usr/bin/env node
/**
 * gymsera-rbac07-elevated-roles-check.js
 *
 * READ-ONLY report of platform accounts whose GLOBAL role (`users.role`) may have
 * been raised by the legacy staff flow that RBAC-07 (d296268) removed.
 *
 * What the old code did (src/services/gym.service.js before d296268):
 *   - adding an existing MEMBER as staff:   user.update({ role: 'BRANCH_MANAGER' })
 *   - adding staff by e-mail with no account yet: User.create({ role: 'BRANCH_MANAGER', ... })
 * No current code path writes BRANCH_MANAGER or TRAINER to users.role; the
 * tenantContext shim only sets it in memory per request.
 *
 * Suspects: every user whose role is NOT one of MEMBER, GYM_HOST, PLATFORM_ADMIN
 * (today that means BRANCH_MANAGER or TRAINER).
 *
 * For each suspect it reports:
 *   - tenants the user OWNS (platform tenants.owner_user_id) and the is_host flag
 *   - user_org_index rows (platform routing index)
 *   - role_assignments and gym_staff rows in every tenant database, matched by
 *     user_id OR e-mail, and whether that tenant is one the user owns
 * and gives one verdict:
 *   OWNS_TENANT             owns a tenant: a host, not a staff leftover. Role should
 *                           probably be GYM_HOST; review by hand.
 *   STAFF_ACCESS_CURRENT    holds an ACTIVE role_assignment in someone else's tenant.
 *                           Their gym access is legitimate and comes from that
 *                           assignment; the elevated global role is still a bug
 *                           leftover (the RBAC model keeps staff as MEMBER), but
 *                           resetting it would not remove their access.
 *   LIKELY_BUG_ORPHAN       only ever appears as someone else's staff (gym_staff rows
 *                           and/or non-ACTIVE role_assignments), with no ACTIVE
 *                           assignment: the elevated role is very likely the old bug.
 *   NO_TRACE                no ownership, no staff row, no assignment anywhere that
 *                           could be read. Origin unknown (seed/manual edit, or a
 *                           tenant DB that could not be read). Review by hand.
 * If any tenant database could not be read, verdicts are marked PROVISIONAL.
 *
 * Safety:
 *   - Every connection runs `SET SESSION TRANSACTION READ ONLY` first, and all work
 *     happens inside a READ ONLY transaction: MySQL rejects any write (ERROR 1792).
 *   - Only SELECT statements are issued. Nothing is changed. There is no --apply.
 *   - Output contains user e-mails: run it in a terminal, do not commit or paste the
 *     output anywhere public.
 *
 * Environment variables:
 *   CHK_HOST         Database host (default: 127.0.0.1)
 *   CHK_PORT         Database port (default: 3306)
 *   CHK_USER         Database user (default: root) — a SELECT-only user is enough
 *   CHK_PASSWORD     Database password (default: empty string)
 *   CHK_PLATFORM_DB  Platform database name (default: gymsera)
 *   TENANT_CONN_ENCRYPTION_KEY  (optional, read from .env) used only to decrypt each
 *                    tenant's connection string to learn its DATABASE NAME. Tenant
 *                    databases are read on CHK_HOST with the CHK_* credentials. Without
 *                    the key, every `gymsera_%` schema except the platform DB is scanned.
 *   CHK_TENANTS      (optional) comma-separated tenant database names to limit the scan
 *
 * Exit codes: 0 = no suspect accounts, 1 = suspect accounts listed, 2 = error.
 *
 * Usage:
 *   CHK_HOST=<host> CHK_PORT=3306 CHK_USER=<user> CHK_PASSWORD='<password>' \
 *     CHK_PLATFORM_DB=gymsera node gymsera-rbac07-elevated-roles-check.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const NOT_SUSPECT_ROLES = ['MEMBER', 'GYM_HOST', 'PLATFORM_ADMIN'];
const SAFE_DB_NAME = /^[A-Za-z0-9_$-]+$/;

const q = (name) => {
  if (!SAFE_DB_NAME.test(name)) throw new Error(`Refusing unexpected database name: ${name}`);
  return `\`${name}\``;
};

const normEmail = (e) => (e ? String(e).trim().toLowerCase() : null);

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

async function columnExists(conn, db, table, column) {
  const [rows] = await conn.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [db, table, column]
  );
  return rows.length > 0;
}

/** Tenant databases to scan, each labelled with its platform tenant (when known). */
async function discoverTenantDatabases(conn, platformDb, tenants) {
  const warnings = [];
  const byDb = new Map(); // dbName -> tenant row | null

  let decrypt = null;
  try {
    ({ decrypt } = require('./src/utils/crypto.utils'));
  } catch (_) {
    /* helper missing: fall back to schema scan */
  }

  let decryptFailures = 0;
  if (decrypt) {
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
    warnings.push(`${decryptFailures} tenant connection string(s) could not be decrypted (TENANT_CONN_ENCRYPTION_KEY missing or different).`);
  }

  if (byDb.size === 0) {
    warnings.push('No tenant database names from the platform tenants table; scanning every gymsera_% schema instead (tenant labels unknown).');
    const [schemas] = await conn.query(
      "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'gymsera\\_%' ORDER BY SCHEMA_NAME"
    );
    for (const s of schemas) {
      if (s.name !== platformDb && !s.name.endsWith('_platform')) byDb.set(s.name, null);
    }
  }

  // Keep only schemas that exist on this server.
  const [existing] = await conn.query('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA');
  const present = new Set(existing.map((r) => r.name));
  for (const dbName of [...byDb.keys()]) {
    if (!present.has(dbName)) {
      const t = byDb.get(dbName);
      warnings.push(`Tenant database ${dbName}${t ? ` (tenant ${t.tenant_code})` : ''} not found on this server — not scanned.`);
      byDb.delete(dbName);
    }
  }

  if (process.env.CHK_TENANTS) {
    const allowed = new Set(process.env.CHK_TENANTS.split(',').map((s) => s.trim()).filter(Boolean));
    for (const dbName of [...byDb.keys()]) if (!allowed.has(dbName)) byDb.delete(dbName);
    warnings.push(`CHK_TENANTS set: scan limited to ${[...byDb.keys()].join(', ') || '(none)'}.`);
  }

  return { byDb, warnings };
}

/**
 * role_assignments + gym_staff rows for the suspects in one tenant database.
 * `lock` (used only by the correction script, inside its write transaction) takes
 * shared next-key locks on the matching role_assignments rows, so no assignment for
 * these users can be inserted or activated until that transaction ends.
 */
async function scanTenantDb(conn, dbName, suspectIds, suspectEmails, { lock = false } = {}) {
  const out = { roleAssignments: [], gymStaff: [], errors: [] };
  const idList = suspectIds.length ? suspectIds : ['__none__'];
  const emailList = suspectEmails.length ? suspectEmails : ['__none__'];

  try {
    if (await tableExists(conn, dbName, 'role_assignments')) {
      const [rows] = await conn.query(
        `SELECT id, user_id, email, role_key, scope_type, status, created_at, revoked_at
           FROM ${q(dbName)}.role_assignments
          WHERE user_id IN (?) OR LOWER(TRIM(email)) IN (?)${lock ? ' LOCK IN SHARE MODE' : ''}`,
        [idList, emailList]
      );
      out.roleAssignments = rows;
    } else {
      out.errors.push('no role_assignments table');
    }

    if (await tableExists(conn, dbName, 'gym_staff')) {
      const hasEmail = await columnExists(conn, dbName, 'gym_staff', 'email');
      const [rows] = await conn.query(
        `SELECT id, user_id, ${hasEmail ? 'email' : 'NULL AS email'}, branch_id, designation,
                employment_status, status, created_at
           FROM ${q(dbName)}.gym_staff
          WHERE user_id IN (?)${hasEmail ? ' OR LOWER(TRIM(email)) IN (?)' : ''}`,
        hasEmail ? [idList, emailList] : [idList]
      );
      out.gymStaff = rows;
    }
  } catch (err) {
    out.errors.push(err.message);
  }
  return out;
}

function matches(row, user) {
  return row.user_id === user.id || (row.email && normEmail(row.email) === normEmail(user.email));
}

function verdictFor(ev) {
  if (ev.ownedTenants.length > 0) return 'OWNS_TENANT';
  const activeElsewhere = ev.tenantRows.some((t) => t.roleAssignments.some((ra) => ra.status === 'ACTIVE'));
  if (activeElsewhere) return 'STAFF_ACCESS_CURRENT';
  const anyStaffTrace = ev.tenantRows.some((t) => t.roleAssignments.length > 0 || t.gymStaff.length > 0) || ev.orgIndex.length > 0;
  if (anyStaffTrace) return 'LIKELY_BUG_ORPHAN';
  return 'NO_TRACE';
}

async function main() {
  const config = {
    host: process.env.CHK_HOST || '127.0.0.1',
    port: parseInt(process.env.CHK_PORT || '3306', 10),
    user: process.env.CHK_USER || 'root',
    password: process.env.CHK_PASSWORD || '',
  };
  const platformDb = process.env.CHK_PLATFORM_DB || 'gymsera';
  q(platformDb);

  console.log(`Connecting READ ONLY to MySQL at ${config.host}:${config.port} as ${config.user} (platform DB: ${platformDb})...`);
  const conn = await openReadOnly(config);

  try {
    // Prove the session really is read-only before reading anything.
    const [[ro]] = await conn.query('SELECT @@session.transaction_read_only AS ro').catch(() => conn.query('SELECT @@session.tx_read_only AS ro'));
    if (Number(ro.ro) !== 1) throw new Error('Session is not read-only; aborting.');

    // 1. Role distribution + suspects (platform DB)
    const [dist] = await conn.query(`SELECT role, COUNT(*) AS n FROM ${q(platformDb)}.users GROUP BY role ORDER BY role`);
    const [suspects] = await conn.query(
      `SELECT id, email, full_name, role, status, is_host, created_at, updated_at
         FROM ${q(platformDb)}.users
        WHERE role NOT IN (?)
        ORDER BY role, created_at`,
      [NOT_SUSPECT_ROLES]
    );

    console.log('\nusers.role distribution:');
    for (const r of dist) console.log(`  ${String(r.role).padEnd(16)} ${r.n}`);
    console.log(`\nSuspect accounts (role not in ${NOT_SUSPECT_ROLES.join(', ')}): ${suspects.length}`);

    if (suspects.length === 0) {
      console.log('\nNothing to report. 0 writes made (read-only session).');
      return 0;
    }

    const suspectIds = suspects.map((u) => u.id);
    const suspectEmails = [...new Set(suspects.map((u) => normEmail(u.email)).filter(Boolean))];

    // 2. Platform evidence: ownership + routing index
    const [tenants] = await conn.query(
      `SELECT id, tenant_code, business_name, owner_user_id, status, connection_string_encrypted
         FROM ${q(platformDb)}.tenants`
    );
    const tenantById = new Map(tenants.map((t) => [t.id, t]));

    let orgIndexRows = [];
    if (await tableExists(conn, platformDb, 'user_org_index')) {
      [orgIndexRows] = await conn.query(
        `SELECT user_id, tenant_id, role_key, status FROM ${q(platformDb)}.user_org_index WHERE user_id IN (?)`,
        [suspectIds]
      );
    }

    // 3. Tenant evidence
    const { byDb, warnings } = await discoverTenantDatabases(conn, platformDb, tenants);
    const scans = new Map();
    const unreadable = [];
    for (const [dbName] of byDb) {
      const s = await scanTenantDb(conn, dbName, suspectIds, suspectEmails);
      scans.set(dbName, s);
      if (s.errors.length) unreadable.push(`${dbName}: ${s.errors.join('; ')}`);
    }

    // 4. Per-user report
    const counts = {};
    const provisional = unreadable.length > 0 || warnings.some((w) => /not found|could not be decrypted|scanning every/.test(w));

    console.log(`Tenant databases scanned: ${byDb.size}`);
    for (const w of warnings) console.log(`  WARNING: ${w}`);
    for (const u of unreadable) console.log(`  UNREADABLE: ${u}`);

    for (const user of suspects) {
      const ownedTenants = tenants.filter((t) => t.owner_user_id === user.id);
      const ownedIds = new Set(ownedTenants.map((t) => t.id));
      const tenantRows = [];
      for (const [dbName, s] of scans) {
        const ra = s.roleAssignments.filter((r) => matches(r, user));
        const gs = s.gymStaff.filter((r) => matches(r, user));
        if (ra.length || gs.length) {
          const t = byDb.get(dbName);
          tenantRows.push({ dbName, tenant: t, ownsIt: t ? ownedIds.has(t.id) : false, roleAssignments: ra, gymStaff: gs });
        }
      }
      const orgIndex = orgIndexRows.filter((r) => r.user_id === user.id);
      const ev = { ownedTenants, tenantRows, orgIndex };
      const verdict = verdictFor(ev);
      counts[verdict] = (counts[verdict] || 0) + 1;

      console.log('\n------------------------------------------------------------');
      console.log(`user ${user.id}  ${user.email}`);
      console.log(`  role=${user.role}  status=${user.status}  is_host=${user.is_host ? 1 : 0}  created=${user.created_at}  updated=${user.updated_at}`);
      console.log(`  VERDICT: ${verdict}${provisional && verdict !== 'OWNS_TENANT' ? ' (PROVISIONAL — some tenant DBs not read)' : ''}`);

      console.log(`  owns tenants: ${ownedTenants.length ? ownedTenants.map((t) => `${t.tenant_code} [${t.status}]`).join(', ') : 'none'}`);
      if (orgIndex.length) {
        console.log(`  user_org_index: ${orgIndex.map((r) => `${tenantById.get(r.tenant_id)?.tenant_code || r.tenant_id} ${r.role_key}/${r.status}`).join(', ')}`);
      } else {
        console.log('  user_org_index: none');
      }
      if (!tenantRows.length) console.log('  tenant rows: none (no role_assignments / gym_staff match by id or e-mail)');
      for (const tr of tenantRows) {
        const label = tr.tenant ? `${tr.tenant.tenant_code} [${tr.tenant.status}]` : '(tenant unknown)';
        const whose = !tr.tenant ? 'owner unknown' : tr.ownsIt ? 'OWN tenant' : "someone else's tenant";
        console.log(`  in ${tr.dbName} ${label} — ${whose}`);
        for (const ra of tr.roleAssignments) {
          const how = ra.user_id === user.id ? 'by user_id' : 'by e-mail only';
          console.log(`    role_assignment ${ra.role_key}/${ra.scope_type} status=${ra.status} created=${ra.created_at}${ra.revoked_at ? ` revoked=${ra.revoked_at}` : ''} (${how})`);
        }
        for (const gs of tr.gymStaff) {
          const how = gs.user_id === user.id ? 'by user_id' : 'by e-mail only';
          console.log(`    gym_staff "${gs.designation || '-'}" status=${gs.status} employment=${gs.employment_status} branch=${gs.branch_id} created=${gs.created_at} (${how})`);
        }
      }
    }

    // 5. Summary
    console.log('\n============================================================');
    console.log('  SUMMARY (RBAC-07 residual elevated roles)');
    console.log('============================================================');
    console.log(`Suspect accounts:        ${suspects.length}`);
    for (const k of ['LIKELY_BUG_ORPHAN', 'STAFF_ACCESS_CURRENT', 'OWNS_TENANT', 'NO_TRACE']) {
      console.log(`  ${k.padEnd(22)} ${counts[k] || 0}`);
    }
    console.log(`Tenant DBs scanned:      ${byDb.size}${unreadable.length ? ` (${unreadable.length} with errors)` : ''}`);
    console.log(`Verdicts provisional:    ${provisional ? 'YES — see warnings above' : 'no'}`);
    console.log('Safety:                  READ ONLY session + READ ONLY transaction, SELECT only, 0 writes');
    console.log('============================================================\n');
    return 1;
  } finally {
    await conn.query('ROLLBACK').catch(() => {});
    await conn.end();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`Fatal error: ${err.message}`);
      process.exit(2);
    });
}

// Shared with gymsera-rbac07-reset-orphan-roles.js, so both use one verdict rule.
module.exports = {
  NOT_SUSPECT_ROLES,
  q,
  normEmail,
  openReadOnly,
  tableExists,
  discoverTenantDatabases,
  scanTenantDb,
  matches,
  verdictFor,
};
