'use strict';
/**
 * NEW-256: for a PUBLIC read that can be personal when the caller is signed in (the review lists
 * hide the reviews the caller reported). No Authorization header: anonymous. A valid token: the
 * same req.user as `authenticate`. An invalid or expired token: anonymous, never a 401, so a
 * public page keeps working.
 */
const authenticate = require('./authenticate');

module.exports = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();
  return authenticate(req, res, (err) => {
    if (err) {
      req.user = undefined;
      return next();
    }
    return next();
  });
};
