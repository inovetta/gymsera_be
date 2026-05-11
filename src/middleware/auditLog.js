/**
 * auditLog.middleware.js
 *
 * Appends a structured audit record to console (dev) or Platform DB `audit_logs`
 * table (prod) after every mutating API request (POST / PUT / PATCH / DELETE).
 *
 * The middleware attaches an `afterResponse` hook so it never blocks the request.
 * Read-only GET requests are skipped to avoid log noise.
 *
 * Schema for `audit_logs` (Platform DB):
 *   id            UUID PK
 *   userId        UUID | null
 *   tenantId      UUID | null
 *   method        VARCHAR(10)
 *   path          VARCHAR(500)
 *   statusCode    SMALLINT
 *   ipAddress     VARCHAR(45)
 *   userAgent     TEXT
 *   durationMs    INT
 *   createdAt     DATETIME
 *
 * Table creation handled by a Platform DB migration — not included here.
 * If the table does not exist, errors are swallowed so audit logging is
 * always non-fatal.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Writes one audit entry. Returns silently on any error.
 */
const _write = async (entry) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[Audit]', JSON.stringify(entry));
    return;
  }

  try {
    // Lazy-require to avoid circular dependencies
    const { AuditLog } = require('../models/platform');
    await AuditLog.create(entry);
  } catch (err) {
    // Swallow — audit logging must never break the app
    console.warn('[Audit] Failed to persist audit log:', err.message);
  }
};

/**
 * Express middleware factory.
 * Usage: app.use(auditLog) — place AFTER authenticate so req.user is populated.
 */
const auditLog = (req, res, next) => {
  if (!MUTATING_METHODS.has(req.method)) return next();

  const startedAt = Date.now();

  const originalJson = res.json.bind(res);
  res.json = function (body) {
    const entry = {
      userId:     req.user?.id   || null,
      tenantId:   req.user?.tenantId || null,
      method:     req.method,
      path:       req.originalUrl,
      statusCode: res.statusCode,
      ipAddress:  req.ip || req.connection?.remoteAddress || null,
      userAgent:  req.get('user-agent') || null,
      durationMs: Date.now() - startedAt,
      createdAt:  new Date(),
    };

    // Fire-and-forget — do not await
    _write(entry).catch(() => {});

    return originalJson(body);
  };

  next();
};

module.exports = auditLog;
