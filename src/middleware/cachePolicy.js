/**
 * Default Cache-Control for API responses (API-06, spec §10.3).
 *
 * A request that carries credentials gets `private, no-cache` unless a route
 * already chose a policy: the response may be stored only by that user's own
 * client and must be revalidated (ETag / If-None-Match) before reuse. Public
 * discovery routes set their own `public, ...` header (middleware/publicCache.js)
 * before the headers are written, so this never overrides it.
 * Requests without credentials get no default header.
 */
module.exports = (req, res, next) => {
  if (req.headers.authorization) {
    const writeHead = res.writeHead;
    res.writeHead = function patchedWriteHead(...args) {
      if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'private, no-cache');
      return writeHead.apply(this, args);
    };
  }
  next();
};
