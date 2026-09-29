#!/usr/bin/env node
/**
 * gymsera-rbac07-reset-orphan-roles.js
 *
 * One-off correction for RBAC-07 residual data: resets users.role BRANCH_MANAGER → MEMBER
 * for the six accounts that gymsera-rbac07-elevated-roles-check.js reported as
 * LIKELY_BUG_ORPHAN (the legacy /gyms/staff flow raised their global role; no current
 * code path does). Nothing else about these users is changed.
 *
 * Safety & invariants:
 * 1. Only the hard-coded TARGET_USER_IDS below are ever touched. The suspect list is
 *    NOT re-derived, and there is no command-line way to add ids.
 * 2. Every user is re-verified LIVE with the same verdict rule as the check script
 *    (shared code: verdictFor / scanTenantDb). A user is corrected only if, right now:
 *    the row exists, role is still BRANCH_MANAGER, they own no tenant, they hold no
 *    ACTIVE role_assignment in any tenant database, and the verdict is
 *    LIKELY_BUG_ORPHAN. Anyone else is SKIPPED with the reason, untouched.
 * 3. If any tenant database cannot be read (or tenant connection strings cannot be
 *    decrypted), "no active access anywhere" cannot be proven, so EVERY user is
 *    skipped. CHK_TENANTS (partial scan) is refused for the same reason.
 * 4. DEFAULT = PREVIEW: read-only session + READ ONLY transaction, zero writes; prints
 *    exactly what would change and why.
 * 5. Writes only with BOTH --apply and --confirm. --apply alone is refused.
 * 6. APPLY runs in ONE transaction: the verification reads lock what they read (users
 *    FOR UPDATE; owned tenants and matching role_assignments LOCK IN SHARE MODE), then
 *    each UPDATE is guarded by `AND role = 'BRANCH_MANAGER'` and must hit exactly one
 *    row, and one platform_audit_logs row is inserted per user
 *    (action 'rbac07_role_correction', before/after role, reason). Any failure rolls
 *    everything back: all corrected or none.
 * 7. After APPLY, a fresh read-only pass re-runs the verdict logic on the same ids and
 *    confirms every corrected user is role=MEMBER with its audit row present.
 * 8. Idempotent: a second run finds role=MEMBER and skips ("already corrected").
 *
 * Note: authenticate() reads the role from the JWT, so an access token issued before
 * the correction keeps the old role string until it expires. Access decisions for
 * these users already come from role_assignments (they have none ACTIVE).
 *
 * Environment variables (same as gymsera-rbac07-elevated-roles-check.js):
 *   CHK_HOST, CHK_PORT (3306), CHK_USER, CHK_PASSWORD, CHK_PLATFORM_DB (gymsera)
 *   TENANT_CONN_ENCRYPTION_KEY (from .env) — needed to find every tenant database.
 *   The CHK_USER must be able to UPDATE users and INSERT platform_audit_logs for --apply.
 *
 * Usage (from the gymsera_be folder):
 *   # Preview (default, read-only):
 *   CHK_HOST=<host> CHK_PORT=3306 CHK_USER=<user> CHK_PASSWORD='<password>' \
 *     CHK_PLATFORM_DB=gymsera node gymsera-rbac07-reset-orphan-roles.js
 *   # Apply:
 *   ... node gymsera-rbac07-reset-orphan-roles.js --apply --confirm
 *
 * Exit codes: 0 = done (preview, or apply + post-check passed), 1 = error / refused /
 * post-check failed.
 */

require('dotenv').config();
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const {
  q,
  normEmail,
  openReadOnly,
  tableExists,
  discoverTenantDatabases,
  scanTenantDb,
  matches,
  verdictFor,
} = require('./gymsera-rbac07-elevated-roles-check');

// Verified LIKELY_BUG_ORPHAN by gymsera-rbac07-elevated-roles-check.js. Do not extend.
const TARGET_USER_IDS = Object.freeze([
  'cc831ec5-4e96-4c28-a178-7ef1d32517a3',
  '7ad08423-8307-4d56-af9f-b822176c8676',
  'aa51e47e-c17f-482a-b660-7a51af77ee95',
  '8bef883e-21ef-465f-9097-6e45989a24e3',
  'bba04312-cb45-4336-9748-4eb242fe5699',
  '039a8f11-483d-40e6-a68a-19e8e458077c',
]);

