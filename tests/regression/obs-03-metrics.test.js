/**
 * OBS-03 — Prometheus metrics (spec §12.12).
 *
 * GET /metrics is protected by a key from the environment (METRICS_KEY, at least 24 characters, sent as
 * `Authorization: Bearer <key>`); with no key, or a key that is too short, the endpoint is disabled
 * (404) and nothing is recorded. Labels hold route patterns, methods, status codes and tenant ids,
 * never raw URLs, query strings, e-mails or names.
 */
const http = require('http');
const express = require('express');
const request = require('supertest');

// A fake Firebase, so the real push.service code runs and reports its counts.
const mockSend = jest.fn();
const mockMulti = jest.fn();
jest.mock('firebase-admin', () => ({
  apps: [{}],
  messaging: () => ({ send: mockSend, sendEachForMulticast: mockMulti }),
}));

const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const metrics = require('../../src/observability/metrics');
const TenantDbManager = require('../../src/database/TenantDbManager');
const { BillingEvent, City } = require('../../src/models/platform');

const KEY = 'metrics-test-key-0123456789abcdef';
let app;
let dbHarness;

const scrape = (key = KEY) => {
  const req = request(app).get('/metrics');
  return key === null ? req : req.set('Authorization', `Bearer ${key}`);
};
const value = (text, nameAndLabels) => {
  const line = text.split('\n').find((l) => l.startsWith(nameAndLabels + ' '));
  return line === undefined ? undefined : Number(line.slice(nameAndLabels.length + 1));
};

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  app = await startTestServer();
});
afterAll(async () => {
  await TenantDbManager.releaseAll();
  await teardownTestDatabases();
});
beforeEach(() => {
  process.env.METRICS_KEY = KEY;
  metrics._resetForTests();
  metrics.init();
  mockSend.mockReset();
  mockMulti.mockReset();
});
afterEach(() => {
  delete process.env.METRICS_KEY;
  jest.restoreAllMocks();
});

