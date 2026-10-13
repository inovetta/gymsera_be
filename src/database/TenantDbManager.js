const { Sequelize } = require('sequelize');
const { decrypt } = require('../utils/crypto.utils');
const registerTenantModels = require('../models/tenant');

/**
 * TenantDbManager
 *
 * Maintains a pool of Sequelize instances, one per tenant.
 * Keyed by tenantId — connections are reused across requests.
 *
 * PERF-07 (spec §10.7): the map is bounded.
 *  - Each tenant pool holds at most TENANT_POOL_MAX_CONNECTIONS connections
 *    (default 3) and drops idle connections after TENANT_POOL_IDLE_MS (10 s).
 *  - When more than TENANT_POOL_CAP tenants (default 200) are open, the least
 *    recently used tenant pool is closed — but ONLY an idle one: no borrowed
 *    connection, nobody waiting for one, and unused for at least
 *    TENANT_POOL_MIN_IDLE_BEFORE_EVICT_MS (default 60 s, longer than the 15 s
 *    request timeout). A busy pool is never evicted; if every pool is busy the
 *    map stays above the cap until one goes idle (it is a soft cap by design).
 *
 * Usage:
 *   const { models } = await TenantDbManager.getConnection(tenantId, encryptedConnStr);
 *   const { Gym, Branch } = models;
 */
const intEnv = (name, fallback, min = 1) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

class TenantDbManager {
  constructor() {
    /** @type {Map<string, { sequelize: Sequelize, models: object, tenantId: string, lastUsedAt: number }>} */
    this.pool = new Map();
    /** @type {Map<string, Promise<object>>} in-flight creations, so one tenant never gets two pools */
    this.creating = new Map();
    this.evictions = 0;
  }

  get config() {
    return {
      cap: intEnv('TENANT_POOL_CAP', 200),
      maxConnections: intEnv('TENANT_POOL_MAX_CONNECTIONS', 3),
      idleMs: intEnv('TENANT_POOL_IDLE_MS', 10000),
      minIdleBeforeEvictMs: intEnv('TENANT_POOL_MIN_IDLE_BEFORE_EVICT_MS', 60000, 0),
    };
  }

  /**
   * Return (or create) the Sequelize instance + models for a tenant.
   * @param {string} tenantId              UUID of the tenant
   * @param {string} encryptedConnStr      AES-256 encrypted MySQL connection URL
   */
  async getConnection(tenantId, encryptedConnStr) {
    const existing = this.pool.get(tenantId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const inFlight = this.creating.get(tenantId);
    if (inFlight) return inFlight;

    const promise = this._create(tenantId, encryptedConnStr).finally(() => {
      this.creating.delete(tenantId);
    });
    this.creating.set(tenantId, promise);
    return promise;
  }

  async _create(tenantId, encryptedConnStr) {
    const connUrl = decrypt(encryptedConnStr);
    const { maxConnections, idleMs } = this.config;

    const sequelize = new Sequelize(connUrl, {
      dialect: 'mysql',
      logging: false,
      pool: { max: maxConnections, min: 0, acquire: 20000, idle: idleMs },
      dialectOptions: {
        connectTimeout: 20000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
      },
      define: {
        underscored: true,
        timestamps: true,
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
      },
    });

    try {
      await sequelize.authenticate();
    } catch (err) {
      await sequelize.close().catch(() => {});
      throw err;
    }

    const models = registerTenantModels(sequelize);

    // Zero writes on connection (spec §6.5, §9.6):
    // Schema alterations and data backfills are strictly performed via the versioned
    // tenant migration runner (src/database/tenant-migration-runner.js), NEVER on getConnection.

    const entry = { sequelize, models, tenantId, lastUsedAt: Date.now() };
    this.pool.set(tenantId, entry);
    this._evictIdleOverCap(tenantId).catch(() => {});
    return entry;
  }

  /** A tenant pool is idle when no connection is borrowed and nobody is waiting for one. */
  _isIdle(entry, now, minIdleMs) {
    if (now - entry.lastUsedAt < minIdleMs) return false;
    const cm = entry.sequelize.connectionManager;
    const p = cm && cm.pool;
    if (!p) return true;
    return p.using === 0 && p.waiting === 0;
  }

  /**
   * Close least-recently-used idle pools until the map is within the cap.
   * Never closes a busy pool, and never the one just opened (`keepTenantId`).
   */
  async _evictIdleOverCap(keepTenantId = null) {
    const { cap, minIdleBeforeEvictMs } = this.config;
    if (this.pool.size <= cap) return 0;

    const now = Date.now();
    const candidates = [...this.pool.values()]
      .filter((e) => e.tenantId !== keepTenantId && this._isIdle(e, now, minIdleBeforeEvictMs))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    let evicted = 0;
    for (const entry of candidates) {
      if (this.pool.size <= cap) break;
      // Re-check just before closing: a request may have borrowed it meanwhile.
      if (!this._isIdle(entry, Date.now(), minIdleBeforeEvictMs)) continue;
      if (this.pool.get(entry.tenantId) !== entry) continue;
      this.pool.delete(entry.tenantId);
      await entry.sequelize.close().catch(() => {});
      this.evictions += 1;
      evicted += 1;
    }
    if (evicted > 0) {
      console.log(`[TenantDbManager] evicted ${evicted} idle tenant pool(s); open=${this.pool.size} cap=${cap}`);
    }
    return evicted;
  }

  /** Public handle for tests and for a periodic sweep. */
  evictIdle() {
    return this._evictIdleOverCap(null);
  }

  /** Open-pool metrics (PERF-07). Counts only, no tenant data. */
  getMetrics() {
    let connections = 0;
    let inUse = 0;
    let waiting = 0;
    for (const e of this.pool.values()) {
      const p = e.sequelize.connectionManager && e.sequelize.connectionManager.pool;
      if (!p) continue;
      connections += p.size || 0;
      inUse += p.using || 0;
      waiting += p.waiting || 0;
    }
    return {
      openPools: this.pool.size,
      cap: this.config.cap,
      connections,
      inUse,
      waiting,
      evictions: this.evictions,
    };
  }

  /**
   * Close and remove a tenant connection from the pool.
   * Called during tenant suspension or when cleaning up stale connections.
   */
  async release(tenantId) {
    const entry = this.pool.get(tenantId);
    if (entry) {
      this.pool.delete(tenantId);
      await entry.sequelize.close();
    }
  }

  /**
   * Close all pooled connections. Called on graceful shutdown.
   */
  async releaseAll() {
    const promises = [];
    for (const [tenantId] of this.pool) {
      promises.push(this.release(tenantId));
    }
    await Promise.all(promises);
  }

  /**
   * Return all currently-pooled [tenantId, tenantDb] entries.
   * Used by the subscription expiry cron to iterate live connections.
   * @returns {Array<[string, { sequelize, models }]>}
   */
  getAllEntries() {
    return [...this.pool.entries()];
  }
}

module.exports = new TenantDbManager();
