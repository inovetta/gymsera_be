const requestContext = require('../utils/request-context');
const errorJournal = require('../utils/error-journal');

/**
 * Opens the request's log context (OBS-01).
 *
 * Mounted after the body parsers as a precaution: body-parser continues from a
 * socket stream event, and on some Node / body-parser combinations a context
 * opened before it is not carried across (not reproduced on Node 20.19 here: the
 * context survives either order). Opened here, it holds on every combination.
 * Survives awaits and timers (tests/regression/obs-01-structured-logs.test.js).
 */
const openRequestContext = (req, res, next) => {
  // NEW-123: every 5xx answer goes to the error journal with its reference id.
  const startedAt = Date.now();
  res.on('finish', () => {
    if (res.statusCode >= 500) errorJournal.record(req, res, startedAt);
  });
  requestContext.run({ requestId: req.id, req }, next);
};

module.exports = openRequestContext;
