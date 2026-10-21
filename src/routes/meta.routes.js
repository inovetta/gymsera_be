const { Router } = require('express');
const { ERROR_COPY } = require('../constants/error-copy');
const { sendSuccess } = require('../utils/response.utils');

const { appConfig } = require('../config/app-version.config');

const router = Router();

/**
 * GET /meta/app-config (NEW-81)
 * Public, cached for one minute. The minimum app version per platform and the store links: an app that
 * cannot sign in (an old build after an auth change) can still read it and show the update screen.
 */
router.get('/app-config', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  return sendSuccess(res, appConfig(), 'App configuration');
});

/**
 * GET /meta/error-copy (spec §4.2)
 * Public, cached for 24 hours. Single source of truth for localized error messages
 * and UI action mappings.
 */
router.get('/error-copy', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600');
  return sendSuccess(res, ERROR_COPY, 'Error copy catalog', 200, null, { version: '1.0.0' });
});

module.exports = router;
