const crypto = require('crypto');

// A client-supplied id is written to every log line, so it is length-capped and
// limited to a safe alphabet (OBS-01). Anything else is replaced, never trimmed.
const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * requestId middleware — attaches a unique request ID (or passes through a valid incoming X-Request-Id)
 * to req.id and sets the X-Request-Id response header.
 */
const requestId = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming.trim()) ? incoming.trim() : crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
};

module.exports = requestId;
module.exports.SAFE_ID = SAFE_ID;
