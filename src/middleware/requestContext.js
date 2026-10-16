const requestContext = require('../utils/request-context');

/**
 * Opens the request's log context (OBS-01).
 *
 * Mounted after the body parsers as a precaution: body-parser continues from a
 * socket stream event, and on some Node / body-parser combinations a context
 * opened before it is not carried across (not reproduced on Node 20.19 here: the
 * context survives either order). Opened here, it holds on every combination.
 * Survives awaits and timers (tests/regression/obs-01-structured-logs.test.js).
 */
const openRequestContext = (req, _res, next) => {
  requestContext.run({ requestId: req.id, req }, next);
};

module.exports = openRequestContext;
