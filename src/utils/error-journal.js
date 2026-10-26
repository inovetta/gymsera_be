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
 * IDs and the route only: never the query string, headers or body. The error message
 * passes through the SEC-07 redaction. A failed write is swallowed: the journal never
 * changes an answer.
 */
const fs = require('fs');
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

const madeDirs = new Set();

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
    const dir = directory();
    if (!dir) return;
    if (!madeDirs.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    }
    const now = new Date();
    const userId = req.user ? req.user.id || req.user.sub : undefined;
    const line = {
      time: now.toISOString(),
      requestId: req.id || res.getHeader('X-Request-Id') || null,
      status: res.statusCode,
      code: res.locals?.errorCode || null,
      method: req.method,
      path: (req.originalUrl || req.url || '').split('?')[0],
      ...(req.tenantId && { tenantId: req.tenantId }),
      ...(userId && { userId }),
      durationMs: startedAt ? Date.now() - startedAt : null,
      ...(res.locals?.journalError && { error: errorFields(res.locals.journalError) }),
    };
    fs.appendFileSync(path.join(dir, `errors-${line.time.slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`);
  } catch (_) {
    // Never let the journal change an answer. The console line still exists.
  }
};

module.exports = { record, directory };
