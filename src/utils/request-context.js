/**
 * Per-request log context (OBS-01, spec §12.12).
 *
 * One AsyncLocalStorage store per request, opened by
 * `middleware/requestContext.js`. It holds the request id and a reference to
 * the request, so the logger can add `tenantId` and `userId` at the moment a
 * line is written, after authentication has run, without every middleware
 * having to copy them in.
 */
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/** Runs `fn` with a fresh context. */
const run = (context, fn) => storage.run(context, fn);

/** The current context, or undefined outside a request (cron, startup). */
const get = () => storage.getStore();

/**
 * Fields every log line inside a request carries. IDs only: never an e-mail,
 * name or phone number (OBS-01; SEC-07 still redacts the message itself).
 */
const logFields = () => {
  const ctx = storage.getStore();
  if (!ctx) return {};
  const req = ctx.req;
  const userId = req && req.user ? req.user.id || req.user.sub : undefined;
  const tenantId = req && req.tenantId ? req.tenantId : undefined;
  return {
    requestId: ctx.requestId,
    ...(tenantId !== undefined && { tenantId }),
    ...(userId !== undefined && { userId }),
  };
};

module.exports = { run, get, logFields };
