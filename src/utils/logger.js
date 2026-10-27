/**
 * Structured logger (OBS-01, spec §12.12).
 *
 * One JSON object per line with the request context (requestId, tenantId,
 * userId) added automatically. Console output from the whole code base goes
 * through here via `log-redaction.js#sink`, so the SEC-07 redaction runs first
 * and nothing in the ~740 existing `console.*` calls had to change.
 *
 *   LOG_FORMAT=json | text   default json, text when NODE_ENV is development or test
 *   LOG_LEVEL=info           pino level
 */
const fs = require('fs');
const pino = require('pino');
const requestContext = require('./request-context');

const isTextByDefault = ['development', 'test'].includes(process.env.NODE_ENV);
const jsonEnabled = () => (process.env.LOG_FORMAT || (isTextByDefault ? 'text' : 'json')) === 'json';

// Synchronous: on serverless hosts a line written after the response may never be flushed.
// `out.write` is the one place a line leaves the process; tests replace it to read the lines.
// NEW-123: iisnode does not read descriptor 1. Its interceptor (iisnode src/scripts/interceptor.js)
// assigns its own `write` onto the existing process.stdout object, which writes to
// iisnode/<host>-<pid>-stdout-<ts>.txt; `process.stdout.fd` stays 1. So a host-installed `write`
// (an own property; Node's own lives on the prototype) is the signal: write through it.
const out = {
  write: (line) => {
    const stdout = process.stdout;
    if (stdout && Object.prototype.hasOwnProperty.call(stdout, 'write') && typeof stdout.write === 'function') {
      return stdout.write(line);
    }
    return fs.writeSync(1, line);
  },
};

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => requestContext.logFields(),
  },
  { write: (line) => out.write(line) }
);

// console method -> pino level
const LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug', trace: 'trace' };

/** Writes already-redacted console arguments as one JSON line. */
const writeConsole = (method, args) => {
  const first = args[0];
  const message = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}\n${a.stack || ''}` : safeStringify(a)))
    .join(' ');
  logger[LEVELS[method] || 'info']({ source: 'console', ...(first instanceof Error && { err: first.name }) }, message);
};

const safeStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return '[unloggable value]';
  }
};

module.exports = { logger, writeConsole, jsonEnabled, out };
