#!/usr/bin/env node
/**
 * Rebuilds every tenant's stored connection string after the tenant MySQL user's password changed
 * (NEW-203; secrets rotation row 1, docs/runbooks/secrets-rotation.md).
 *
 * Usage (dry run is the default: it reads, checks and writes nothing):
 *   1. Change the MySQL password of TENANT_DB_USER on the tenant server.
 *   2. Put the new password in TENANT_DB_PASS in the API .env (do not restart yet).
 *   3. node src/scripts/rebuild-tenant-connection-strings.js                 (dry run, read it)
 *      node src/scripts/rebuild-tenant-connection-strings.js --tenant=GYM-1234   (one tenant first)
 *   4. node src/scripts/rebuild-tenant-connection-strings.js --apply
 *   5. Restart the API (iisreset): open pools keep the old connections until then.
 *
 * Rules:
 *  - Only the password changes. User, host, port and database name are kept exactly as stored;
 *    a database name is never composed or guessed (R-79). A stored name that differs from
 *    tenants.db_name (or a tenant with no db_name) is refused for a person to look at.
 *  - Only rows whose stored user is TENANT_DB_USER are rebuilt. A row with another user (R-25
 *    leftovers, see gymsera-r25-tenant-db-credentials-check.js) is reported and left alone.
 *  - Every rebuilt string must connect (the way the API connects) before anything is written.
 *  - Any failure (unreadable value, name mismatch, no connection) writes nothing: all updates are one
 *    transaction, after every check passed.
 *  - Passwords are never printed. Output: tenant code, host:port/database, MySQL user, action.
 */
const { Sequelize } = require('sequelize');
const { decrypt, encrypt } = require('../utils/crypto.utils');

const PENDING = 'PENDING_PROVISIONING';

/** The parts of a stored mysql:// URL, percent-decoded. Throws on anything else. */
const parseConnUrl = (value) => {
  const u = new URL(value);
  if (u.protocol !== 'mysql:') throw new Error('not a mysql:// URL');
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new Error('no database name');
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: u.port,
    database,
  };
};

/** The same URL with only the password replaced, in the shape provisioning writes. */
const rebuildUrl = (value, { password }) => {
  const u = new URL(value);
  const auth = `${u.username}:${encodeURIComponent(password)}`;
  return `mysql://${auth}@${u.host}${u.pathname}${u.search}`;
};

const where = (p) => `${p.host}${p.port ? `:${p.port}` : ''}/${p.database}`;

/** Opens the database the way TenantDbManager does and runs SELECT 1. Never throws. */
const canConnect = async (connUrl) => {
  const seq = new Sequelize(connUrl, { dialect: 'mysql', logging: false, pool: { max: 1, min: 0 }, dialectOptions: { connectTimeout: 10000 } });
  try {
    await seq.query('SELECT 1');
    return true;
  } catch (_) {
    return false;
  } finally {
    await seq.close().catch(() => {});
  }
};

/**
 * @param {{ apply?: boolean, env?: object, log?: Function, tenantIds?: string[], tenantCode?: string }} opts
 * @returns {Promise<{ applied, toRebuild, alreadyCurrent, otherUser, notProvisioned, failures }>}
 */
