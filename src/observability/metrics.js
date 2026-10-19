/**
 * Prometheus metrics (OBS-03, spec §12.12).
 *
 * Off unless METRICS_KEY is set (at least 24 characters). Then `GET /metrics` answers only a request
 * carrying `Authorization: Bearer <key>`; without the key configured it answers 404 as if it did not
 * exist, and nothing is recorded (every `record*` call is a no-op until `init()` has run).
 *
 * Labels are bounded and carry no personal data: HTTP series are keyed by method, ROUTE PATTERN
 * (`/api/v1/members/:id`, never the URL) and status code; pools by tenant id for the 10 busiest tenants
 * only; everything else has no labels or a fixed result label. See tests/regression/obs-03-metrics.test.js.
 */
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const client = require('prom-client');
const { sendError } = require('../utils/response.utils');

const MIN_KEY_LENGTH = 24;
const TOP_TENANTS = 10;
const DB_READ_CACHE_MS = 15 * 1000;
const PREFIX = 'gymsera_';

let state = null;

const configuredKey = () => {
  const key = process.env.METRICS_KEY;
  return typeof key === 'string' && key.length >= MIN_KEY_LENGTH ? key : null;
};

const isEnabled = () => configuredKey() !== null;

/** Constant-time comparison; hashing first makes the lengths equal, so it never throws. */
const keyMatches = (provided, expected) => {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
};

/** Wrong-key attempts (and scrapes) are rate limited per IP. */
const createMetricsLimiter = (max = 60) =>
  rateLimit({
    store: require('../utils/rate-limit-stores').createMemoryStore(),
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { success: false, message: 'Too many requests, please try again later.' },
  });

// ── route label ──────────────────────────────────────────────────────────────

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Router mount paths of an Express app (`/api/v1`, `/api/v1/team`, ...), read once from the router stack.
 * A request that never reached a route (router-level `authenticate` / tenant resolution answered it,
 * or nothing matched under a router) is attributed to the longest mount path it falls under, as
 * `<mount>/*`. The set is fixed by the code, so this cannot grow with traffic.
 */
