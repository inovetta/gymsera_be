const crypto = require('crypto');

/**
 * requestId middleware — attaches a unique request ID (or passes through an incoming X-Request-Id)
 * to req.id and sets the X-Request-Id response header.
 */
const requestId = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && incoming.trim() ? incoming.trim() : crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
};

module.exports = requestId;
