/**
 * PERF-07 (spec §10.7): TenantDbManager keeps a bounded set of tenant pools.
 *  - each pool is capped at TENANT_POOL_MAX_CONNECTIONS connections
 *  - past TENANT_POOL_CAP open pools the least recently used IDLE pool is closed
 *  - a pool with a borrowed connection is never evicted
 *  - a recently used pool is never evicted
 *  - an evicted tenant simply reconnects on its next request
 */
const { setupTestDatabases, teardownTestDatabases, factories } = require('../harness');
const TenantDbManager = require('../../src/database/TenantDbManager');

describe('PERF-07: tenant pool cap + idle-only LRU eviction', () => {
  let tenants;

  beforeAll(async () => {
    await setupTestDatabases();
    process.env.TENANT_POOL_CAP = '3';
    process.env.TENANT_POOL_MIN_IDLE_BEFORE_EVICT_MS = '0';
    process.env.TENANT_POOL_MAX_CONNECTIONS = '2';
    tenants = [];
    for (let i = 0; i < 6; i += 1) tenants.push(await factories.createTenant({ gymName: `Pool ${i}` }));
  });

  beforeEach(async () => {
    await TenantDbManager.releaseAll();
    TenantDbManager.evictions = 0;
  });

  afterAll(async () => {
    delete process.env.TENANT_POOL_CAP;
    delete process.env.TENANT_POOL_MIN_IDLE_BEFORE_EVICT_MS;
    delete process.env.TENANT_POOL_MAX_CONNECTIONS;
    await TenantDbManager.releaseAll();
    await teardownTestDatabases();
  });

  const open = (t) => TenantDbManager.getConnection(t.id, t.connectionStringEncrypted);
  const settle = () => new Promise((r) => setTimeout(r, 50));

  test('each tenant pool is capped at the configured connection count', async () => {
    const entry = await open(tenants[0]);
    expect(entry.sequelize.connectionManager.pool.maxSize).toBe(2);
  });

  test('opening more pools than the cap evicts the least recently used idle ones', async () => {
    for (const t of tenants) { await open(t); await settle(); }
    await settle();
    expect(TenantDbManager.pool.size).toBe(3);
    // the three most recently opened survive
    expect([...TenantDbManager.pool.keys()].sort()).toEqual(tenants.slice(3).map((t) => t.id).sort());
    expect(TenantDbManager.getMetrics()).toMatchObject({ openPools: 3, cap: 3, evictions: 3 });
  });

  test('a pool with a borrowed connection is never evicted, even when it is the oldest', async () => {
    const busy = await open(tenants[0]);
    const conn = await busy.sequelize.connectionManager.getConnection(); // borrowed → using = 1
    try {
      for (const t of tenants.slice(1)) { await open(t); await settle(); }
      await settle();
      expect(TenantDbManager.pool.has(tenants[0].id)).toBe(true);
      expect(TenantDbManager.pool.get(tenants[0].id)).toBe(busy);
    } finally {
      await busy.sequelize.connectionManager.releaseConnection(conn);
    }
  });

  test('a pool with a request waiting for a connection is never evicted', async () => {
    const busy = await open(tenants[0]);
    const cm = busy.sequelize.connectionManager;
    const held = [await cm.getConnection(), await cm.getConnection()]; // max = 2, pool exhausted
    const waiter = cm.getConnection(); // third caller queues → waiting = 1
    await settle();
    try {
      expect(cm.pool.waiting).toBe(1);
      for (const t of tenants.slice(1)) { await open(t); await settle(); }
      await settle();
      expect(TenantDbManager.pool.get(tenants[0].id)).toBe(busy);
    } finally {
      await cm.releaseConnection(held[0]);
      const third = await waiter;
      await cm.releaseConnection(third);
      await cm.releaseConnection(held[1]);
    }
  });

  test('a recently used pool is not evicted while the idle grace period has not passed', async () => {
    process.env.TENANT_POOL_MIN_IDLE_BEFORE_EVICT_MS = '60000';
    try {
      for (const t of tenants) await open(t);
      await settle();
      expect(TenantDbManager.pool.size).toBe(6); // soft cap: all are recent, none evicted
      expect(TenantDbManager.getMetrics().evictions).toBe(0);
    } finally {
      process.env.TENANT_POOL_MIN_IDLE_BEFORE_EVICT_MS = '0';
    }
  });

  test('an evicted tenant reconnects and works on its next request', async () => {
    for (const t of tenants) { await open(t); await settle(); }
    await settle();
    expect(TenantDbManager.pool.has(tenants[0].id)).toBe(false);
    const again = await open(tenants[0]);
    const [rows] = await again.sequelize.query('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  });

  test('concurrent first requests for one tenant share a single pool', async () => {
    const [a, b, c] = await Promise.all([open(tenants[0]), open(tenants[0]), open(tenants[0])]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(TenantDbManager.pool.size).toBe(1);
  });
});