describe('OBS-03: the endpoint is closed unless the key is right', () => {
  test('no key configured: disabled, 404, nothing recorded, other code keeps working', async () => {
    delete process.env.METRICS_KEY;
    metrics._resetForTests();
    expect(metrics.isEnabled()).toBe(false);
    expect((await scrape(null)).status).toBe(404);
    expect((await scrape(KEY)).status).toBe(404); // even a key someone guesses
    expect(() => metrics.recordFcm({ successCount: 1, failureCount: 1 })).not.toThrow();
    expect((await request(app).get('/api/v1/health')).status).toBe(200);
  });

  test('a key shorter than 24 characters counts as not configured', async () => {
    process.env.METRICS_KEY = 'short-key';
    expect(metrics.isEnabled()).toBe(false);
    expect((await scrape('short-key')).status).toBe(404);
  });

  test('configured: no key, wrong key, a key in the URL and a key of another length are all 401', async () => {
    expect((await scrape(null)).status).toBe(401);
    expect((await scrape('wrong-key-wrong-key-wrong-key-xx')).status).toBe(401);
    expect((await scrape('x')).status).toBe(401);
    expect((await request(app).get(`/metrics?key=${KEY}`)).status).toBe(401);
    expect((await request(app).get('/metrics').set('X-Metrics-Key', KEY)).status).toBe(401);
    const denied = await scrape(null);
    expect(denied.headers['www-authenticate']).toMatch(/Bearer/);
    expect(JSON.stringify(denied.body)).not.toContain(KEY);
  });

  test('the right key: 200, Prometheus text format, never cached', async () => {
    const res = await scrape();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('# TYPE gymsera_http_requests_total counter');
  });

  test('key comparison does not throw on odd input (length mismatch, non-ASCII)', () => {
    expect(metrics.keyMatches('a', KEY)).toBe(false);
    expect(metrics.keyMatches('é'.repeat(40), KEY)).toBe(false);
    expect(metrics.keyMatches(KEY, KEY)).toBe(true);
    expect(metrics.keyMatches(undefined, KEY)).toBe(false);
  });

  test('wrong-key attempts are rate limited', async () => {
    const mini = express();
    mini.use('/metrics', metrics.createMetricsLimiter(3));
    mini.get('/metrics', (_req, res) => res.send('ok'));
    const server = http.createServer(mini);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await request(server).get('/metrics')).status);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('OBS-03: request rate, latency and errors by route pattern', () => {
  test('counts a real request under its route pattern with method and status', async () => {
    await request(app).get('/api/v1/health');
    await request(app).get('/api/v1/health');
    const text = (await scrape()).text;
    expect(value(text, 'gymsera_http_requests_total{method="GET",route="/api/v1/health",status="200"}')).toBe(2);
    expect(text).toContain('gymsera_http_request_duration_seconds_bucket{le="0.005",method="GET",route="/api/v1/health"}');
    expect(value(text, 'gymsera_http_request_duration_seconds_count{method="GET",route="/api/v1/health"}')).toBe(2);
  });

  test('a request rejected by router-level auth is still attributed to its router (never to an id)', async () => {
    await request(app).get('/api/v1/team');
    await request(app).get('/api/v1/team/some/deep/path-123456');
    const text = (await scrape()).text;
    expect(value(text, 'gymsera_http_requests_total{method="GET",route="/api/v1/team/*",status="401"}')).toBe(2);
    expect(text).not.toContain('path-123456');
  });

  test('unknown URLs share a bounded label: "<api mount>/*" under the API, "unmatched" elsewhere; ids, tokens and e-mails never become labels', async () => {
    await request(app).get('/api/v1/nothing-here/123456789');
    await request(app).get('/api/v1/other/9f1c2d3e-aaaa-bbbb-cccc-111122223333?token=secret-t&email=leak@example.test');
    await request(app).get('/x/owner@example.test/+923001112223?token=abc');
    await request(app).get('/zzz/987654321');
    const text = (await scrape()).text;
    expect(value(text, 'gymsera_http_requests_total{method="GET",route="/api/v1/*",status="404"}')).toBe(2);
    expect(value(text, 'gymsera_http_requests_total{method="GET",route="unmatched",status="404"}')).toBe(2);
    for (const leaked of ['123456789', '987654321', '9f1c2d3e', 'secret-t', 'leak@example.test', 'owner@', 'nothing-here', 'zzz']) {
      expect(text).not.toContain(leaked);
    }
  });

  test('a flood of random URLs creates no new series (bounded cardinality)', async () => {
    const countSeries = async () =>
      (await scrape()).text.split('\n').filter((l) => l.startsWith('gymsera_http_requests_total{')).length;
    await request(app).get('/api/v1/team');
    const before = await countSeries();
    for (let i = 0; i < 25; i++) {
      await request(app).get(`/api/v1/team/random-${i}-${Math.random().toString(36).slice(2)}`);
      await request(app).get(`/api/v1/random-${i}/${Math.random().toString(36).slice(2)}`);
      await request(app).get(`/random-${i}`);
    }
    // team/* 401 (already there) + /api/v1/* 404 + unmatched 404 = at most 2 new series
    expect(await countSeries() - before).toBeLessThanOrEqual(2);
  });

  test('a parameterised route is labelled by its pattern, not the value', async () => {
    await request(app).get('/api/v1/discovery/gyms/11111111-2222-3333-4444-555555555555');
    const text = (await scrape()).text;
    expect(text).toMatch(/route="\/api\/v1\/discovery\/gyms\/:id"/);
    expect(text).not.toContain('11111111-2222-3333-4444-555555555555');
  });

  test('a 5xx is counted with its status so errors can be rated (mini app)', async () => {
    const mini = express();
    mini.use(metrics.httpMiddleware);
    mini.get('/boom/:id', (_req, res) => res.status(500).json({ ok: false }));
    mini.use('/mounted/:tenant', express.Router().get('/ping', (_req, res) => res.send('pong')));
    const server = http.createServer(mini);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await request(server).get('/boom/42');
      await request(server).get('/mounted/9f1c2d3e-aaaa-bbbb-cccc-111122223333/ping');
    } finally {
      await new Promise((r) => server.close(r));
    }
    const text = (await scrape()).text;
    expect(value(text, 'gymsera_http_requests_total{method="GET",route="/boom/:id",status="500"}')).toBe(1);
    // a mount path that carries a value is normalised, never a raw id
    expect(text).not.toContain('9f1c2d3e');
    expect(text).toMatch(/route="\/mounted\/:id\/ping"/);
  });

  test('scraping /metrics itself is not recorded', async () => {
    await scrape();
    await scrape();
    expect((await scrape()).text).not.toContain('route="/metrics"');
  });
});

describe('OBS-03: database pools (totals plus the top 10 tenants)', () => {
  const fakePool = (id, using, waiting, size) => ({
    tenantId: id,
    lastUsedAt: Date.now(),
    sequelize: { connectionManager: { pool: { size, using, waiting } }, close: async () => {} },
  });
  afterEach(async () => {
    await TenantDbManager.releaseAll().catch(() => {});
  });

  test('totals match TenantDbManager.getMetrics()', async () => {
    TenantDbManager.pool.clear();
    TenantDbManager.pool.set('t-a', fakePool('t-a', 2, 1, 3));
    TenantDbManager.pool.set('t-b', fakePool('t-b', 1, 0, 2));
    const m = TenantDbManager.getMetrics();
    const text = (await scrape()).text;
    expect(value(text, 'gymsera_tenant_pools_open')).toBe(m.openPools);
    expect(value(text, 'gymsera_tenant_pool_connections')).toBe(5);
    expect(value(text, 'gymsera_tenant_pool_in_use')).toBe(3);
    expect(value(text, 'gymsera_tenant_pool_waiting')).toBe(1);
    expect(value(text, 'gymsera_tenant_pool_cap')).toBe(m.cap);
  });

  test('only the 10 busiest tenants get their own series, busiest first', async () => {
    TenantDbManager.pool.clear();
    for (let i = 1; i <= 15; i++) TenantDbManager.pool.set(`tenant-${i}`, fakePool(`tenant-${i}`, i, 0, i + 1));
    const text = (await scrape()).text;
    const series = text.split('\n').filter((l) => l.startsWith('gymsera_tenant_pool_top_in_use{'));
    expect(series).toHaveLength(10);
    expect(series.map((l) => l.match(/tenant_id="([^"]+)"/)[1])).toEqual(
      expect.arrayContaining(['tenant-15', 'tenant-14', 'tenant-6'])
    );
    expect(text).not.toContain('tenant_id="tenant-5"');
    // the label is the tenant id, nothing else about the tenant
    expect(text).not.toMatch(/gymsera_tenant_pool_top_[a-z_]+\{[^}]*(name|email|gym)/i);
  });

  test('a tenant that dropped out of the top 10 leaves no stale series', async () => {
    TenantDbManager.pool.clear();
    TenantDbManager.pool.set('only-one', fakePool('only-one', 3, 0, 3));
    expect((await scrape()).text).toContain('tenant_id="only-one"');
    TenantDbManager.pool.clear();
    expect((await scrape()).text).not.toContain('tenant_id="only-one"');
  });

  test('the platform pool is reported too', async () => {
    const text = (await scrape()).text;
    expect(text).toContain('gymsera_platform_pool_connections');
    expect(text).toContain('gymsera_platform_pool_in_use');
  });
});

describe('OBS-03: webhook lag, outbox lag, FCM failures, sockets', () => {
  const mkEvent = (over) =>
    BillingEvent.create({
      provider: 'APPLE',
      providerEventId: `evt-${Math.random().toString(36).slice(2)}`,
      rawPayload: '{}',
      status: 'RECEIVED',
      receivedAt: new Date(),
      ...over,
    });

  test('billing events: unprocessed count, age of the oldest, failed count', async () => {
    await resetTestDatabases();
    await mkEvent({ receivedAt: new Date(Date.now() - 20 * 60 * 1000) });
    await mkEvent({ receivedAt: new Date(Date.now() - 2 * 60 * 1000) });
    await mkEvent({ status: 'FAILED', attempts: 3 });
    await mkEvent({ status: 'PROCESSED' });
    metrics._resetForTests();
    metrics.init();
    const text = (await scrape()).text;
    expect(value(text, 'gymsera_billing_events_unprocessed')).toBe(2);
    expect(value(text, 'gymsera_billing_events_failed')).toBe(1);
    const age = value(text, 'gymsera_billing_events_oldest_unprocessed_age_seconds');
    expect(age).toBeGreaterThanOrEqual(1190);
    expect(age).toBeLessThan(1300);
  });

  test('a database error while reading billing events never breaks the scrape', async () => {
    jest.spyOn(BillingEvent, 'count').mockRejectedValue(new Error('db gone'));
    jest.spyOn(BillingEvent, 'findOne').mockRejectedValue(new Error('db gone'));
    metrics._resetForTests();
    metrics.init();
    const res = await scrape();
    expect(res.status).toBe(200);
    expect(res.text).toContain('gymsera_http_requests_total');
  });

  test('the billing-event reads are cached for a few seconds, so a busy scraper does not hammer the database', async () => {
    const spy = jest.spyOn(BillingEvent, 'count');
    await scrape();
    await scrape();
    await scrape();
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2); // one refresh = unprocessed + failed
  });

  test('capacity outbox: the sweep reports pending, dead-lettered and the oldest age', async () => {
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    const tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    const { CapacityOutbox } = dbHarness.tenant1.models;
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    // attempts >= 10: the sweep gives up on it for good, so it stays and ages
    await CapacityOutbox.create({ eventType: 'CAPACITY_STEP', payloadJson: {}, idempotencyKey: 'dead-1', status: 'FAILED', attempts: 10, createdAt: old });
    await CapacityOutbox.create({ eventType: 'CAPACITY_STEP', payloadJson: {}, idempotencyKey: 'ok-1', status: 'PROCESSED', attempts: 1 });
    metrics._resetForTests();
    metrics.init();
    await require('../../src/services/capacity-outbox.service').sweepAllTenantsOutbox();
    const text = (await scrape()).text;
    expect(value(text, 'gymsera_capacity_outbox_unprocessed')).toBe(1);
    expect(value(text, 'gymsera_capacity_outbox_oldest_age_seconds')).toBeGreaterThanOrEqual(2 * 24 * 3600 - 60);
    expect(value(text, 'gymsera_capacity_outbox_last_sweep_timestamp_seconds')).toBeGreaterThan(Date.now() / 1000 - 120);
    expect(tenant.id).toBeDefined();
  });

  test('FCM: multicast success and failure counts, a failed batch, and single sends', async () => {
    const push = require('../../src/services/push.service');
    mockMulti.mockResolvedValueOnce({ successCount: 3, failureCount: 2, responses: [] });
    await push.sendMulticast(['t1', 't2', 't3', 't4', 't5'], 'Hello', 'World');
    mockMulti.mockRejectedValueOnce(new Error('fcm down'));
    await push.sendMulticast(['t1', 't2'], 'Hello', 'World');
    mockSend.mockResolvedValueOnce('msg-1');
    await push.send('tok-ok-tok-ok-tok-ok-0001', 'Hi', 'There');
    mockSend.mockRejectedValueOnce(Object.assign(new Error('bad token'), { code: 'messaging/internal-error' }));
    await push.send('tok-bad-tok-bad-tok-bad-01', 'Hi', 'There');
    const text = (await scrape()).text;
    expect(value(text, 'gymsera_fcm_messages_total{result="success"}')).toBe(4);
    expect(value(text, 'gymsera_fcm_messages_total{result="failure"}')).toBe(3);
    expect(value(text, 'gymsera_fcm_batch_errors_total')).toBe(1);
    // no token, title, body or message id in any label
    for (const leaked of ['tok-ok', 'tok-bad', 'Hello', 'World', 'msg-1']) expect(text).not.toContain(leaked);
  });

  test('sockets: the open connection count', async () => {
    const socketGateway = require('../../src/socket');
    jest.spyOn(socketGateway, 'getIO').mockReturnValue({ engine: { clientsCount: 7 } });
    expect(value((await scrape()).text, 'gymsera_socket_connections')).toBe(7);
    socketGateway.getIO.mockReturnValue(null);
    expect(value((await scrape()).text, 'gymsera_socket_connections')).toBe(0);
  });
});

describe('OBS-03: no personal data in any label', () => {
  test('after a mix of traffic every label name is on the allow-list and no value looks like personal data', async () => {
    await request(app).get('/api/v1/health');
    await request(app).get('/api/v1/team');
    await request(app).get('/x/owner@example.test/+923001112223?token=abc');
    const text = (await scrape()).text;
    const allowed = new Set(['method', 'route', 'status', 'le', 'tenant_id', 'result', 'quantile', 'version', 'major', 'minor', 'patch', 'name', 'type', 'kind', 'space']);
    const names = new Set();
    for (const m of text.matchAll(/(\w+)="/g)) names.add(m[1]);
    for (const n of names) expect(allowed.has(n)).toBe(true);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/\+\d{10,}/);
    expect(text).not.toContain('token=');
  });
});

describe('OBS-03: the process keeps running without the registry', () => {
  test('default process metrics are present when enabled', async () => {
    expect((await scrape()).text).toContain('gymsera_process_cpu_user_seconds_total');
  });
});
