const { logger } = require('../utils/logger');
const { redactString } = require('../utils/log-redaction');

/**
 * One access-log line per finished request (OBS-01), replacing morgan:
 * route, status and latencyMs, plus requestId / tenantId / userId from the
 * request context. `route` is the matched pattern (`/api/v1/members/:id`), not
 * the URL, so it is safe to group by and carries no ids or tokens; the raw URL
 * is logged separately and redacted (SEC-07).
 */
const accessLog = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const latencyMs = Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100;
    const route = req.route ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    // Read from req, not the async context: 'finish' fires outside it.
    const userId = req.user ? req.user.id || req.user.sub : undefined;
    logger[level](
      {
        source: 'access',
        requestId: req.id,
        ...(req.tenantId !== undefined && { tenantId: req.tenantId }),
        ...(userId !== undefined && { userId }),
        method: req.method,
        route,
        url: redactString(req.originalUrl || req.url || ''),
        status: res.statusCode,
        latencyMs,
      },
      'request'
    );
  });
  next();
};

module.exports = accessLog;
