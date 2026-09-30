#!/usr/bin/env node
/**
 * gymsera-r25-tenant-db-credentials-check.js
 *
 * READ-ONLY report of tenants whose stored database connection string does
 * not use the tenant app user (spec §14 R-25).
 *
 * What the old code did (src/services/tenant-provisioning.service.js before R-25):
 *   - to CREATE DATABASE it tried TENANT_DB_ADMIN_*, then the platform DB
 *     credentials, then `root` with an empty password;
 *   - when the tenant app user (TENANT_DB_USER) could not log in, it switched to
 *     whichever admin credentials had worked and SAVED THEM (encrypted) as the
 *     tenant's permanent connection string. That tenant then runs every request
 *     with admin rights over the whole MySQL server.
 *
 * For each tenant it decrypts `tenants.connection_string_encrypted` in memory and
 * reports only the USERNAME, whether the password is empty, and one verdict:
 *   OK_APP_USER        the configured tenant app user (CHK_APP_USER).
 *   ADMIN_USER         the tenant-server admin user (CHK_ADMIN_USER): the old fallback.
 *   PLATFORM_USER      the platform DB user (CHK_PLATFORM_USER): the old fallback.
 *   ROOT               `root`: the old fallback (or a manual setup).
 *   OTHER_USER         some other user: review by hand (seed script, manual edit).
 *   UNDECRYPTABLE      TENANT_CONN_ENCRYPTION_KEY missing or different.
 *   NOT_PROVISIONED    no connection string yet.
 * If CHK_APP_USER equals the admin user (e.g. a local/CI server that runs
 * everything as root), the verdict cannot tell the two apart; this is printed.
 *
 * Safety:
 *   - The connection runs `SET SESSION TRANSACTION READ ONLY` and all work is
 *     inside a READ ONLY transaction: MySQL rejects any write (ERROR 1792).
 *   - Only one SELECT on the platform `tenants` table. Nothing is changed. There is no --apply.
 *   - Passwords are never printed. Output holds tenant ids/codes and MySQL usernames.
 *
 * Environment variables:
 *   CHK_HOST          Database host (default: 127.0.0.1)
 *   CHK_PORT          Database port (default: 3306)
 *   CHK_USER          Database user (default: root) — a SELECT-only user is enough
 *   CHK_PASSWORD      Database password (default: empty string)
 *   CHK_PLATFORM_DB   Platform database name (default: gymsera)
 *   CHK_APP_USER      Expected tenant app user (default: TENANT_DB_USER from .env)
 *   CHK_ADMIN_USER    Tenant-server admin user (default: TENANT_DB_ADMIN_USER from .env)
 *   CHK_PLATFORM_USER Platform DB user (default: PLATFORM_DB_USER from .env)
 *   TENANT_CONN_ENCRYPTION_KEY  (read from .env) to decrypt connection strings.
 *
 * Exit codes: 0 = every provisioned tenant uses the app user, 1 = tenants listed
 * that need review, 2 = error.
 *
 * Usage:
 *   CHK_HOST=<host> CHK_PORT=3306 CHK_USER=<user> CHK_PASSWORD='<password>' \
 *     CHK_PLATFORM_DB=gymsera node gymsera-r25-tenant-db-credentials-check.js
 */

require('dotenv').config();
const { URL } = require('url');
const mysql = require('mysql2/promise');

const SAFE_DB_NAME = /^[A-Za-z0-9_$-]+$/;

const q = (name) => {
  if (!SAFE_DB_NAME.test(name)) throw new Error(`Refusing unexpected database name: ${name}`);
  return `\`${name}\``;
};

/**
 * Classifies tenant rows. `decrypt` turns an encrypted connection string into
 * a mysql:// URL. Returns one entry per tenant; never includes a password.
 */
function classifyTenants(rows, { appUser, adminUser, platformUser, decrypt }) {
  return rows.map((t) => {
    const base = { id: t.id, tenantCode: t.tenant_code, status: t.status, user: null, emptyPassword: null };
    const enc = t.connection_string_encrypted;
    if (!enc || enc === 'PENDING_PROVISIONING') return { ...base, verdict: 'NOT_PROVISIONED' };
    let url;
    try {
      url = new URL(decrypt(enc));
    } catch (_) {
      return { ...base, verdict: 'UNDECRYPTABLE' };
    }
    const user = decodeURIComponent(url.username || '');
    const emptyPassword = (url.password || '') === '';
    let verdict;
    if (appUser && user === appUser) verdict = 'OK_APP_USER';
    else if (adminUser && user === adminUser) verdict = 'ADMIN_USER';
    else if (platformUser && user === platformUser) verdict = 'PLATFORM_USER';
    else if (user === 'root') verdict = 'ROOT';
    else verdict = 'OTHER_USER';
    return { ...base, user, emptyPassword, verdict };
  });
}

const NEEDS_REVIEW = new Set(['ADMIN_USER', 'PLATFORM_USER', 'ROOT', 'OTHER_USER', 'UNDECRYPTABLE']);

async function main() {
  const platformDb = process.env.CHK_PLATFORM_DB || 'gymsera';
  const appUser = process.env.CHK_APP_USER || process.env.TENANT_DB_USER || '';
  const adminUser = process.env.CHK_ADMIN_USER || process.env.TENANT_DB_ADMIN_USER || '';
  const platformUser = process.env.CHK_PLATFORM_USER || process.env.PLATFORM_DB_USER || '';

  let decrypt;
  try {
    ({ decrypt } = require('./src/utils/crypto.utils'));
  } catch (err) {
    decrypt = () => { throw err; };
  }

  const conn = await mysql.createConnection({
    host: process.env.CHK_HOST || '127.0.0.1',
    port: parseInt(process.env.CHK_PORT || '3306', 10),
    user: process.env.CHK_USER || 'root',
    password: process.env.CHK_PASSWORD || '',
    dateStrings: true,
  });
  let rows;
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query('START TRANSACTION READ ONLY');
    [rows] = await conn.query(
      `SELECT id, tenant_code, status, connection_string_encrypted FROM ${q(platformDb)}.tenants ORDER BY created_at, id`
    );
    await conn.query('ROLLBACK');
  } finally {
    await conn.end().catch(() => {});
  }

  const results = classifyTenants(rows, { appUser, adminUser, platformUser, decrypt });
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

  console.log('R-25 tenant DB credentials check (read-only)');
  console.log(`Platform DB: ${platformDb}   expected app user: '${appUser || '(not set)'}'   admin user: '${adminUser || '(not set)'}'   platform user: '${platformUser || '(not set)'}'`);
  if (appUser && appUser === adminUser) {
    console.log('NOTE: the app user and the admin user are the same on this configuration, so ADMIN_USER cannot be told apart from OK_APP_USER.');
  }
  console.log(`Tenants: ${results.length}   ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('   ')}`);

  const flagged = results.filter((r) => NEEDS_REVIEW.has(r.verdict));
  if (flagged.length === 0) {
    console.log('No tenant needs review.');
    return 0;
  }
  console.log('\nTenants to review (passwords are never shown):');
  for (const r of flagged) {
    console.log(`  ${r.verdict.padEnd(14)} tenant=${r.id} code=${r.tenantCode} status=${r.status} user=${r.user ?? '-'} emptyPassword=${r.emptyPassword ?? '-'}`);
  }
  console.log('\nNothing was changed. Moving a tenant to the app user is a data correction for the owner to decide.');
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

module.exports = { classifyTenants, NEEDS_REVIEW };
