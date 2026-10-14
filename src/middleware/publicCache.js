/**
 * Cache-Control for public, user-independent discovery reads (spec §10.3).
 *
 * Only successful (200) responses get the header, and only on the routes that
 * explicitly use this middleware. Authenticated routes never use it.
 * Shared caches (CDN) may keep a response for DISCOVERY_CDN_MAX_AGE_S seconds
 * (default 60); clients always revalidate (max-age=0).
 */
const maxAge = () => {
  const n = parseInt(process.env.DISCOVERY_CDN_MAX_AGE_S, 10);
  return Number.isFinite(n) && n >= 0 ? n : 60;
};

module.exports = (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200 && !res.getHeader('Cache-Control')) {
      const s = maxAge();
      res.setHeader('Cache-Control', s > 0 ? `public, max-age=0, s-maxage=${s}` : 'no-store');
    }
    return json(body);
  };
  next();
};
