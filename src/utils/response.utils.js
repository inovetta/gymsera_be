/**
 * Send a standardised success response.
 * @param {import('express').Response} res
 * @param {*} data
 * @param {string} message
 * @param {number} statusCode
 * @param {{ total: number, page: number, limit: number, totalPages: number }|null} pagination
 */
const sendSuccess = (res, data = null, message = 'Success', statusCode = 200, pagination = null) => {
  const body = { success: true, message, data };
  if (pagination) body.pagination = pagination;
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
const createError = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

module.exports = { sendSuccess, buildPagination, parsePagination, createError };
