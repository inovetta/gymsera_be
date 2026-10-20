/**
 * Per-route rate limiters (SEC-04), on top of the broad per-IP limits in app.js.
 *
 * Why these, and why these numbers: the broad limiter only counts requests per IP, so one IP could try
 * thousands of passwords against one account, and one account's owner has no per-user ceiling on writes.
 * Mobile users share carrier NATs, so every number is generous; the aim is to stop scripts, not people.
 * Each limiter has an env override (`RATE_LIMIT_<NAME>_MAX`, `RATE_LIMIT_<NAME>_WINDOW_S`), so a limit
 * that hurts real users is a settings change, not a deploy.
 *
 * Stores are in process memory (one API instance, decided 2026-10-14). A Redis store is the follow-up for
 * the day a second instance exists. Every store comes from rate-limit-stores.js so the test hook can stop
 * its timer (see tests/regression/test-hygiene-rate-limit-stores.test.js): a limiter built any other way
 * fails that test.
 *
 * A limited request answers 429 with the standard envelope and a `Retry-After` header (seconds).
 */
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { createMemoryStore } = require('../utils/rate-limit-stores');
const { sendError } = require('../utils/response.utils');
const { verifyToken } = require('../utils/jwt.utils');

const isDevOrTest = () =>
  ['development', 'test'].includes(process.env.NODE_ENV || '') || process.env.NODE_ENV === undefined;

/** name -> [window seconds, max requests] in production. Dev and test get a very high ceiling. */
const DEFAULTS = {
  LOGIN_IP: [15 * 60, 300],
  LOGIN_ID: [15 * 60, 30],
  REGISTER_IP: [60 * 60, 100],
  REGISTER_ID: [60 * 60, 10],
  OTP_IP: [15 * 60, 200],
  OTP_ID: [15 * 60, 20],
  PWRESET_IP: [60 * 60, 100],
  PWRESET_ID: [60 * 60, 10],
  SEARCH_IP: [60, 120],
  MUTATION_USER: [60, 120],
  REVEAL_USER: [60 * 60, 300],
};

const intFromEnv = (name) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Effective { windowMs, max } for a rule name. */
const settingsFor = (name) => {
  const [windowS, max] = DEFAULTS[name];
  return {
    windowMs: (intFromEnv(`RATE_LIMIT_${name}_WINDOW_S`) || windowS) * 1000,
    max: intFromEnv(`RATE_LIMIT_${name}_MAX`) || (isDevOrTest() ? 100000 : max),
  };
};

const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/** The account a request is about, as a short hash (no e-mail or phone in the store). */
const identifierOf = (req) => {
  const b = req.body || {};
  const raw = [b.email, b.phone, b.identifier, b.username].find((v) => typeof v === 'string' && v.trim());
  if (!raw) return null;
  return crypto.createHash('sha1').update(raw.trim().toLowerCase().slice(0, 200)).digest('hex').slice(0, 16);
};

/** The verified user of a bearer token, or null. A forged or expired token never gets its own bucket. */
const verifiedUserId = (req) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try {
    const decoded = verifyToken(header.slice(7));
    return decoded.sub || decoded.id || null;
  } catch (_) {
    return null;
  }
};

const handler = (message) => (req, res) => {
  const resetMs = req.rateLimit?.resetTime ? req.rateLimit.resetTime.getTime() - Date.now() : 60000;
  const retryAfter = Math.max(1, Math.ceil(resetMs / 1000));
  res.setHeader('Retry-After', String(retryAfter));
  return sendError(res, 429, message, 'rate_limit_exceeded', { retryAfterSeconds: retryAfter });
};

/**
 * @param {string} name       key in DEFAULTS
 * @param {string} message
 * @param {(req) => string|null} keyOf  null means "this request has nothing to count here": it is skipped
 */
const build = (name, message, keyOf) => {
  const { windowMs, max } = settingsFor(name);
  return rateLimit({
    store: createMemoryStore(),
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
    keyGenerator: (req) => keyOf(req) || 'none',
    skip: (req) => keyOf(req) === null,
    handler: handler(message),
  });
};

