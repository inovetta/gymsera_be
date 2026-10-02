const { validationResult } = require('express-validator');
const { sendError } = require('../utils/response.utils');

/**
 * validate(validations) — wraps an array of express-validator chains into a
 * single middleware that runs all checks and returns 422 on any failure.
 *
 * Usage in routes:
 *   router.post('/register', validate(authValidators.register), authController.register);
 */
const validate = (validations) => async (req, res, next) => {
  await Promise.all(validations.map((v) => v.run(req)));

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorDetails = errors.array().map((e) => ({ field: e.path, message: e.msg }));
    return sendError(res, 422, 'Validation failed', 'validation_error', { errors: errorDetails });
  }

  next();
};

module.exports = validate;