const run = async ({ apply = false, env = process.env, log = console.log, tenantIds, tenantCode } = {}) => {
  const appUser = env.TENANT_DB_USER;
  const newPassword = env.TENANT_DB_PASS;
  if (!appUser || newPassword === undefined || newPassword === '') {
    throw new Error('Set TENANT_DB_USER and the new TENANT_DB_PASS first (runbook: secrets rotation row 1)');
  }

  const { Tenant } = require('../models/platform');
  const filter = {};
  if (tenantIds) filter.id = tenantIds;
  if (tenantCode) filter.tenantCode = tenantCode;
  const tenants = await Tenant.findAll({
    where: filter,
    attributes: ['id', 'tenantCode', 'dbName', 'connectionStringEncrypted'],
    order: [['tenantCode', 'ASC']],
  });

  log(`Rebuild tenant connection strings (${apply ? 'APPLY' : 'DRY-RUN'}), tenant user ${appUser}, ${tenants.length} tenant(s)`);
  const result = { applied: false, toRebuild: 0, alreadyCurrent: 0, otherUser: 0, notProvisioned: 0, failures: [] };
  const updates = [];
  const fail = (t, reason, detail) => {
    result.failures.push({ tenantId: t.id, tenantCode: t.tenantCode, reason });
    log(`  ${t.tenantCode}  FAIL ${reason}${detail ? ` (${detail})` : ''}`);
  };

  for (const t of tenants) {
    const value = t.connectionStringEncrypted;
    if (!value || value === PENDING) {
      result.notProvisioned += 1;
      continue;
    }
    let current;
    let parts;
    try {
      current = decrypt(value);
      parts = parseConnUrl(current);
    } catch (_) {
      fail(t, 'unreadable', 'TENANT_CONN_ENCRYPTION_KEY cannot read it');
      continue;
    }
    if (parts.user !== appUser) {
      result.otherUser += 1;
      log(`  ${t.tenantCode}  ${where(parts)}  user=${parts.user}  LEFT ALONE (not ${appUser})`);
      continue;
    }
    if (!t.dbName || t.dbName !== parts.database) {
      fail(t, 'db_name_mismatch', `stored ${parts.database}, tenants.db_name ${t.dbName || 'empty'}`);
      continue;
    }
    if (parts.password === newPassword) {
      result.alreadyCurrent += 1;
      log(`  ${t.tenantCode}  ${where(parts)}  user=${parts.user}  ALREADY CURRENT`);
      continue;
    }
    const next = rebuildUrl(current, { password: newPassword });
    const check = parseConnUrl(next);
    if (check.user !== parts.user || check.host !== parts.host || check.port !== parts.port || check.database !== parts.database || check.password !== newPassword) {
      fail(t, 'rebuild_mismatch');
      continue;
    }
    if (!(await canConnect(next))) {
      fail(t, 'cannot_connect', 'the new password does not open this database');
      continue;
    }
    const encrypted = encrypt(next);
    if (decrypt(encrypted) !== next) {
      fail(t, 'encrypt_round_trip');
      continue;
    }
    result.toRebuild += 1;
    updates.push({ id: t.id, encrypted });
    log(`  ${t.tenantCode}  ${where(parts)}  user=${parts.user}  REBUILD (new password connects)`);
  }

  log(`  ${result.toRebuild} to rebuild, ${result.alreadyCurrent} already current, ${result.otherUser} other user, ${result.notProvisioned} not provisioned, ${result.failures.length} failed`);
  if (result.failures.length) {
    log('Nothing was written. Fix the failures above and run again.');
    return result;
  }
  if (!apply) {
    log('Dry run only. Nothing was written. Re-run with --apply.');
    return result;
  }

  await Tenant.sequelize.transaction(async (transaction) => {
    for (const u of updates) {
      await Tenant.update({ connectionStringEncrypted: u.encrypted }, { where: { id: u.id }, transaction, hooks: false });
    }
  });
  const { safeRedisDel } = require('../config/redis.config');
  for (const u of updates) await safeRedisDel(`tenant:${u.id}:connStr`);
  result.applied = true;
  log(`Done: ${updates.length} rebuilt. Now restart the API (iisreset) so no pool keeps the old connection.`);
  return result;
};

async function main() {
  require('dotenv').config();
  const apply = process.argv.includes('--apply');
  const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
  const { sequelize } = require('../database/platform');
  await sequelize.authenticate();
  try {
    const result = await run({ apply, tenantCode: tenantArg ? tenantArg.slice('--tenant='.length) : undefined });
    return result.failures.length ? 1 : 0;
  } finally {
    await sequelize.close().catch(() => {});
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Rebuild stopped:', err.message);
      process.exit(1);
    });
}

module.exports = { run, parseConnUrl, rebuildUrl };