const byIp = (prefix) => (req) => `${prefix}:${clientIp(req)}`;
const byIpAndAccount = (prefix) => (req) => {
  const id = identifierOf(req);
  return id ? `${prefix}:${clientIp(req)}:${id}` : null;
};

const TOO_MANY = 'Too many attempts. Please wait a moment and try again.';

/** Builds a fresh set of limiters (reads the env at call time). */
const createLimiters = () => ({
  loginIp: build('LOGIN_IP', TOO_MANY, byIp('login')),
  loginAccount: build('LOGIN_ID', TOO_MANY, byIpAndAccount('login')),
  registerIp: build('REGISTER_IP', TOO_MANY, byIp('register')),
  registerAccount: build('REGISTER_ID', TOO_MANY, byIpAndAccount('register')),
  otpIp: build('OTP_IP', TOO_MANY, byIp('otp')),
  otpAccount: build('OTP_ID', TOO_MANY, byIpAndAccount('otp')),
  passwordResetIp: build('PWRESET_IP', TOO_MANY, byIp('pwreset')),
  passwordResetAccount: build('PWRESET_ID', TOO_MANY, byIpAndAccount('pwreset')),
  search: build('SEARCH_IP', 'Too many searches. Please slow down.', byIp('search')),
  // SEC-17: bulk-scraping contact details through the audited reveal route is slowed down per admin.
  reveal: build('REVEAL_USER', 'Too many contact reveals. Please wait before revealing more.', (req) => {
    const user = verifiedUserId(req);
    return user ? `reveal:u:${user}` : null;
  }),
  mutation: build('MUTATION_USER', 'Too many changes in a short time. Please slow down.', (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
    const url = (req.originalUrl || req.url || '').toLowerCase();
    // Provider webhooks and biometric devices are not users and have their own checks.
    if (url.includes('/billing/webhooks/') || url.includes('/attendance/device-notify')) return null;
    // Only a verified user has a bucket. Anonymous writes (login, register, ...) have their own limiters
    // above and the broad per-IP limit; a forged token is rejected by authenticate and counts nowhere.
    const user = verifiedUserId(req);
    return user ? `mutation:u:${user}` : null;
  }),
});

/**
 * Runs `chain` (limiters, in order) for requests whose method matches and whose path (under the prefix)
 * satisfies `matches`; everything else passes straight through. Mounted with app.use, not app.post/get,
 * so no phantom routes appear in the router (the unauthenticated-routes guard walks it).
 */
const when = (method, matches, chain) => (req, res, next) => {
  if (req.method !== method || !matches(req.path)) return next();
  let i = 0;
  const step = (err) => {
    if (err || i >= chain.length) return next(err);
    return chain[i++](req, res, step);
  };
  return step();
};

/** Mounts every limiter on the app. Call after the body parsers. */
const mount = (app, prefix = '/api/v1') => {
  const l = createLimiters();
  const exact = (...paths) => (p) => paths.includes(p.replace(/\/+$/, ''));
  app.use(prefix, when('POST', exact('/auth/login'), [l.loginIp, l.loginAccount]));
  app.use(prefix, when('POST', exact('/auth/register'), [l.registerIp, l.registerAccount]));
  app.use(prefix, when('POST', exact('/auth/otp/verify', '/auth/otp/resend'), [l.otpIp, l.otpAccount]));
  app.use(prefix, when('POST', exact('/auth/password-reset/request', '/auth/password-reset/confirm'),
    [l.passwordResetIp, l.passwordResetAccount]));
  app.use(prefix, when('GET', (p) => p === '/discovery' || p.startsWith('/discovery/'), [l.search]));
  app.use(prefix, when('POST', (p) => /^\/admin\/tenants\/[^/]+\/members\/[^/]+\/reveal$/.test(p), [l.reveal]));
  app.use(prefix, l.mutation);
  return l;
};

module.exports = { createLimiters, mount, settingsFor, DEFAULTS };
