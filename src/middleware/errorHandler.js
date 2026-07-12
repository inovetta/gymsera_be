const {
  UniqueConstraintError,
  ValidationError,
  ForeignKeyConstraintError,
  DatabaseError,
} = require('sequelize');

/**
 * Global error handler middleware.
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
    return res.status(409).json({
      success: false,
      message: `A record with this ${field} already exists`,
    });
  }

  // ── Sequelize: model-level validation ────────────────────────────────────────
  if (err instanceof ValidationError) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: err.errors.map((e) => ({ field: e.path, message: e.message })),
    });
  }

  // ── Sequelize: foreign key violation ─────────────────────────────────────────
  if (err instanceof ForeignKeyConstraintError) {
    return res.status(400).json({
      success: false,
      message: 'Referenced record does not exist',
    });
  }

  // ── Sequelize: generic DB error ───────────────────────────────────────────────
  if (err instanceof DatabaseError) {
    console.error('[DB Error]', err.message);
    return res.status(500).json({
      success: false,
      message: 'A database error occurred',
    });
  }

  // ── JWT errors ────────────────────────────────────────────────────────────────
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token has expired' });
  }

  // ── Express-validator errors (if thrown manually) ─────────────────────────────
  if (err.type === 'validation') {
    return res.status(422).json({ success: false, message: err.message, errors: err.errors });
  }

  // ── HTTP errors with explicit statusCode ──────────────────────────────────────
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Internal server error';

  if (statusCode >= 500) {
    console.error(`[${new Date().toISOString()}] Unhandled error:`, err);
  }

  return res.status(statusCode).json({
    success: false,
    message,
    ...(err.code && { error: err.code }),
  });
};

module.exports = errorHandler;
