const { Router } = require('express');
const { ERROR_COPY } = require('../constants/error-copy');
const { sendSuccess } = require('../utils/response.utils');

const router = Router();

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
