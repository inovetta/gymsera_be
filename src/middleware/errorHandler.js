const {
  UniqueConstraintError,
  ValidationError,
  ForeignKeyConstraintError,
  DatabaseError,
} = require('sequelize');

const { sendError } = require('../utils/response.utils');

/**
 * Global error handler middleware (spec §4.1).
 * Must be the LAST middleware registered in app.js (after all routes).
 *
 * Handles:
 *  - Sequelize errors (unique, validation, FK, generic DB)
 *  - JWT errors (JsonWebTokenError, TokenExpiredError)
 *  - Express HTTP errors (err.statusCode / err.status)
 *  - Unhandled 500s
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, _next) => {
  // ── Sequelize: duplicate entry ───────────────────────────────────────────────
  if (err instanceof UniqueConstraintError) {
    const field = err.errors[0]?.path || 'field';
    return sendError(res, 409, `A record with this ${field} already exists`, 'conflict', { field });
  }

  // ── Sequelize: model-level validation ────────────────────────────────────────
  if (err instanceof ValidationError) {
    const errorDetails = err.errors.map((e) => ({ field: e.path, message: e.message }));
    return sendError(res, 422, 'Validation failed', 'validation_error', { errors: errorDetails });
  }

  // ── Sequelize: foreign key violation ─────────────────────────────────────────
  if (err instanceof ForeignKeyConstraintError) {
    return sendError(res, 400, 'Referenced record does not exist', 'referenced_record_not_found');
  }

  // ── Sequelize: generic DB error ───────────────────────────────────────────────
  if (err instanceof DatabaseError) {
    console.error('[DB Error]', err.message, err.original?.sqlMessage || err.original?.message || err.original);
    const detail = process.env.NODE_ENV !== 'production'
      ? (err.original?.sqlMessage || err.original?.message || err.message)
      : null;
    return sendError(res, 500, 'A database error occurred', 'database_error', detail ? { detail } : null);
  }

  // ── JWT errors ────────────────────────────────────────────────────────────────
  if (err.name === 'JsonWebTokenError') {
    return sendError(res, 401, 'Invalid token', 'invalid_token');
  }

  if (err.name === 'TokenExpiredError') {
    return sendError(res, 401, 'Token has expired', 'token_expired');
  }

  // ── Express-validator errors (if thrown manually) ─────────────────────────────
  if (err.type === 'validation') {
    return sendError(res, 422, err.message || 'Validation failed', 'validation_error', { errors: err.errors });
  }

  // ── HTTP errors with explicit statusCode ──────────────────────────────────────
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Internal server error';

  if (statusCode >= 500) {
    console.error(`[${new Date().toISOString()}] Unhandled error:`, err);
  }

  const isV2 = req.headers['x-api-version'] === '2' || req.headers['accept-version'] === '2';
  if (!isV2 && !err.code) {
    return res.status(statusCode).json({
      success: false,
      message,
      ...(err.data && { data: err.data }),
    });
  }

  const defaultCode =
    statusCode === 404
      ? 'not_found'
      : statusCode === 403
      ? 'forbidden'
      : statusCode === 401
      ? 'unauthorized'
      : statusCode === 409
      ? 'conflict'
      : statusCode === 422
      ? 'validation_error'
      : statusCode === 429
      ? 'rate_limit_exceeded'
      : statusCode >= 500
      ? 'internal_error'
      : 'bad_request';

  const code = err.code || defaultCode;
  const details = err.details || err.data || (err.errors ? { errors: err.errors } : null);

  return sendError(res, statusCode, message, code, details);
};

module.exports = errorHandler;
