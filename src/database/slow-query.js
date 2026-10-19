/**
 * In-app slow query log (OBS-04, spec §12.12): a FALLBACK for hosting where MySQL's own
 * `slow_query_log` cannot be switched on. The primary tool is the server setting; see
 * docs/runbooks/slow-queries.md.
 *
 * OFF unless SLOW_QUERY_MS is a positive integer. When on, Sequelize measures each query
 * (`benchmark: true`) and one that took at least that many milliseconds is logged as
 *   { source: 'slow-query', db, durationMs, thresholdMs, fingerprint, shape, suppressed }
 * Nothing else. Sequelize hands its logger the SQL with the parameters already substituted, so the raw
 * text would carry e-mails, phone numbers, ids and tokens; `statementShape` replaces every literal with
 * `?` first, and the raw SQL is never logged. At most one line per fingerprint per 10 s, with a count
 * of what was held back, so an incident cannot flood the log.
 *
 * Covers the platform connection and the tenant pools (the request paths). Migrations and scripts
 * create their own connections and are not included: long DDL is expected there.
 */
const crypto = require('crypto');
const { logger } = require('../utils/logger');
const logRedaction = require('../utils/log-redaction');

const MAX_SHAPE_LENGTH = 300;
const MAX_INPUT_LENGTH = 20000; // bounds the work on a huge statement
const WINDOW_MS = 10 * 1000;
const MAX_TRACKED = 500;

/** The threshold in ms, or null when the fallback is off (unset, empty, 0, negative, not a whole number). */
const thresholdMs = (raw = process.env.SLOW_QUERY_MS) => {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!/^[1-9]\d{0,6}$/.test(value)) return null;
  return parseInt(value, 10);
};

// Everything that can carry data, matched left to right so the earliest token wins. Backtick identifiers
// are kept as they are (table and column names are the point); everything else becomes `?` or nothing.
// Each quote kind has a terminated form first and an unterminated one last, which swallows the rest of
// the statement rather than letting it through.
const TOKEN = new RegExp(
  [
    '`(?:[^`]|``)*`', // 1 identifier (kept)
    '/\\*[\\s\\S]*?\\*/', // 2 block comment (dropped)
    '/\\*[\\s\\S]*$', //  unterminated block comment
    '--[^\\n]*', //  line comment
    '#[^\\n]*', //  line comment
    '\\b[xX]\'[0-9a-fA-F]*\'', //  hex literal
    '\'(?:[^\'\\\\]|\\\\[\\s\\S]|\'\')*\'', //  string
    '"(?:[^"\\\\]|\\\\[\\s\\S]|"")*"', //  string
    '\'[\\s\\S]*$', //  unterminated string
    '"[\\s\\S]*$', //  unterminated string
    '`[\\s\\S]*$', //  unterminated identifier
    '\\b0[xX][0-9a-fA-F]+\\b', //  hex number
    '\\$\\d+', //  bind placeholder
    '(?<![\\w.`$])[-+]?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?\\b', //  number
  ].join('|'),
  'g'
);

/**
 * The statement with every literal replaced by `?`: `SELECT * FROM users WHERE email = ? AND id IN (?)`.
 * Never throws; non-strings give ''.
 */
const statementShape = (sql) => {
  try {
    if (typeof sql !== 'string') return '';
    let s = sql.length > MAX_INPUT_LENGTH ? sql.slice(0, MAX_INPUT_LENGTH) : sql;
    s = s.replace(/^\s*Execut(?:ed|ing) \([^)]*\):\s*/, '');
    s = s.replace(TOKEN, (token) => {
      if (token[0] === '`' && token.length > 1 && token[token.length - 1] === '`') return token;
      if (token.startsWith('/*') || token.startsWith('--') || token[0] === '#') return ' ';
      return '?';
    });
    s = s
      .replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, '(?)') // IN (?, ?, ?) and one VALUES row
      .replace(/\(\?\)(?:\s*,\s*\(\?\))+/g, '(?)') // many VALUES rows
      .replace(/\s+/g, ' ')
      .trim();
    if (s.length > MAX_SHAPE_LENGTH) s = `${s.slice(0, MAX_SHAPE_LENGTH)}...`;
    return logRedaction.redactString(s);
  } catch (_) {
    return '';
  }
};

const fingerprintOf = (shape) => crypto.createHash('sha1').update(shape).digest('hex').slice(0, 10);

// fingerprint -> { at, suppressed }; bounded, oldest dropped first
const seen = new Map();

const onQuery = (db, sql, timing, threshold) => {
  if (typeof timing !== 'number' || !(timing >= threshold)) return;
  const shape = statementShape(sql);
  const fingerprint = fingerprintOf(shape);
  const now = Date.now();
  const entry = seen.get(fingerprint);
  if (entry && now - entry.at < WINDOW_MS) {
    entry.suppressed += 1;
    return;
  }
  const suppressed = entry ? entry.suppressed : 0;
  if (!entry && seen.size >= MAX_TRACKED) seen.delete(seen.keys().next().value);
  seen.set(fingerprint, { at: now, suppressed: 0 });
  logger.warn(
    { source: 'slow-query', db, durationMs: Math.round(timing), thresholdMs: threshold, fingerprint, shape, suppressed },
    'slow query'
  );
};

/**
 * Sequelize constructor options for one connection: `{}` when the fallback is off (no benchmarking, no
 * overhead, nothing changes), else `{ benchmark: true, logging }`. A logging function the connection
 * already had (development SQL echo) is kept. Nothing in here can make a query fail.
 * @param {{ db: 'platform'|'tenant', existingLogging?: Function }} args
 */
const slowQueryOptions = ({ db, existingLogging } = {}) => {
  const threshold = thresholdMs();
  if (threshold === null) return {};
  return {
    benchmark: true,
    logging: (sql, timing) => {
      if (typeof existingLogging === 'function') {
        try {
          existingLogging(sql, timing);
        } catch (_) {
          /* the old logger must not break a query */
        }
      }
      try {
        onQuery(db, sql, timing, threshold);
      } catch (_) {
        /* neither may this one */
      }
    },
  };
};

const _resetForTests = () => seen.clear();
const _trackedFingerprints = () => seen.size;

module.exports = { thresholdMs, statementShape, fingerprintOf, slowQueryOptions, _resetForTests, _trackedFingerprints };
