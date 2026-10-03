const { ensureRedisReady } = require('../config/redis.config');
const { sequelize: platformSequelize } = require('../database/platform');
const crypto = require('crypto');

/**
 * Acquire a distributed lock (spec REL-03).
 * Uses Redis `SET lockKey lockValue NX PX ttlMs`.
 * If Redis is not available, falls back to MySQL `GET_LOCK` on platform DB.
 *
 * @param {string} lockName - Logical identifier for the lock (e.g. 'cron:subscription-expiry')
 * @param {number} ttlMs - TTL in milliseconds (default: 300,000 = 5 minutes)
 * @returns {Promise<{ acquired: boolean, release: () => Promise<void> }>}
 */
async function acquireDistributedLock(lockName, ttlMs = 300000) {
  const lockKey = `lock:${lockName}`;
  const token = crypto.randomUUID();

  try {
    const redis = await ensureRedisReady();
    if (redis) {
      const res = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
      if (res === 'OK') {
        return {
          acquired: true,
          release: async () => {
            const script = `
              if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
              else
                return 0
              end
            `;
            try {
              await redis.eval(script, 1, lockKey, token);
            } catch (err) {
              console.warn(`[Lock] Redis release failed for ${lockName}:`, err.message);
            }
          },
        };
      }
      return { acquired: false, release: async () => {} };
    }
  } catch (err) {
    console.warn(`[Lock] Redis lock attempt failed for ${lockName}, falling back to MySQL:`, err.message);
  }

  // Fallback to MySQL GET_LOCK using a dedicated connection
  try {
    const timeoutSec = 0; // Non-blocking
    const safeName = `gymsera_${lockName}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
    const conn = await platformSequelize.connectionManager.getConnection();

    try {
      const [results] = await conn.query('SELECT GET_LOCK(?, ?) AS lockResult', [safeName, timeoutSec]);
      const firstRow = Array.isArray(results) ? results[0] : results;
      const lockResult = firstRow && (firstRow.lockResult === 1 || firstRow.lockResult === '1');

      if (lockResult) {
        return {
          acquired: true,
          release: async () => {
            try {
              await conn.query('SELECT RELEASE_LOCK(?) AS unlockResult', [safeName]);
            } catch (unlockErr) {
              console.warn(`[Lock] MySQL release failed for ${lockName}:`, unlockErr.message);
            } finally {
              await platformSequelize.connectionManager.releaseConnection(conn).catch(() => {});
            }
          },
        };
      }
      await platformSequelize.connectionManager.releaseConnection(conn).catch(() => {});
      return { acquired: false, release: async () => {} };
    } catch (queryErr) {
      await platformSequelize.connectionManager.releaseConnection(conn).catch(() => {});
      throw queryErr;
    }
  } catch (mysqlErr) {
    console.warn(`[Lock] MySQL lock attempt failed for ${lockName}:`, mysqlErr.message);
    return { acquired: false, release: async () => {} };
  }
}

/**
 * Helper to run an async job wrapped in a distributed lock.
 * If lock cannot be acquired, logs and returns { skipped: true }.
 */
async function withDistributedLock(lockName, ttlMs, fn) {
  const lock = await acquireDistributedLock(lockName, ttlMs);
  if (!lock.acquired) {
    console.log(`[Lock] Skipping job '${lockName}' — lock is already held by another instance`);
    return { skipped: true };
  }

  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    await lock.release();
  }
}

module.exports = {
  acquireDistributedLock,
  withDistributedLock,
};
