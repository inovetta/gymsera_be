/**
 * Error-tracking seam (OBS-02 builds on this; OBS-06 uses it for alerts).
 *
 * Does nothing unless SENTRY_DSN is set: the SDK is not even loaded, so tests,
 * local runs and any environment without a Sentry project stay fully offline.
 * With a DSN, `@sentry/node` is loaded on first use and initialised once. A
 * missing package or a failing SDK is logged once and never thrown: telling
 * Sentry about a problem must not create a second problem.
 */
let sdk = null;
let warned = false;

const warnOnce = (message) => {
  if (warned) return;
  warned = true;
  console.warn(`[ErrorTracker] ${message}`);
};

const getSdk = () => {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;
  if (sdk) return sdk;
  try {
    const loaded = require('@sentry/node');
    loaded.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      ...(process.env.SENTRY_RELEASE && { release: process.env.SENTRY_RELEASE }),
    });
    sdk = loaded;
    return sdk;
  } catch (err) {
    warnOnce(`SENTRY_DSN is set but the SDK could not start: ${err.message}`);
    return null;
  }
};

/**
 * Sends a message event. `extra` must already be scrubbed (IDs and counts only).
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

const _resetForTests = () => {
  sdk = null;
  warned = false;
};

module.exports = { captureMessage, _resetForTests };
