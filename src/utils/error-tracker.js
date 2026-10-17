/**
 * Error tracking with Sentry (OBS-02; OBS-06 sends its alerts through it).
 *
 * INERT without SENTRY_DSN: the SDK is not even loaded, so tests, local runs and any environment
 * without a Sentry project stay offline. With a DSN, `@sentry/node` is loaded and initialised once.
 *
 * What this setup does and does not do, on purpose:
 *  - No default integrations and no OpenTelemetry: nothing in `http`, `express` or the database
 *    drivers is patched, no process handlers are added, no breadcrumbs or performance data are
 *    collected. Errors are reported explicitly (errorHandler 5xx, server.js process handlers, alerts).
 *  - `release` (SENTRY_RELEASE) and `environment` (SENTRY_ENVIRONMENT, else NODE_ENV) come from the env.
 *  - The user id is the only user field. The request id, tenant id and route PATTERN are tags.
 *    Request bodies, headers, cookies, query strings, IP addresses and host names never leave.
 *  - Every event passes `scrubEvent` (the SEC-07 redaction, whitelist style). If scrubbing fails the
 *    event is dropped: fail closed.
 *  - Nothing here may break a request: every public function swallows its own errors, sends are
 *    asynchronous, and `flush` always resolves (false on timeout).
 */
const logRedaction = require('./log-redaction');

let sdk = null;
let warned = false;
let initialised = false;

const warnOnce = (message) => {
  if (warned) return;
  warned = true;
  console.warn(`[ErrorTracker] ${message}`);
};

// ── scrubbing ────────────────────────────────────────────────────────────────

const stripPath = (value) => {
  if (typeof value !== 'string') return value;
  const cwd = process.cwd();
  return value.startsWith(cwd) ? value.slice(cwd.length).replace(/^[\\/]+/, '') : value;
};

const scrubStrings = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  return logRedaction.redact(obj);
};

/**
 * Whitelist-style scrub of one Sentry event. Returns the event to send, or null to drop it.
 * Exported for tests; installed as `beforeSend`.
 */
const scrubEvent = (event) => {
  try {
    const out = { ...event };

    if (typeof out.message === 'string') out.message = logRedaction.redactString(out.message);
    if (out.logentry) {
      out.logentry = {
        ...out.logentry,
        message: typeof out.logentry.message === 'string' ? logRedaction.redactString(out.logentry.message) : out.logentry.message,
        params: undefined,
      };
    }
    if (out.transaction) out.transaction = logRedaction.redactString(String(out.transaction));
    if (out.culprit) out.culprit = logRedaction.redactString(String(out.culprit));

    if (out.exception && Array.isArray(out.exception.values)) {
      out.exception = {
        ...out.exception,
        values: out.exception.values.map((v) => ({
          ...v,
          value: typeof v.value === 'string' ? logRedaction.redactString(v.value) : v.value,
          stacktrace: v.stacktrace && Array.isArray(v.stacktrace.frames)
            ? {
                ...v.stacktrace,
                frames: v.stacktrace.frames.map((f) => ({
                  ...f,
                  filename: stripPath(f.filename),
                  abs_path: stripPath(f.abs_path),
                  vars: undefined,
                  pre_context: undefined,
                  post_context: undefined,
                  context_line: undefined,
                })),
              }
            : v.stacktrace,
        })),
      };
    }

    // The user id and nothing else.
    const userId = out.user && out.user.id !== undefined && out.user.id !== null ? String(out.user.id) : null;
    out.user = userId ? { id: userId } : undefined;

    // Never: request bodies, headers, cookies, query strings, env, host name, installed modules, breadcrumbs.
    delete out.request;
    delete out.server_name;
    delete out.modules;
    delete out.breadcrumbs;
    delete out.spans;

    if (out.contexts) {
      const keep = {};
      for (const k of ['trace', 'runtime']) if (out.contexts[k]) keep[k] = out.contexts[k];
      out.contexts = keep;
    }
    if (out.tags) out.tags = scrubStrings(out.tags);
    if (out.extra) out.extra = scrubStrings(out.extra);

    return out;
  } catch (_) {
    return null; // fail closed: an event that cannot be scrubbed is not sent
  }
};