const _mountCache = new WeakMap();
const mountPrefixes = (app) => {
  if (!app || !app._router) return [];
  if (_mountCache.has(app)) return _mountCache.get(app);
  const found = new Set();
  const walk = (stack, base) => {
    for (const layer of stack) {
      if (layer.route || layer.name !== 'router' || !layer.handle || !layer.handle.stack) continue;
      let prefix = base;
      if (layer.regexp && !layer.regexp.fast_slash) {
        const clean = layer.regexp.source
          .replace('^\\/', '/')
          .replace('\\/?(?=\\/|$)', '')
          .replace(/\\\//g, '/')
          .replace(/\^/g, '')
          .replace(/\$/g, '');
        prefix = (base + clean).replace(/\/+/g, '/');
      }
      // a mount path that carries a parameter cannot be matched by prefix; its children still can
      if (prefix && prefix !== '/' && !prefix.includes('(') && !prefix.includes(':')) found.add(prefix);
      walk(layer.handle.stack, prefix);
    }
  };
  walk(app._router.stack, '');
  const list = [...found].sort((a, b) => b.length - a.length); // longest first
  _mountCache.set(app, list);
  return list;
};

/**
 * The matched route pattern, never the URL. A router mounted on a path that carries a value
 * (`/x/:tenant`) shows that value in `req.baseUrl`, so ids are normalised to `:id` as well.
 * No route matched: the longest known mount path as `<mount>/*`, else `unmatched`.
 */
const routeLabel = (req) => {
  if (!req.route) {
    const url = (req.originalUrl || req.url || '').split('?')[0];
    const mount = mountPrefixes(req.app).find((m) => url === m || url.startsWith(`${m}/`));
    return mount ? `${mount}/*` : 'unmatched';
  }
  const raw = `${req.baseUrl || ''}${req.route.path === '/' ? '' : req.route.path}` || '/';
  return raw
    .replace(UUID, ':id')
    .replace(/\/[0-9a-f]{24,}(?=\/|$)/gi, '/:id')
    .replace(/\/\d{3,}(?=\/|$)/g, '/:id')
    .slice(0, 200);
};

// ── init / record ────────────────────────────────────────────────────────────

const init = () => {
  if (state) return state;
  if (!isEnabled()) return null;

  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry, prefix: PREFIX });
  const g = (name, help, labelNames = []) => new client.Gauge({ name: PREFIX + name, help, labelNames, registers: [registry] });
  const c = (name, help, labelNames = []) => new client.Counter({ name: PREFIX + name, help, labelNames, registers: [registry] });

  state = {
    registry,
    dbReadAt: 0,
    httpRequests: c('http_requests_total', 'HTTP requests by method, route pattern and status code', ['method', 'route', 'status']),
    httpDuration: new client.Histogram({
      name: `${PREFIX}http_request_duration_seconds`,
      help: 'HTTP request duration by method and route pattern',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    poolsOpen: g('tenant_pools_open', 'Open tenant database pools'),
    poolCap: g('tenant_pool_cap', 'Configured cap of open tenant pools'),
    poolConnections: g('tenant_pool_connections', 'Connections across all open tenant pools'),
    poolInUse: g('tenant_pool_in_use', 'Borrowed connections across all open tenant pools'),
    poolWaiting: g('tenant_pool_waiting', 'Requests waiting for a connection across all open tenant pools'),
    poolEvictions: c('tenant_pool_evictions_total', 'Idle tenant pools closed to stay within the cap'),
    topInUse: g('tenant_pool_top_in_use', 'Borrowed connections of the busiest tenants (top 10 only)', ['tenant_id']),
    topWaiting: g('tenant_pool_top_waiting', 'Waiting requests of the busiest tenants (top 10 only)', ['tenant_id']),
    platformConnections: g('platform_pool_connections', 'Connections in the platform database pool'),
    platformInUse: g('platform_pool_in_use', 'Borrowed connections in the platform database pool'),
    platformWaiting: g('platform_pool_waiting', 'Requests waiting for a platform database connection'),
    billingUnprocessed: g('billing_events_unprocessed', 'Billing events received and not yet processed'),
    billingOldestAge: g('billing_events_oldest_unprocessed_age_seconds', 'Age of the oldest unprocessed billing event'),
    billingFailed: g('billing_events_failed', 'Billing events in FAILED'),
    outboxUnprocessed: g('capacity_outbox_unprocessed', 'Capacity outbox entries PENDING or FAILED at the last sweep (all tenants)'),
    outboxOldestAge: g('capacity_outbox_oldest_age_seconds', 'Age of the oldest unprocessed capacity outbox entry at the last sweep'),
    outboxLastSweep: g('capacity_outbox_last_sweep_timestamp_seconds', 'When the capacity outbox sweep last finished (unix seconds)'),
    fcmMessages: c('fcm_messages_total', 'Push messages sent to FCM by result', ['result']),
    fcmBatchErrors: c('fcm_batch_errors_total', 'FCM multicast calls that failed as a whole'),
    sockets: g('socket_connections', 'Open Socket.IO connections'),
  };
  return state;
};

const _resetForTests = () => {
  if (state) state.registry.clear();
  state = null;
};

/** Express middleware: count and time every request, by route pattern. A no-op until init() has run. */
const httpMiddleware = (req, res, next) => {
  const s = state;
  if (!s) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = routeLabel(req);
    if (route === '/metrics') return;
    s.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    s.httpDuration.observe({ method: req.method, route }, Number(process.hrtime.bigint() - start) / 1e9);
  });
  next();
};

/** push.service.js: counts of one FCM call. */
const recordFcm = ({ successCount = 0, failureCount = 0 } = {}) => {
  if (!state) return;
  if (successCount) state.fcmMessages.inc({ result: 'success' }, successCount);
  if (failureCount) state.fcmMessages.inc({ result: 'failure' }, failureCount);
};

const recordFcmBatchError = () => {
  if (state) state.fcmBatchErrors.inc();
};

