const { sendError } = require('../utils/response.utils');

/**
 * Check if the request URL is an upload route:
 * KYC documents, payment proofs, profile images, poster, gallery / branch images.
 */
function isUploadRoute(url) {
  if (!url || typeof url !== 'string') return false;
  const path = url.split('?')[0].toLowerCase();
  return (
    path.includes('kyc') ||
    path.includes('proof') ||
    path.includes('image') ||
    path.includes('poster') ||
    path.includes('logo') ||
    path.includes('cover') ||
    path.includes('document') ||
    path.includes('upload')
  );
}

/**
 * Check if the request is an admin tenant provisioning request (exempt from timeout).
 */
function isProvisioningRoute(url) {
  if (!url || typeof url !== 'string') return false;
  return (
    (url.includes('/admin/tenants') && url.endsWith('/approve')) ||
    url.includes('/provision')
  );
}

/**
 * Server request timeout middleware (spec §4.1 / API-02).
 * Normal routes: 15 s timeout.
 * Upload routes: 120 s timeout (120,000 ms).
 * Provisioning routes: exempt.
 *
 * @param {number} defaultTimeoutMs - Timeout in milliseconds for normal routes, defaults to 15000 (15s).
 * @param {number} uploadTimeoutMs - Timeout in milliseconds for upload routes, defaults to 120000 (120s).
 */
function requestTimeout(defaultTimeoutMs = 15000, uploadTimeoutMs = 120000) {
  return (req, res, next) => {
    const url = req.originalUrl || req.url || '';

    // Exempt long-running provisioning requests or testing bypasses
    if (isProvisioningRoute(url) || req.headers['x-skip-timeout'] === 'true') {
      return next();
    }

    const isUpload = isUploadRoute(url);
    const timeoutMs = isUpload ? uploadTimeoutMs : defaultTimeoutMs;

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        req.timedOut = true;
        sendError(
          res,
          408,
          `Request timed out after ${Math.max(1, Math.round(timeoutMs / 1000))} seconds`,
          'request_timeout',
          { timeoutMs, isUpload }
        );
      }
    }, timeoutMs);

    // Clear timeout when response finishes or socket closes
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
}

module.exports = {
  requestTimeout,
  isUploadRoute,
  isProvisioningRoute,
};