const FROM_ROLE = 'BRANCH_MANAGER';
const TO_ROLE = 'MEMBER';
const AUDIT_ACTION = 'rbac07_role_correction';
const AUDIT_REASON =
  'residual role from legacy staff bug (RBAC-07), verified LIKELY_BUG_ORPHAN, no active access depends on it';
const SCRIPT_NAME = 'gymsera-rbac07-reset-orphan-roles.js';

async function auditRowsFor(conn, platformDb, userIds) {
  if (!(await tableExists(conn, platformDb, 'platform_audit_logs'))) return null;
  const [rows] = await conn.query(
    `SELECT target_id, created_at FROM ${q(platformDb)}.platform_audit_logs
      WHERE action = ? AND target_type = 'user' AND target_id IN (?)`,
    [AUDIT_ACTION, userIds]
  );
  const byUser = new Map();
  for (const r of rows) byUser.set(r.target_id, (byUser.get(r.target_id) || 0) + 1);
  return byUser;
}

/**
 * Live re-verification of `userIds` on `conn` (inside whatever transaction it holds).
 * With lock=true the rows it relies on stay locked until that transaction ends.
 */
async function evaluate(conn, platformDb, userIds, { lock = false } = {}) {
  if (process.env.CHK_TENANTS) {
    throw new Error('CHK_TENANTS is set: a partial tenant scan cannot prove "no active access anywhere". Unset it.');
  }

  const [users] = await conn.query(
    `SELECT id, email, role, status FROM ${q(platformDb)}.users WHERE id IN (?)${lock ? ' FOR UPDATE' : ''}`,
    [userIds]
  );
  const userById = new Map(users.map((u) => [u.id, u]));

  const [owned] = await conn.query(
    `SELECT id, tenant_code, owner_user_id, status FROM ${q(platformDb)}.tenants
      WHERE owner_user_id IN (?)${lock ? ' LOCK IN SHARE MODE' : ''}`,
    [userIds]
  );
  const [tenants] = await conn.query(
    `SELECT id, tenant_code, owner_user_id, status, connection_string_encrypted FROM ${q(platformDb)}.tenants`
  );

  let orgIndexRows = [];
  if (await tableExists(conn, platformDb, 'user_org_index')) {
    [orgIndexRows] = await conn.query(
      `SELECT user_id, tenant_id, role_key, status FROM ${q(platformDb)}.user_org_index WHERE user_id IN (?)`,
      [userIds]
    );
  }

  const { byDb, warnings } = await discoverTenantDatabases(conn, platformDb, tenants);
  const ids = users.map((u) => u.id);
  const emails = [...new Set(users.map((u) => normEmail(u.email)).filter(Boolean))];
  const scans = new Map();
  const unreadable = [];
  for (const [dbName] of byDb) {
    const s = await scanTenantDb(conn, dbName, ids, emails, { lock });
    scans.set(dbName, s);
    if (s.errors.length) unreadable.push(`${dbName}: ${s.errors.join('; ')}`);
  }
  const provisional = unreadable.length > 0 || warnings.some((w) => /not found|could not be decrypted|scanning every/.test(w));

  const audits = (await auditRowsFor(conn, platformDb, userIds)) || new Map();

  const results = userIds.map((id) => {
    const user = userById.get(id);
    if (!user) return { id, decision: 'SKIP', reason: 'user not found' };

    const ownedTenants = owned.filter((t) => t.owner_user_id === id);
    const tenantRows = [];
    for (const [dbName, s] of scans) {
      const ra = s.roleAssignments.filter((r) => matches(r, user));
      const gs = s.gymStaff.filter((r) => matches(r, user));
      if (ra.length || gs.length) tenantRows.push({ dbName, tenant: byDb.get(dbName), roleAssignments: ra, gymStaff: gs });
    }
    const orgIndex = orgIndexRows.filter((r) => r.user_id === id);
    const verdict = verdictFor({ ownedTenants, tenantRows, orgIndex });
    const activeRa = tenantRows.flatMap((t) => t.roleAssignments.filter((ra) => ra.status === 'ACTIVE').map((ra) => `${t.dbName} ${ra.role_key}`));
    const evidence = {
      ownedTenants: ownedTenants.map((t) => t.tenant_code),
      activeRoleAssignments: activeRa,
      otherRoleAssignments: tenantRows.flatMap((t) => t.roleAssignments.filter((ra) => ra.status !== 'ACTIVE').map((ra) => `${t.dbName} ${ra.role_key}/${ra.status}`)),
      gymStaffRows: tenantRows.reduce((n, t) => n + t.gymStaff.length, 0),
      tenantDbsScanned: byDb.size,
    };
    const base = { id, email: user.email, role: user.role, verdict, evidence, auditRows: audits.get(id) || 0 };

    if (provisional) {
      return { ...base, decision: 'SKIP', reason: `cannot prove no active access: ${unreadable.length} tenant DB(s) unreadable / ${warnings.length} warning(s)` };
    }
    if (user.role !== FROM_ROLE) {
      const already = user.role === TO_ROLE && base.auditRows > 0;
      return { ...base, decision: 'SKIP', reason: already ? 'already corrected (role MEMBER, audit row present)' : `role is ${user.role}, not ${FROM_ROLE}` };
    }
    if (verdict !== 'LIKELY_BUG_ORPHAN') {
      const why = verdict === 'OWNS_TENANT' ? `owns tenant ${evidence.ownedTenants.join(', ')}`
        : verdict === 'STAFF_ACCESS_CURRENT' ? `ACTIVE role_assignment: ${activeRa.join(', ')}`
        : 'no staff trace found at all';
      return { ...base, decision: 'SKIP', reason: `live verdict is ${verdict} (${why})` };
    }
    return { ...base, decision: 'CORRECT', reason: `verdict LIKELY_BUG_ORPHAN; ${FROM_ROLE} → ${TO_ROLE}` };
  });

  return { results, warnings, unreadable, tenantDbsScanned: byDb.size };
}

