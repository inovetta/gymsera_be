/**
 * 5xx error journal (NEW-123).
 *
 * One JSON line per 5xx answer, with the reference id the client shows (`requestId`),
 * appended to `<ERROR_LOG_DIR>/errors-YYYY-MM-DD.jsonl` (UTC date). It does not depend
 * on stdout, iisnode or Sentry, so a reference id from a user can always be looked up.
 *
 *   ERROR_LOG_DIR=<folder>   where the files go
 *   ERROR_LOG_DIR=off        no journal
 *   (unset)                  `logs/` in the app folder when NODE_ENV=production and not on
 *                            Vercel (read-only file system); off everywhere else
 *
 * If that folder cannot be written (on IIS: the app pool identity has no write access),
 * lines go to `<os temp>/gymsera-logs` instead, and the failure is printed once on the
 * console (which reaches iisnode's stdout file). `boot()` writes one line at startup, so a
 * deploy can be checked before any 5xx happens.
 *
 * IDs and the route only: never the query string, headers or body. The error message
 * passes through the SEC-07 redaction. A failed write never changes an answer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redactString } = require('./log-redaction');

const directory = () => {
  const configured = process.env.ERROR_LOG_DIR;
  if (configured) return configured === 'off' ? null : configured;
  if (process.env.NODE_ENV === 'production' && !process.env.VERCEL) {
    return path.join(__dirname, '..', '..', 'logs');
  }
  return null;
};

const fallbackDirectory = () => path.join(os.tmpdir(), 'gymsera-logs');

const madeDirs = new Set();
const reported = new Set();

const appendTo = (dir, file, text) => {
  if (!madeDirs.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    madeDirs.add(dir);
  }
  const target = path.join(dir, file);
  fs.appendFileSync(target, text);
  return target;
};

/** Prints a journal failure once per folder and error code, so it is never silent. */
const reportOnce = (dir, err, fallback) => {
  const key = `${dir}|${err && err.code}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.error(
    `[ErrorJournal] cannot write to ${dir}: ${(err && (err.code || err.message)) || err}` +
      (fallback ? `; writing to ${fallback} instead` : '; journal line lost')
  );
};

/**
 * Appends one line to today's file. Returns the file written, or null.
 * Tries the configured folder, then the temp folder. Never throws.
 */
const append = (line) => {
  const dir = directory();
  if (!dir) return null;
  const file = `errors-${String(line.time).slice(0, 10)}.jsonl`;
  const text = `${JSON.stringify(line)}\n`;
  try {
    return appendTo(dir, file, text);
  } catch (err) {
    const fallback = fallbackDirectory();
    if (path.resolve(fallback) === path.resolve(dir)) {
      reportOnce(dir, err, null);
      return null;
    }
    try {
      const written = appendTo(fallback, file, text);
      reportOnce(dir, err, fallback);
      return written;
    } catch (fallbackErr) {
      reportOnce(dir, err, null);
      reportOnce(fallback, fallbackErr, null);
      return null;
    }
  }
};

/** The error behind the answer, as errorHandler left it on `res.locals`. */
const errorFields = (err) => {
  if (!err) return undefined;
  const sqlMessage = err.original?.sqlMessage || err.parent?.sqlMessage;
  return {
    name: err.name || 'Error',
    message: redactString(String(err.message || '')).slice(0, 1000),
    ...(sqlMessage && { sqlMessage: redactString(String(sqlMessage)).slice(0, 1000) }),
  };
};

/**
 * Appends the line for one finished 5xx response. Called from the response's `finish`
 * event (middleware/requestContext.js).
 */
const record = (req, res, startedAt) => {
  try {
    if (!directory()) return;
    const userId = req.user ? req.user.id || req.user.sub : undefined;
    append({
      time: new Date().toISOString(),
      requestId: req.id || res.getHeader('X-Request-Id') || null,
      status: res.statusCode,
      code: res.locals?.errorCode || null,
      method: req.method,
      path: (req.originalUrl || req.url || '').split('?')[0],
      ...(req.tenantId && { tenantId: req.tenantId }),
      ...(userId && { userId }),
      durationMs: startedAt ? Date.now() - startedAt : null,
      ...(res.locals?.journalError && { error: errorFields(res.locals.journalError) }),
    });
  } catch (_) {
    // Never let the journal change an answer.
  }
};

/**
 * Startup line (server.js): written to the journal and printed on the console, so after a
 * deploy both the iisnode stdout file and the journal file show this process started.
 * Returns the file written, or null.
 */
const boot = () => {
  try {
    const dir = directory();
    const time = new Date().toISOString();
    // NEW-130: which build this process loaded, since when, and which platform database it uses.
    const { getBuildInfo, STARTED_AT } = require('./build-info');
    const build = getBuildInfo();
    const platform = require('../config/database.config').resolvePlatformDbName();
    const platformDb = `${platform.name} (${platform.source})`;
    const written = dir
      ? append({ time, event: 'boot', pid: process.pid, node: process.version, commit: build.commit, builtAt: build.builtAt, platformDb: platform.name, platformDbSource: platform.source })
      : null;
    console.log(
      `[ErrorJournal] boot pid=${process.pid} node=${process.version} NODE_ENV=${process.env.NODE_ENV || '(unset)'} ` +
        `commit=${build.commit.slice(0, 12)} built=${build.builtAt || 'unknown'} started=${STARTED_AT} platformDb=${platformDb} ` +
        (dir ? `journal=${written || `NOT WRITTEN (${dir})`}` : 'journal=off')
    );
    return written;
  } catch (_) {
    return null;
  }
};

module.exports = { record, boot, directory, fallbackDirectory };
