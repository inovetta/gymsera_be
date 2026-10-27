/**
 * READ-ONLY SQL check runner (NEW-124).
 *
 * Runs a .sql file (for example docs/sql/new-124-tenant-schema-check.sql) against the
 * PLATFORM database with the app's own settings (PLATFORM_DB_* in .env, the same
 * src/config/database.config.js the API uses), for servers without a mysql client.
 * Prints each result grid as a plain table.
 *
 * Usage, from the app folder (the one holding server.js and .env):
 *   node src/scripts/run-sql-check.js docs/sql/new-124-tenant-schema-check.sql
 *
 * Guard: the whole file is checked before connecting. Allowed: SELECT; SET of user variables
 * (@x) or a short list of session variables; PREPARE of a SELECT (a literal, or a user
 * variable whose value is read and checked just before it is prepared); EXECUTE of a
 * prepared name; DEALLOCATE PREPARE. Anything else, a second statement hidden in one, a
 * MySQL executable comment, SELECT ... INTO, locking reads, and side-effect functions
 * (SLEEP, GET_LOCK, LOAD_FILE, ...) are refused. MySQL enforces it as well: the session runs
 * in a READ ONLY transaction that is rolled back at the end.
 *
 * Output: no password or user name; columns whose name suggests personal data (names,
 * e-mail, phone, address, ...) print as [hidden]; every value passes the SEC-07 redaction.
 *
 * Exit codes: 0 done, 1 database error, 2 refused, 3 not configured / bad arguments.
 */
const fs = require('fs');
const path = require('path');

// ── Splitting ────────────────────────────────────────────────────────────────

/**
 * Splits SQL text into statements on `;` outside strings, identifiers and comments.
 * Plain comments are dropped; MySQL executable comments (`/*! ... *\/`) are kept so the
 * guard can refuse them. Returns [{ text, line }] (line = 1-based start line).
 */
const splitStatements = (sql) => {
  const statements = [];
  let current = '';
  let line = 1;
  let startLine = null;
  let i = 0;
  const push = () => {
    const text = current.trim();
    if (text) statements.push({ text, line: startLine });
    current = '';
    startLine = null;
  };
  const add = (s) => {
    if (startLine === null && s.trim()) startLine = line;
    current += s;
  };
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '\n') line += 1;
    if ((ch === '-' && next === '-' && /\s/.test(sql[i + 2] || ' ')) || ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      const body = sql.slice(i, stop);
      if (sql[i + 2] === '!') add(body); // executable comment: keep, the guard refuses it
      else add(' ');
      line += (body.match(/\n/g) || []).length;
      i = stop;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && ch !== '`') {
          j += 2;
          continue;
        }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      const piece = sql.slice(i, j + 1);
      add(piece);
      line += (piece.match(/\n/g) || []).length;
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      push();
      i += 1;
      continue;
    }
    add(ch);
    i += 1;
  }
  push();
  return statements;
};

// ── Guard ────────────────────────────────────────────────────────────────────

/**
 * One statement reduced for checking: comments removed, each string literal replaced by
 * `?` (values kept in `literals`), each backtick identifier by `ID`. `executable` is true
 * when a MySQL executable comment was found.
 */
