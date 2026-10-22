/**
 * Platform data reset (launch preparation; spec §16 "Before adding real data").
 *
 * Empties the PLATFORM database down to an allow-list and, only on request, drops the per-tenant databases named in
 * the `tenants` table. DESTRUCTIVE: the CLI (src/scripts/reset-platform-data.js) is a dry run unless it is given
 * --confirm together with the database name and host it is about to change. Tested only on the local Docker MySQL.
 *
 * Kept:   schema_migrations, billing_plans, billing_plan_prices, platform_packages, cities, areas,
 *         and the platform admin users named with --keep-admin.
 * Emptied: every other base table in the platform database.
 * Tenant databases: dropped only with dropTenantDatabases, only the names found in `tenants.dbName`, each one logged.
 *
 * Not covered here (the day-of runbook lists them): object storage (R2), Redis, push tokens held by Firebase.
 */
const fs = require('fs');
const path = require('path');

const KEEP_TABLES = Object.freeze([
  'schema_migrations',
  'billing_plans',
  'billing_plan_prices',
  'platform_packages',
  'cities',
  'areas',
]);
const USERS_TABLE = 'users';
const SYSTEM_SCHEMAS = Object.freeze(['mysql', 'information_schema', 'performance_schema', 'sys']);
const SAFE_DB_NAME = /^[A-Za-z0-9_]{1,64}$/;

const refusal = (message, code) => Object.assign(new Error(message), { code, refusal: true });

/** Writes JSON lines to a file and echoes them; the log holds ids, names and counts, never e-mails or secrets. */
const createLog = ({ logDir, now = () => new Date(), echo = true } = {}) => {
  const entries = [];
  let file = null;
  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    file = path.join(logDir, `reset-${now().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  }
  const write = (event) => {
    const entry = { at: now().toISOString(), ...event };
    entries.push(entry);
    if (file) fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    if (echo) console.log(`[reset] ${JSON.stringify(entry)}`);
  };
  return { write, entries, file };
};

/** The target the caller says it is changing must be the one the configuration points at. */
const assertTarget = ({ db, host }, config) => {
  if (!db || !host) throw refusal('--db and --host are required with --confirm', 'target_required');
  if (db !== config.database) {
    throw refusal(`--db ${db} does not match the configured platform database ${config.database}`, 'db_mismatch');
  }
  if (host !== config.host) {
    throw refusal(`--host ${host} does not match the configured platform host ${config.host}`, 'host_mismatch');
  }
};

const normalizeEmails = (list) =>
  [...new Set((list || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];

/**
 * Reads the platform database and says what a reset would do. Changes nothing.
 * @param {import('mysql2/promise').Connection} conn  connection to the platform database
 */
const planReset = async (conn, { keepAdmins }) => {
  const emails = normalizeEmails(keepAdmins);
  if (emails.length === 0) throw refusal('--keep-admin is required: name at least one platform admin to keep', 'keep_admin_required');

  const [tables] = await conn.query(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = \'BASE TABLE\' ORDER BY table_name'
  );
  const names = tables.map((t) => t.name || t.NAME || t.TABLE_NAME);

  const [admins] = await conn.query(
    `SELECT id, LOWER(email) AS email, role FROM \`${USERS_TABLE}\` WHERE LOWER(email) IN (?)`,
    [emails]
  );
  const found = new Set(admins.map((a) => a.email));
  const missing = emails.filter((e) => !found.has(e));
  if (missing.length) throw refusal(`${missing.length} named admin(s) were not found in users; nothing was changed`, 'keep_admin_not_found');
  const notAdmin = admins.filter((a) => a.role !== 'PLATFORM_ADMIN');
  if (notAdmin.length) throw refusal(`${notAdmin.length} named user(s) are not PLATFORM_ADMIN; nothing was changed`, 'keep_admin_not_admin');
  const keepIds = admins.map((a) => a.id);

  const plan = { tables: [], users: null, tenants: [], keepIds };
  for (const name of names) {
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
    if (name === USERS_TABLE) {
      plan.users = { total: Number(n), keep: keepIds.length, remove: Number(n) - keepIds.length };
      plan.tables.push({ name, rows: Number(n), action: 'KEEP_ADMINS_ONLY' });
    } else {
      plan.tables.push({ name, rows: Number(n), action: KEEP_TABLES.includes(name) ? 'KEEP' : 'EMPTY' });
    }
  }
  if (!plan.users) throw refusal('the platform database has no users table; refusing', 'no_users_table');

  if (names.includes('tenants')) {
    const [rows] = await conn.query('SELECT id, status, `dbName` FROM tenants');
    plan.tenants = rows.map((r) => ({ id: r.id, status: r.status, dbName: r.dbName }));
  }
  return plan;
};