/** capacity-outbox.service.js: what the sweep found. */
const recordOutboxSweep = ({ unprocessed = 0, oldestAgeSeconds = 0 } = {}) => {
  if (!state) return;
  state.outboxUnprocessed.set(unprocessed);
  state.outboxOldestAge.set(oldestAgeSeconds);
  state.outboxLastSweep.set(Math.floor(Date.now() / 1000));
};

// ── scrape ───────────────────────────────────────────────────────────────────

const _refreshSync = (s) => {
  const TenantDbManager = require('../database/TenantDbManager');
  const m = TenantDbManager.getMetrics();
  s.poolsOpen.set(m.openPools);
  s.poolCap.set(m.cap);
  s.poolConnections.set(m.connections);
  s.poolInUse.set(m.inUse);
  s.poolWaiting.set(m.waiting);
  s.poolEvictions.reset();
  s.poolEvictions.inc(m.evictions || 0);

  // Only the busiest tenants get a series of their own; the labels are rebuilt each scrape,
  // so a tenant that leaves the top 10 leaves no stale series.
  s.topInUse.reset();
  s.topWaiting.reset();
  for (const t of TenantDbManager.getTopMetrics(TOP_TENANTS)) {
    s.topInUse.set({ tenant_id: t.tenantId }, t.inUse);
    s.topWaiting.set({ tenant_id: t.tenantId }, t.waiting);
  }

  try {
    const pool = require('../database/platform').sequelize.connectionManager.pool;
    s.platformConnections.set((pool && pool.size) || 0);
    s.platformInUse.set((pool && pool.using) || 0);
    s.platformWaiting.set((pool && pool.waiting) || 0);
  } catch (_) {
    /* platform database not connected: leave the last values */
  }

  try {
    const io = require('../socket').getIO();
    s.sockets.set(io && io.engine ? io.engine.clientsCount || 0 : 0);
  } catch (_) {
    s.sockets.set(0);
  }
};

// Webhook lag: two counts and one oldest-row read on the platform database, cached for a few seconds
// so a busy scraper cannot become load. A failing read keeps the last values and never fails the scrape.
const _refreshBillingEvents = async (s) => {
  const now = Date.now();
  if (now - s.dbReadAt < DB_READ_CACHE_MS) return;
  s.dbReadAt = now;
  try {
    const { BillingEvent } = require('../models/platform');
    const [unprocessed, failed, oldest] = await Promise.all([
      BillingEvent.count({ where: { status: 'RECEIVED' } }),
      BillingEvent.count({ where: { status: 'FAILED' } }),
      BillingEvent.findOne({ where: { status: 'RECEIVED' }, order: [['receivedAt', 'ASC']], attributes: ['receivedAt'] }),
    ]);
    s.billingUnprocessed.set(unprocessed);
    s.billingFailed.set(failed);
    s.billingOldestAge.set(oldest ? Math.max(0, (now - new Date(oldest.receivedAt).getTime()) / 1000) : 0);
  } catch (err) {
    console.warn('[Metrics] Could not read billing events:', err.message);
  }
};

const render = async () => {
  const s = init();
  if (!s) return '';
  _refreshSync(s);
  await _refreshBillingEvents(s);
  return s.registry.metrics();
};

/** GET /metrics */
const handler = async (req, res) => {
  const key = configuredKey();
  // Disabled: exactly the app's own 404, so it cannot be told apart from a route that does not exist.
  if (!key) return sendError(res, 404, 'Route not found', 'route_not_found');

  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!match || !keyMatches(match[1], key)) {
    res.set('WWW-Authenticate', 'Bearer realm="metrics"');
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const body = await render();
    res.set('Content-Type', state.registry.contentType);
    res.set('Cache-Control', 'no-store');
    return res.send(body);
  } catch (err) {
    console.error('[Metrics] Scrape failed:', err.message);
    return res.status(500).json({ success: false, message: 'Metrics unavailable' });
  }
};

module.exports = {
  MIN_KEY_LENGTH,
  isEnabled,
  keyMatches,
  createMetricsLimiter,
  routeLabel,
  init,
  httpMiddleware,
  handler,
  render,
  recordFcm,
  recordFcmBatchError,
  recordOutboxSweep,
  _resetForTests,
};
