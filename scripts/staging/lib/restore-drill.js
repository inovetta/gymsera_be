/**
 * Restore drill (spec §17.12): dump the staging platform database and restore it into a scratch database on the
 * same MySQL server, then compare row counts. The ONLY database this ever drops is one named restore_drill_<stamp>
 * that the drill itself created; nothing else, whatever its name looks like.
 */
const { spawn } = require('child_process');

const DRILL_NAME = /^restore_drill_[0-9]{8}_[0-9]{6}$/;
const isDrillDatabaseName = (name) => typeof name === 'string' && DRILL_NAME.test(name);

const drillName = (now = new Date()) => {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `restore_drill_${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}_${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
};

/** Refuses anything that is not a drill database, or that is the source database. */
const assertDroppable = (name, sourceDb) => {
  if (!isDrillDatabaseName(name)) throw Object.assign(new Error(`refusing to drop "${name}": only restore_drill_* databases may be dropped`), { refusal: true });
  if (name === sourceDb) throw Object.assign(new Error('refusing to drop the source database'), { refusal: true });
};

const dropDrillDatabase = async (adminConn, name, sourceDb) => {
  assertDroppable(name, sourceDb);
  await adminConn.query('DROP DATABASE IF EXISTS ??', [name]);
};

const run = (cmd, args, env, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0);
    let err = '';
    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 300)}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

const tableCounts = async (conn, db) => {
  const [tables] = await conn.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = \'BASE TABLE\' ORDER BY table_name', [db]);
  const counts = {};
  for (const t of tables) {
    const name = t.name || t.NAME || t.TABLE_NAME;
    const [[row]] = await conn.query('SELECT COUNT(*) AS n FROM ??.??', [db, name]);
    counts[name] = Number(row.n);
  }
  return counts;
};

/**
 * @param {object} o
 * @param {import('mysql2/promise').Connection} o.adminConn  server-level connection (can create/drop databases)
 * @param {{host: string, port: number, user: string, password: string}} o.server
 * @param {string} o.sourceDb  database to dump
 * @param {boolean} [o.keep]   leave the scratch database in place (otherwise it is dropped at the end)
 * @param {Function} [o.runner] (cmd, args, env, stdin) => Buffer; defaults to the mysqldump/mysql on PATH, which must be a
 *                             client version the server accepts (a MySQL 9 client cannot log in to a 5.7 server)
 */
const restoreDrill = async ({ adminConn, server, sourceDb, keep = false, now = new Date(), runner = run }) => {
  const target = drillName(now);
  const started = Date.now();
  const base = ['-h', server.host, '-P', String(server.port), '-u', server.user];
  const env = { MYSQL_PWD: server.password || '' };
  const result = { target, sourceDb, ok: false, dropped: false, mismatches: [], tables: 0, seconds: 0 };
  await adminConn.query('CREATE DATABASE ?? DEFAULT CHARACTER SET utf8mb4', [target]);
  try {
    const dump = await runner('mysqldump', [...base, '--single-transaction', '--routines', '--no-tablespaces', sourceDb], env);
    await runner('mysql', [...base, target], env, dump);
    const [before, after] = [await tableCounts(adminConn, sourceDb), await tableCounts(adminConn, target)];
    result.tables = Object.keys(before).length;
    for (const [table, n] of Object.entries(before)) {
      if (after[table] !== n) result.mismatches.push({ table, source: n, restored: after[table] ?? null });
    }
    result.ok = result.tables > 0 && result.mismatches.length === 0;
  } finally {
    if (!keep) {
      await dropDrillDatabase(adminConn, target, sourceDb);
      result.dropped = true;
    }
    result.seconds = Math.round((Date.now() - started) / 100) / 10;
  }
  return result;
};

/** Lists leftover drill databases (names only); the CLI drops them only when asked. */
const listDrillDatabases = async (adminConn) => {
  const [rows] = await adminConn.query('SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name LIKE \'restore\\_drill\\_%\' ORDER BY schema_name');
  return rows.map((r) => r.name || r.NAME || r.SCHEMA_NAME).filter(isDrillDatabaseName);
};

module.exports = { run, isDrillDatabaseName, drillName, assertDroppable, dropDrillDatabase, restoreDrill, listDrillDatabases, tableCounts };