const droppableTenantDatabases = (plan, platformDb) =>
  plan.tenants
    .filter((t) => t.dbName)
    .map((t) => ({
      ...t,
      ok: SAFE_DB_NAME.test(t.dbName) && !SYSTEM_SCHEMAS.includes(String(t.dbName).toLowerCase()) && t.dbName !== platformDb,
    }));

/**
 * Runs the reset.
 * @param {object} opts
 * @param {import('mysql2/promise').Connection} opts.conn       platform database connection
 * @param {import('mysql2/promise').Connection} [opts.adminConn] server-level connection, needed only to drop tenant databases
 * @param {{database: string, host: string}} opts.config        what the configuration points at
 * @param {boolean} opts.confirm   false = dry run (the default everywhere)
 */
const runReset = async ({
  conn,
  adminConn = null,
  config,
  keepAdmins,
  confirm = false,
  db = null,
  host = null,
  dropTenantDatabases = false,
  logDir = null,
  echo = true,
  now,
}) => {
  const log = createLog({ logDir, echo, now });
  const mode = confirm ? 'APPLY' : 'DRY_RUN';
  log.write({ event: 'start', mode, database: config.database, host: config.host, dropTenantDatabases });

  if (confirm) assertTarget({ db, host }, config);
  else if (db || host) assertTarget({ db: db || config.database, host: host || config.host }, config);

  const plan = await planReset(conn, { keepAdmins });
  const tenantDbs = droppableTenantDatabases(plan, config.database);
  log.write({
    event: 'plan',
    tables: plan.tables,
    users: plan.users,
    adminIdsKept: plan.keepIds,
    tenantDatabases: tenantDbs.map((t) => ({ tenantId: t.id, status: t.status, dbName: t.dbName, droppable: t.ok })),
  });

  const result = { mode, plan, log, removed: [], droppedDatabases: [], leftInPlace: [] };

  if (!confirm) {
    log.write({ event: 'dry_run_done', note: 'nothing was changed; run again with --confirm --db <name> --host <host> to apply' });
    return result;
  }

  // Platform rows: one transaction, so a failure leaves the database as it was.
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    await conn.beginTransaction();
    for (const t of plan.tables) {
      if (t.action === 'EMPTY') {
        await conn.query(`DELETE FROM \`${t.name}\``);
        result.removed.push({ table: t.name, rows: t.rows });
        log.write({ event: 'emptied', table: t.name, rows: t.rows });
      }
    }
    const [res] = await conn.query(`DELETE FROM \`${USERS_TABLE}\` WHERE id NOT IN (?)`, [plan.keepIds]);
    result.removed.push({ table: USERS_TABLE, rows: res.affectedRows });
    log.write({ event: 'users_removed', rows: res.affectedRows, kept: plan.keepIds.length });
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    log.write({ event: 'failed', where: 'platform_rows', error: err.message });
    throw err;
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
  }

  // Tenant databases: only the names that were in `tenants` before the rows went, each one logged.
  for (const t of tenantDbs) {
    if (!dropTenantDatabases || !adminConn) {
      result.leftInPlace.push(t.dbName);
      log.write({ event: 'tenant_database_left_in_place', tenantId: t.id, dbName: t.dbName });
      continue;
    }
    if (!t.ok) {
      result.leftInPlace.push(t.dbName);
      log.write({ event: 'tenant_database_refused', tenantId: t.id, dbName: t.dbName, reason: 'name is not a safe tenant database name' });
      continue;
    }
    try {
      await adminConn.query(`DROP DATABASE IF EXISTS \`${t.dbName}\``);
      result.droppedDatabases.push(t.dbName);
      log.write({ event: 'tenant_database_dropped', tenantId: t.id, dbName: t.dbName });
    } catch (err) {
      log.write({ event: 'failed', where: 'drop_tenant_database', tenantId: t.id, dbName: t.dbName, error: err.message });
      throw err;
    }
  }

  log.write({ event: 'done', mode, removed: result.removed.length, droppedDatabases: result.droppedDatabases.length });
  return result;
};

module.exports = { runReset, planReset, assertTarget, createLog, KEEP_TABLES, SYSTEM_SCHEMAS };
