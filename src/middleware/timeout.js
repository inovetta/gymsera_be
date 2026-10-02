const { sendError } = require('../utils/response.utils');

/**
 * Server request timeout middleware (spec §4.1: 15 s timeout, provisioning exception).
 * @param {number} defaultTimeoutMs - Timeout in milliseconds, defaults to 15000 (15s).
 */
function requestTimeout(defaultTimeoutMs = 15000) {
  return (req, res, next) => {
    // Exempt long-running provisioning requests or testing bypasses
    const isProvisioning = req.originalUrl && (
      (req.originalUrl.includes('/admin/tenants') && req.originalUrl.endsWith('/approve')) ||
      req.originalUrl.includes('/provision')
    );

    if (isProvisioning || req.headers['x-skip-timeout'] === 'true') {
      return next();
    }

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        sendError(
          res,
          408,
          'request_timeout',
          'Request timed out after 15 seconds',
          { timeoutMs: defaultTimeoutMs }
        );
      }
    }, defaultTimeoutMs);

    // Clear timeout when response finishes
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
}

module.exports = { requestTimeout };