const skeletonOf = (text) => {
  let out = '';
  const literals = [];
  let executable = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if ((ch === '-' && next === '-' && /\s/.test(text[i + 2] || ' ')) || ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      if (text[i + 2] === '!') executable = true;
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1;
      let value = '';
      let hasBackslash = false;
      while (j < text.length) {
        if (text[j] === '\\' && ch !== '`') {
          hasBackslash = true;
          value += text[j + 1] || '';
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          if (text[j + 1] === ch) {
            value += ch;
            j += 2;
            continue;
          }
          break;
        }
        value += text[j];
        j += 1;
      }
      if (ch === '`') out += ' ID ';
      else {
        literals.push({ value, hasBackslash });
        out += ' ? ';
      }
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { skeleton: out.replace(/\s+/g, ' ').trim(), literals, executable };
};

const FORBIDDEN_FUNCTIONS = [
  'SLEEP', 'BENCHMARK', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'IS_USED_LOCK', 'LOAD_FILE',
  'MASTER_POS_WAIT', 'SOURCE_POS_WAIT', 'WAIT_FOR_EXECUTED_GTID_SET', 'WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS',
];
const FORBIDDEN_FUNCTION_RE = new RegExp(`\\b(${FORBIDDEN_FUNCTIONS.join('|')})\\s*\\(`, 'i');

// Session variables a check may tune. Anything that could switch the read-only guard off
// (transaction_read_only, autocommit, ...) is not on the list.
const SESSION_VARIABLES = new Set([
  'group_concat_max_len', 'sql_mode', 'max_execution_time', 'sql_select_limit', 'max_join_size',
  'sql_big_selects', 'time_zone', 'div_precision_increment',
]);

/** Refusal reasons common to SELECT bodies and SET expressions. */
const expressionProblem = (upper) => {
  if (/\bINTO\b/.test(upper)) return 'SELECT ... INTO is not allowed';
  if (/\bFOR\s+(UPDATE|SHARE)\b/.test(upper) || /\bLOCK\s+IN\s+SHARE\s+MODE\b/.test(upper)) return 'locking reads are not allowed';
  const fn = upper.match(FORBIDDEN_FUNCTION_RE);
  if (fn) return `function ${fn[1].toUpperCase()}() is not allowed`;
  return null;
};

/** Splits on commas outside parentheses. */
const topLevelParts = (s) => {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
};

const refuse = (reason) => ({ ok: false, reason });

/**
 * Checks one statement. Returns { ok: true, kind, ... } or { ok: false, reason }.
 * kind: select | set | prepare (name, source 'literal' | 'variable', variable) | execute (name) | deallocate (name)
 */
const checkStatement = (text) => {
  const { skeleton, literals, executable } = skeletonOf(String(text));
  if (executable) return refuse('MySQL executable comments (/*! ... */) are not allowed');
  if (!skeleton) return refuse('empty statement');
  if (skeleton.includes(';')) return refuse('more than one statement');
  const upper = skeleton.toUpperCase();

  // SELECT, optionally in parentheses (UNION of parenthesised SELECTs)
  if (/^\(*\s*SELECT\b/.test(upper)) {
    const problem = expressionProblem(upper);
    return problem ? refuse(problem) : { ok: true, kind: 'select' };
  }

  if (/^SET\b/.test(upper)) {
    const body = skeleton.slice(3).trim();
    if (!body) return refuse('empty SET');
    for (const part of topLevelParts(body)) {
      const userVar = part.match(/^@[A-Za-z0-9_$.]+\s*:?=\s*(.+)$/s);
      const session = part.match(/^(?:(?:SESSION|LOCAL)\s+|@@(?:SESSION|LOCAL)\.)([A-Za-z_]+)\s*=\s*(.+)$/is);
      if (userVar) {
        const problem = expressionProblem(userVar[1].toUpperCase());
        if (problem) return refuse(problem);
      } else if (session) {
        if (!SESSION_VARIABLES.has(session[1].toLowerCase())) return refuse(`SET of session variable ${session[1]} is not allowed`);
        const problem = expressionProblem(session[2].toUpperCase());
        if (problem) return refuse(problem);
      } else {
        return refuse('SET is allowed only for @user variables or an explicit SESSION variable from the allowed list');
      }
    }
    return { ok: true, kind: 'set' };
  }

  const prepare = skeleton.match(/^PREPARE\s+([A-Za-z_][A-Za-z0-9_]*)\s+FROM\s+(.+)$/i);
  if (prepare) {
    const [, name, from] = prepare;
    if (from === '?' && literals.length === 1) {
      if (literals[0].hasBackslash) return refuse('PREPARE text with backslash escapes is not allowed');
      const inner = checkStatement(literals[0].value);
      if (!inner.ok) return refuse(`PREPARE: ${inner.reason}`);
      if (inner.kind !== 'select') return refuse('PREPARE is allowed only for a SELECT');
      return { ok: true, kind: 'prepare', name: name.toLowerCase(), source: 'literal' };
    }
    const variable = from.match(/^@([A-Za-z0-9_$.]+)$/);
    if (variable) return { ok: true, kind: 'prepare', name: name.toLowerCase(), source: 'variable', variable: variable[1] };
    return refuse('PREPARE ... FROM must be a string or one @user variable');
  }

  const execute = skeleton.match(/^EXECUTE\s+([A-Za-z_][A-Za-z0-9_]*)(\s+USING\s+@[A-Za-z0-9_$.]+(\s*,\s*@[A-Za-z0-9_$.]+)*)?$/i);
  if (execute) return { ok: true, kind: 'execute', name: execute[1].toLowerCase() };

  const deallocate = skeleton.match(/^DEALLOCATE\s+PREPARE\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (deallocate) return { ok: true, kind: 'deallocate', name: deallocate[1].toLowerCase() };

  return refuse('only SELECT, SET, and PREPARE / EXECUTE / DEALLOCATE of a SELECT are allowed');
};

/** Checks a whole file. Returns { statements, refused }; nothing runs if refused is not empty. */
const checkFile = (sql) => {
  const statements = [];
  const refused = [];
  const prepared = new Set();
  for (const { text, line } of splitStatements(sql)) {
    const result = checkStatement(text);
    if (!result.ok) {
      refused.push({ line, text, reason: result.reason });
      continue;
    }
    if (result.kind === 'prepare') prepared.add(result.name);
    if (result.kind === 'execute' && !prepared.has(result.name)) {
      refused.push({ line, text, reason: `EXECUTE ${result.name}: not prepared earlier in this file` });
      continue;
    }
    if (result.kind === 'deallocate') prepared.delete(result.name);
    statements.push({ ...result, text, line });
  }
  return { statements, refused };
};

// ── Output ───────────────────────────────────────────────────────────────────

// Column names whose values may be personal data or secrets. Structural names are allowed.
const SENSITIVE_COLUMN = /(pass|secret|token|hash|salt|key|email|e_mail|phone|mobile|whatsapp|cnic|national|address|street|postal|zip|birth|dob|ip_?addr|latitude|longitude|card|iban|account|name)/i;
const STRUCTURAL_COLUMNS = new Set([
  'tenant_code', 'db_name', 'table_name', 'column_name', 'missing_column', 'schema_name', 'table_schema',
  'index_name', 'constraint_name', 'has_schema_migrations', 'has_branches_currency',
]);
const isHiddenColumn = (name) => !STRUCTURAL_COLUMNS.has(String(name).toLowerCase()) && SENSITIVE_COLUMN.test(String(name));

let redactString = (s) => s;
try {
  ({ redactString } = require('../utils/log-redaction'));
} catch (_) {
  // the redaction module is part of the app; this only guards a partial copy of the script
}

const cell = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) return '[binary]';
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return redactString(text).replace(/[\r\n\t]+/g, ' ');
};

/** Formats rows as a plain text table. */
const formatTable = (columns, rows) => {
  const hidden = columns.map(isHiddenColumn);
  const body = rows.map((row) => columns.map((c, i) => (hidden[i] ? '[hidden]' : cell(row[c]))));
  const widths = columns.map((c, i) => Math.max(String(c).length, ...body.map((r) => r[i].length)));
  const fmt = (cells) => `| ${cells.map((v, i) => String(v).padEnd(widths[i])).join(' | ')} |`;
  const rule = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const lines = [rule, fmt(columns), rule, ...body.map(fmt), rule];
  const hiddenNames = columns.filter((_, i) => hidden[i]);
  if (hiddenNames.length) lines.push(`Hidden columns (may hold personal data): ${hiddenNames.join(', ')}`);
  return `${lines.join('\n')}\n`;
};

// ── Running ──────────────────────────────────────────────────────────────────

/**
 * One connection (user variables and prepared statements live on a connection) with the
 * app's platform settings, inside a READ ONLY transaction. The caller rolls back and ends it.
 */
const openReadOnlyConnection = async () => {
  const mysql = require('mysql2/promise');
  const { platform } = require('../config/database.config');
  const conn = await mysql.createConnection({
    host: platform.host,
    port: platform.port,
    user: platform.username,
    password: platform.password,
    database: platform.database,
    multipleStatements: false,
    dateStrings: true,
    connectTimeout: 20000,
  });
  await conn.query('SET SESSION TRANSACTION READ ONLY');
  await conn.query('START TRANSACTION READ ONLY');
  return conn;
};

const safeError = (err) => redactString(`${err.code || err.name || 'Error'}: ${err.sqlMessage || err.message || err}`);

/**
 * Checks and runs one .sql file. `write` receives the output. Returns the exit code.
 * `progress` is filled while it runs (statement, line, finished) so the CLI can say where a run
 * that ended without finishing stopped (NEW-128).
 */
const run = async ({ sqlPath, write = (s) => process.stdout.write(s), progress = {} } = {}) => {
  if (!sqlPath || !fs.existsSync(sqlPath)) {
    write(`Usage: node src/scripts/run-sql-check.js <file.sql>\n${sqlPath ? `File not found: ${sqlPath}\n` : ''}`);
    return 3;
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const { statements, refused } = checkFile(sql);
  write(`Read-only SQL check: ${path.basename(sqlPath)} (${statements.length + refused.length} statements)\n`);
  if (refused.length) {
    for (const r of refused) write(`REFUSED line ${r.line}: ${r.reason}\n  ${r.text.replace(/\s+/g, ' ').slice(0, 160)}\n`);
    write('Nothing was run.\n');
    return 2;
  }
  if (!statements.length) {
    write('No statements in the file. Nothing was run.\n');
    return 3;
  }

  const { platform, missingDatabaseSettings } = require('../config/database.config');
  if (missingDatabaseSettings().includes('PLATFORM_DB_PASS')) {
    // Names only, never values.
    const names = ['PLATFORM_DB_HOST', 'PLATFORM_DB_PORT', 'PLATFORM_DB_NAME', 'PLATFORM_DB_USER', 'PLATFORM_DB_PASS'];
    const present = names.filter((n) => process.env[n] !== undefined);
    write(
      `PLATFORM_DB_PASS is not set in ${path.join(__dirname, '..', '..', '.env')} or in this shell's environment.\n` +
        `The API reads ${names.join(', ')}. Set here: ${present.length ? present.join(', ') : 'none'}.\n` +
        'Nothing was run.\n'
    );
    return 3;
  }

  write(`Connecting to the platform database ${platform.database} on ${platform.host}:${platform.port} (read-only)\n\n`);
  let conn;
  let grid = 0;
  try {
    progress.stage = 'connecting';
    conn = await openReadOnlyConnection();
    for (const [index, st] of statements.entries()) {
      Object.assign(progress, { stage: 'statement', index: index + 1, total: statements.length, line: st.line });
      if (st.kind === 'prepare' && st.source === 'variable') {
        const [[row]] = await conn.query(`SELECT @${st.variable} AS q`);
        const value = row && row.q !== null && row.q !== undefined ? String(row.q) : '';
        const inner = checkStatement(value);
        if (!inner.ok || inner.kind !== 'select') {
          write(`REFUSED line ${st.line}: PREPARE ${st.name} FROM @${st.variable}: ${inner.ok ? 'not a SELECT' : inner.reason}\n`);
          write('Stopped. Nothing after this line was run; the session was rolled back.\n');
          return 2;
        }
      }
      let result;
      let fields;
      const startedAt = Date.now();
      try {
        [result, fields] = await conn.query(st.text);
      } catch (err) {
        write(`ERROR line ${st.line}: ${safeError(err)}\nStopped; the session was rolled back.\n`);
        return 1;
      }
      if ((st.kind === 'select' || st.kind === 'execute') && Array.isArray(result)) {
        grid += 1;
        const columns = result.length ? Object.keys(result[0]) : (fields || []).map((f) => f.name);
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        write(`Grid ${grid} (line ${st.line}): ${result.length} row${result.length === 1 ? '' : 's'} in ${seconds} s\n`);
        write(formatTable(columns, result));
        write('\n');
      }
    }
    progress.stage = 'done';
    write(`Done: ${grid} grid${grid === 1 ? '' : 's'}. Nothing was changed (read-only session, rolled back).\n`);
    return 0;
  } catch (err) {
    write(`ERROR: ${safeError(err)}\n`);
    return 1;
  } finally {
    if (conn) {
      try {
        await conn.query('ROLLBACK');
      } catch (_) {
        // the connection may already be gone
      }
      await conn.end().catch(() => {});
    }
  }
};

/**
 * NEW-128: what to print when the process is ending but `run` never returned. A MySQL link that
 * disappears without an 'error' event leaves the query promise pending and nothing else alive,
 * so Node simply exits (code 0, no output) — grid 1, then silence, on production.
 */
const unfinishedMessage = (progress, cause) => {
  const where = progress.stage === 'statement'
    ? `while running line ${progress.line} (statement ${progress.index} of ${progress.total})`
    : `while ${progress.stage || 'starting'}`;
  const why = cause ? safeError(cause) : 'the database connection ended without an error';
  return `ERROR: the run ended before it finished, ${where}: ${why}.\n` +
    'Nothing was changed (read-only session). Run it again; if it stops at the same line, send this whole output.\n';
};

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
  const file = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const progress = {};
  let returned = false;
  let reported = false;
  const fail = (cause) => {
    if (returned || reported) return;
    reported = true;
    // Synchronous: the process is about to end.
    fs.writeSync(1, unfinishedMessage(progress, cause));
    process.exitCode = 1;
  };
  process.on('beforeExit', () => fail(null));
  process.on('uncaughtException', (err) => { fail(err); process.exit(1); });
  process.on('unhandledRejection', (err) => { fail(err); process.exit(1); });
  run({ sqlPath: file, progress }).then(
    (code) => {
      returned = true;
      process.exitCode = code;
    },
    (err) => fail(err)
  );
}

module.exports = { splitStatements, checkStatement, checkFile, formatTable, isHiddenColumn, openReadOnlyConnection, run, unfinishedMessage };
