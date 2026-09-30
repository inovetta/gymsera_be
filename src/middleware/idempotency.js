/**
 * Idempotency Middleware (spec §11.2, REL-01).
 *
 * Implements the mutation reliability contract:
 * - Scoped to tenant DB when in tenant context (req.tenantDb), otherwise platform DB.
 * - Same key + same requestHash -> replays stored response (status code & body) without re-executing handler.
 * - Same key + different requestHash -> 422 idempotency_key_reuse.
 * - A request with same key currently in flight -> 409 request_in_progress.
 * - Required on demand via `idempotency({ required: true })`.
 * - Records expire after 24 hours.
 */
const crypto = require('crypto');

function sortObject(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObject);
  return Object.keys(obj)
    .sort()
    .reduce((result, key) => {
      result[key] = sortObject(obj[key]);
      return result;
    }, {});
}

function computeRequestHash(method, route, body) {
  const normalized = {
    method: String(method || '').toUpperCase(),
    route: String(route || ''),
    body: sortObject(body || {}),
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Creates the idempotency middleware.
 *
 * @param {object} [options]
 * @param {boolean} [options.required=false] - If true, missing header returns 400.
 */
function idempotency(options = {}) {
  const isRequired = options.required === true;

  return async (req, res, next) => {
    // Only apply to mutating requests (non-GET, non-HEAD, non-OPTIONS)
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const rawKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

    if (rawKey === undefined || rawKey === null) {
      if (isRequired) {
        return res.status(400).json({
          success: false,
          code: 'idempotency_key_required',
          message: 'Idempotency-Key header is required for this request',
        });
      }
      return next();
    }

    const key = String(rawKey).trim();
    if (!key || key.length > 128) {
      return res.status(400).json({
        success: false,
        code: 'invalid_idempotency_key',
        message: 'Idempotency-Key must be a non-empty string of up to 128 characters',
      });
    }

    const route = `${req.method.toUpperCase()} ${req.baseUrl || ''}${req.path || ''}`;
    const requestHash = computeRequestHash(req.method, route, req.body);

    // Resolve model: tenant DB if present, otherwise platform DB
    let IdempotencyModel = req.tenantDb?.models?.IdempotencyRecord;
    if (!IdempotencyModel) {
      try {
        const platformModels = require('../models/platform');
        IdempotencyModel = platformModels.IdempotencyRecord;
      } catch (_) {}
    }

    if (!IdempotencyModel) {
      return next();
    }

    const now = new Date();

    try {
      const existing = await IdempotencyModel.findOne({
        where: { idempotencyKey: key },
      });

      if (existing) {
        // If expired (> 24 hours), remove the stale record and allow fresh execution
        if (existing.expiresAt && new Date(existing.expiresAt) < now) {
          await existing.destroy().catch(() => {});
        } else {
          // Same key with different payload/parameters -> 422
          if (existing.requestHash !== requestHash) {
            return res.status(422).json({
              success: false,
              code: 'idempotency_key_reuse',
              message: 'Idempotency key reuse: same key was previously used with different request parameters',
            });
          }

          // Same key currently in flight -> 409
          if (existing.status === 'IN_PROGRESS') {
            return res.status(409).json({
              success: false,
              code: 'request_in_progress',
              message: 'A request with this idempotency key is currently in progress',
            });
          }

          // Completed / resolved -> replay response
          if (existing.status === 'RESOLVED') {
            res.set('X-Idempotent-Replay', 'true');
            res.set('Idempotency-Key', key);
            const status = existing.statusCode || 200;
            return res.status(status).json(existing.responseBody);
          }
        }
      }

      // Create IN_PROGRESS record
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      let record;
      try {
        record = await IdempotencyModel.create({
          idempotencyKey: key,
          userId: req.user?.id || null,
          route,
          requestHash,
          status: 'IN_PROGRESS',
          expiresAt,
        });
      } catch (insertErr) {
        // Concurrency race on insert: re-fetch and handle gracefully
        const raced = await IdempotencyModel.findOne({ where: { idempotencyKey: key } });
        if (raced) {
          if (raced.requestHash !== requestHash) {
            return res.status(422).json({
              success: false,
              code: 'idempotency_key_reuse',
              message: 'Idempotency key reuse: same key was previously used with different request parameters',
            });
          }
          if (raced.status === 'IN_PROGRESS') {
            return res.status(409).json({
              success: false,
              code: 'request_in_progress',
              message: 'A request with this idempotency key is currently in progress',
            });
          }
          if (raced.status === 'RESOLVED') {
            res.set('X-Idempotent-Replay', 'true');
            res.set('Idempotency-Key', key);
            return res.status(raced.statusCode || 200).json(raced.responseBody);
          }
        }
        throw insertErr;
      }

      req.idempotencyKey = key;

      // Intercept res.json and res.send to save response
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      let saved = false;
      const saveRecord = async (body) => {
        if (saved) return;
        saved = true;
        try {
          const statusCode = res.statusCode || 200;
          if (statusCode >= 200 && statusCode < 500) {
            await record.update({
              status: 'RESOLVED',
              statusCode,
              responseBody: body,
            });
          } else {
            // 5xx server error: allow retry by destroying in-progress record
            await record.destroy().catch(() => {});
          }
        } catch (saveErr) {
          console.warn('[Idempotency] Failed to persist idempotency record:', saveErr.message);
        }
      };

      res.json = function (data) {
        res.set('Idempotency-Key', key);
        saveRecord(data).finally(() => {
          originalJson(data);
        });
      };

      res.send = function (data) {
        res.set('Idempotency-Key', key);
        let parsed = data;
        if (typeof data === 'string') {
          try {
            parsed = JSON.parse(data);
          } catch (_) {}
        }
        saveRecord(parsed).finally(() => {
          originalSend(data);
        });
      };

      // Clean up in-progress record if socket closes prematurely
      res.on('close', () => {
        if (!saved) {
          record.destroy().catch(() => {});
        }
      });

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = idempotency;
module.exports.idempotency = idempotency;
module.exports.computeRequestHash = computeRequestHash;