function printEvaluation(log, ev) {
  log(`Tenant databases scanned: ${ev.tenantDbsScanned}`);
  for (const w of ev.warnings) log(`  WARNING: ${w}`);
  for (const u of ev.unreadable) log(`  UNREADABLE: ${u}`);
  for (const r of ev.results) {
    log(`\n  ${r.decision === 'CORRECT' ? 'CORRECT' : 'SKIP   '} ${r.id}${r.email ? `  ${r.email}` : ''}`);
    if (r.role) log(`          role=${r.role}  live verdict=${r.verdict}  audit rows=${r.auditRows}`);
    if (r.evidence) {
      log(`          owns=[${r.evidence.ownedTenants.join(', ')}] activeRA=[${r.evidence.activeRoleAssignments.join(', ')}] ` +
        `otherRA=[${r.evidence.otherRoleAssignments.join(', ')}] gym_staff rows=${r.evidence.gymStaffRows}`);
    }
    log(`          ${r.reason}`);
  }
}

/** Read-only confirmation after APPLY: corrected users are MEMBER with an audit row. */
async function postCheck(config, platformDb, userIds, correctedIds) {
  const conn = await openReadOnly(config);
  try {
    const ev = await evaluate(conn, platformDb, userIds);
    const rows = ev.results.map((r) => {
      const wasCorrected = correctedIds.includes(r.id);
      const ok = !wasCorrected || (r.role === TO_ROLE && r.auditRows > 0);
      return { id: r.id, role: r.role || '(missing)', verdict: r.verdict || '-', auditRows: r.auditRows || 0, corrected: wasCorrected, ok };
    });
    return { rows, ok: rows.every((r) => r.ok) };
  } finally {
    await conn.query('ROLLBACK').catch(() => {});
    await conn.end();
  }
}

