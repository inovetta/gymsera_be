/**
 * Send a standardised success response (spec §4.1).
 * Backward-compatible: keeps top-level success, message, data, pagination,
 * and adds meta: { requestId, ... }.
 *
 * @param {import('express').Response} res
 * @param {*} data
 * @param {string} message
 * @param {number} statusCode
 * @param {{ total: number, page: number, limit: number, totalPages: number }|null} pagination
 * @param {object|null} meta
 */
const sendSuccess = (res, data = null, message = 'Success', statusCode = 200, pagination = null, meta = null) => {
  const req = res.req;
  const requestId = req?.id || (typeof res.getHeader === 'function' ? res.getHeader('X-Request-Id') : null);
  const responseMeta = {
    timestamp: new Date().toISOString(),
    ...(requestId && { requestId }),
    ...(req?.originalUrl && { path: req.originalUrl }),
    ...(meta || {}),
  };

  const body = { success: true, message, data };
  if (Object.keys(responseMeta).length > 0) body.meta = responseMeta;
  if (pagination) body.pagination = pagination;
  return res.status(statusCode).json(body);
};

/**
 * Send a standardised error response (spec §4.1).
 * Envelope format: { error: { code, message, details, requestId } }
 * Backward-compatible additions: top-level { success: false, message, code, errors, requestId }
 *
 * @param {import('express').Response} res
 * @param {number} statusCode
 * @param {string} message
 * @param {string} code
 * @param {object|null} details
 */
const sendError = (res, statusCode = 500, message = 'Internal server error', code = 'internal_error', details = null) => {
  const req = res.req;
  const requestId = req?.id || (typeof res.getHeader === 'function' ? res.getHeader('X-Request-Id') : null);

  const errorObj = {
    code,
    message,
    ...(details !== null && details !== undefined && { details }),
    ...(requestId && { requestId }),
  };

  const body = {
    success: false,
    message,
    code,
    error: errorObj,
    ...(details && { data: details }),
    ...(requestId && { requestId }),
    ...(details?.errors && { errors: details.errors }),
  };

  return res.status(statusCode).json(body);
};

/**
 * Build a pagination object for list endpoints.
 * @param {number} total   total count from Sequelize
 * @param {number} page    current page (1-based)
 * @param {number} limit   items per page
 */
const buildPagination = (total, page, limit) => ({
  total,
  page,
  limit,
  totalPages: Math.ceil(total / limit),
});

/**
 * Parse and validate page / limit query params with sane defaults.
 */
const parsePagination = (query, defaultLimit = 20, maxLimit = 100) => {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit) || defaultLimit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

/**
 * Create an Error with a statusCode property (use with next(err)).
 */
const createError = (message, statusCode = 400, code = null) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
};

module.exports = { sendSuccess, sendError, buildPagination, parsePagination, createError };