// ── SDK ──────────────────────────────────────────────────────────────────────

/**
 * Starts the SDK once. Safe to call more than once and with no DSN (returns false).
 * `overrides` is for tests (a fake `transport`); production passes nothing.
 * @returns {boolean} true when events can be sent
 */
const init = (overrides = {}) => {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  if (initialised && sdk) return true;
  try {
    const loaded = require('@sentry/node');
    loaded.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      ...(process.env.SENTRY_RELEASE && { release: process.env.SENTRY_RELEASE }),
      defaultIntegrations: false,
      skipOpenTelemetrySetup: true,
      integrations: [
        loaded.dedupeIntegration(),
        loaded.inboundFiltersIntegration(),
        loaded.linkedErrorsIntegration(),
        loaded.functionToStringIntegration(),
      ],
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      beforeSend: scrubEvent,
      beforeBreadcrumb: () => null,
      beforeSendTransaction: () => null,
      ...overrides,
    });
    sdk = loaded;
    initialised = true;
    const client = typeof loaded.getClient === 'function' ? loaded.getClient() : null;
    // A DSN the SDK could not parse leaves a client with no DSN: nothing can be sent.
    return client && typeof client.getDsn === 'function' ? Boolean(client.getDsn()) : true;
  } catch (err) {
    warnOnce(`SENTRY_DSN is set but the SDK could not start: ${err.message}`);
    return false;
  }
};

const getSdk = () => (process.env.SENTRY_DSN && init() ? sdk : null);

/**
 * Sends a message event (OBS-06 alerts). `extra` must already be IDs and counts.
 * @returns {boolean} true when the SDK accepted it
 */
const captureMessage = (message, { level = 'error', tags = {}, extra = {} } = {}) => {
  const client = getSdk();
  if (!client) return false;
  try {
    client.captureMessage(message, { level, tags, extra });
    return true;
  } catch (err) {
    warnOnce(`captureMessage failed: ${err.message}`);
    return false;
  }
};

/**
 * Reports an error with the context of the request it happened in: user id, request id, tenant id and
 * the route pattern. Never throws.
 * @param {Error} err
 * @param {{ req?: object, tags?: object, extra?: object }} [context]
 * @returns {boolean}
 */
const captureException = (err, { req, tags = {}, extra = {} } = {}) => {
  const client = getSdk();
  if (!client) return false;
  try {
    const userId = req && req.user ? req.user.id || req.user.sub : undefined;
    const contextTags = { ...tags };
    if (req) {
      if (req.id) contextTags.requestId = String(req.id);
      if (req.tenantId) contextTags.tenantId = String(req.tenantId);
      contextTags.route = require('../observability/metrics').routeLabel(req);
    }
    client.captureException(err, {
      ...(userId !== undefined && userId !== null && { user: { id: String(userId) } }),
      tags: contextTags,
      extra,
    });
    return true;
  } catch (captureErr) {
    warnOnce(`captureException failed: ${captureErr.message}`);
    return false;
  }
};

/**
 * Waits (at most `timeoutMs`) for queued events to be sent, e.g. before the process exits.
 * Always resolves: true when everything was sent, false on timeout, failure or no DSN.
 */
const flush = async (timeoutMs = 2000) => {
  if (!sdk || !initialised) return false;
  try {
    return await Promise.race([
      Promise.resolve(sdk.flush(timeoutMs)).then((ok) => Boolean(ok)),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs + 50);
        if (timer.unref) timer.unref();
      }),
    ]);
  } catch (_) {
    return false;
  }
};

const _resetForTests = () => {
  try {
    if (sdk && sdk.getClient && sdk.getClient()) sdk.getClient().close(0);
    if (sdk && sdk.getGlobalScope) sdk.getGlobalScope().clear();
    if (sdk && sdk.getCurrentScope) sdk.getCurrentScope().clear();
  } catch (_) {
    /* test cleanup only */
  }
  sdk = null;
  warned = false;
  initialised = false;
};

module.exports = { init, captureMessage, captureException, flush, scrubEvent, _resetForTests };