async function run({ config, platformDb, userIds = TARGET_USER_IDS, apply = false, confirm = false, log = console.log }) {
  if (apply && !confirm) {
    throw new Error(`Safety check failed: --apply requires --confirm. Run with: node ${SCRIPT_NAME} --apply --confirm`);
  }
  q(platformDb);

  log('============================================================');
  log(`  RBAC-07 ORPHAN ROLE RESET: ${apply ? 'APPLY MODE (WRITES)' : 'PREVIEW MODE (READ ONLY)'}`);
  log('============================================================');
  log(`MySQL ${config.host}:${config.port} as ${config.user}, platform DB ${platformDb}, ${userIds.length} target id(s)`);

  if (!apply) {
    const conn = await openReadOnly(config);
    try {
      if (!(await tableExists(conn, platformDb, 'platform_audit_logs'))) {
        log('  WARNING: platform_audit_logs table missing — --apply would refuse to run.');
      }
      const ev = await evaluate(conn, platformDb, userIds);
      printEvaluation(log, ev);
      const toFix = ev.results.filter((r) => r.decision === 'CORRECT');
      log('\n------------------------------------------------------------');
      log(`Would correct: ${toFix.length}   Would skip: ${ev.results.length - toFix.length}`);
      log('Mode: PREVIEW — 0 writes (READ ONLY session + transaction). Re-run with --apply --confirm to write.');
      return { mode: 'PREVIEW', evaluation: ev, corrected: [], skipped: ev.results.filter((r) => r.decision === 'SKIP') };
    } finally {
      await conn.query('ROLLBACK').catch(() => {});
      await conn.end();
    }
  }

  const conn = await mysql.createConnection({ ...config, dateStrings: true });
  let ev;
  let corrected = [];
  try {
    if (!(await tableExists(conn, platformDb, 'platform_audit_logs'))) {
      throw new Error('platform_audit_logs table not found: refusing to change roles without an audit trail.');
    }
    await conn.query('START TRANSACTION');
    ev = await evaluate(conn, platformDb, userIds, { lock: true });
    printEvaluation(log, ev);

    const toFix = ev.results.filter((r) => r.decision === 'CORRECT');
    for (const r of toFix) {
      const [upd] = await conn.query(
        `UPDATE ${q(platformDb)}.users SET role = ? WHERE id = ? AND role = ?`,
        [TO_ROLE, r.id, FROM_ROLE]
      );
      if (upd.affectedRows !== 1) throw new Error(`UPDATE for ${r.id} changed ${upd.affectedRows} rows (expected 1)`);

      const details = {
        beforeRole: FROM_ROLE,
        afterRole: TO_ROLE,
        reason: AUDIT_REASON,
        verdict: r.verdict,
        evidence: r.evidence,
        script: SCRIPT_NAME,
      };
      await conn.query(
        `INSERT INTO ${q(platformDb)}.platform_audit_logs
           (id, actor_user_id, action, target_type, target_id, details, created_at)
         VALUES (?, NULL, ?, 'user', ?, ?, UTC_TIMESTAMP())`,
        [crypto.randomUUID(), AUDIT_ACTION, r.id, JSON.stringify(details)]
      );
    }
    await conn.query('COMMIT');
    corrected = toFix.map((r) => r.id);
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    log(`\nROLLED BACK — no user changed, no audit row written: ${err.message}`);
    throw err;
  } finally {
    await conn.end();
  }

  const skipped = ev.results.filter((r) => r.decision === 'SKIP');
  log('\n============================================================');
  log('  APPLY SUMMARY');
  log('============================================================');
  log(`Corrected (${FROM_ROLE} → ${TO_ROLE}): ${corrected.length}`);
  log(`Skipped:                              ${skipped.length}`);
  for (const s of skipped) log(`  - ${s.id}: ${s.reason}`);

  const check = await postCheck(config, platformDb, userIds, corrected);
  log('\nPost-apply check (read-only, same verdict logic):');
  for (const r of check.rows) {
    log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.id} role=${r.role} verdict=${r.verdict} audit rows=${r.auditRows}${r.corrected ? ' (corrected now)' : ''}`);
  }
  log(`Post-apply check: ${check.ok ? 'PASS' : 'FAIL'}`);
  log('============================================================\n');

  return { mode: 'APPLY', evaluation: ev, corrected, skipped, postCheck: check };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const config = {
    host: process.env.CHK_HOST || '127.0.0.1',
    port: parseInt(process.env.CHK_PORT || '3306', 10),
    user: process.env.CHK_USER || 'root',
    password: process.env.CHK_PASSWORD || '',
  };
  run({
    config,
    platformDb: process.env.CHK_PLATFORM_DB || 'gymsera',
    userIds: TARGET_USER_IDS,
    apply: args.includes('--apply'),
    confirm: args.includes('--confirm'),
  })
    .then((res) => process.exit(res.mode === 'APPLY' && !res.postCheck.ok ? 1 : 0))
    .catch((err) => {
      console.error(`Fatal error: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { TARGET_USER_IDS, AUDIT_ACTION, AUDIT_REASON, evaluate, run };
