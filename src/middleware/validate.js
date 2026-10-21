const { validationResult } = require('express-validator');
const { sendError } = require('../utils/response.utils');

/**
 * validate(validations) — wraps an array of express-validator chains into a
 * single middleware that runs all checks and returns 422 on any failure.
 *
 * Usage in routes:
 *   router.post('/register', validate(authValidators.register), authController.register);
 */
const build = (validations, allowedFields, stage = 1) => async (req, res, next) => {
  await Promise.all(validations.map((v) => v.run(req)));

  const errors = validationResult(req);
  const errorDetails = errors.isEmpty() ? [] : errors.array().map((e) => ({ field: e.path, message: e.msg }));

  if (allowedFields) {
    const mode = unknownFieldsMode(stage);
    const sent = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body) : [];
    const unknown = mode === 'off' ? [] : sent.filter((k) => !allowedFields.includes(k));
    if (unknown.length && mode === 'log') {
      console.warn(`[unknown-fields] ${req.method} ${req.originalUrl.split('?')[0]} would be rejected: ${unknown.join(', ')}`);
    } else if (unknown.length) {
      for (const field of unknown) errorDetails.push({ field, message: 'Unknown field', code: 'unknown_field' });
    }
  }

  if (errorDetails.length) {
    return sendError(res, 422, 'Validation failed', 'validation_error', { errors: errorDetails });
  }

  next();
};

const validate = (validations) => build(validations, null);

/**
 * SEC-06: what a strict route does with a body field it does not declare.
 *   UNKNOWN_FIELDS_MODE = reject (default: 422) | log (accept and log the field names) | off (no check, any stage).
 *   Stage 2 routes (their client bodies were only recently cleaned up) default to LOG instead, and are moved to
 *   reject with UNKNOWN_FIELDS_STAGE2_MODE=reject once the logs show no real client sends an unknown field.
 */
const unknownFieldsMode = (stage = 1) => {
  const global = String(process.env.UNKNOWN_FIELDS_MODE || 'reject').toLowerCase();
  if (global === 'off') return 'off';
  if (stage >= 2) {
    const m = String(process.env.UNKNOWN_FIELDS_STAGE2_MODE || 'log').toLowerCase();
    return m === 'reject' || m === 'off' ? m : 'log';
  }
  return global === 'log' ? 'log' : 'reject';
};

/**
 * validate.strict(validations, { allow }) — validate(), plus every top-level key of req.body must be
 * a field some chain names (the root of a nested path such as items.*.id counts) or be listed in
 * `allow`. A body that is missing or not a plain object is left alone (the chains judge it).
 */
validate.strict = (validations, { allow = [], stage = 1 } = {}) => {
  const allowed = new Set(allow);
  for (const v of validations) {
    const b = v.builder && typeof v.builder.build === 'function' ? v.builder.build() : null;
    if (!b || !b.locations.includes('body')) continue;
    for (const f of b.fields) allowed.add(String(f).split(/[.[]/)[0]);
  }
  const list = [...allowed];
  const mw = build(validations, list, stage);
  mw.__strictAllowed = list;
  mw.__strictStage = stage;
  return mw;
};

module.exports = validate;
