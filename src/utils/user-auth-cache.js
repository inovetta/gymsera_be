'use strict';

/**
 * In-process bounded LRU/FIFO cache for user auth metadata (permissionVersion & status).
 * Avoids per-request DB queries when Redis is absent/down.
 *
 * Spec §8.2 / AUTH-08 / 2A Blocker 2:
 * - Default TTL: 30 seconds
 * - Bounded capacity: 5,000 entries (evicts oldest on overflow)
 * - Synchronously cleared on permission change or user deletion in the same process
 */

const MAX_ENTRIES = 5000;
const DEFAULT_TTL_MS = 30 * 1000; // 30 seconds

// Map preserves insertion order; deleting and re-inserting provides LRU behavior.
const _cache = new Map();

/**
 * Retrieve user auth metadata from in-process cache if present and not expired.
 * @param {string|number} userId
 * @returns {{ status: string, ver: number } | null}
 */
function getUserAuthCache(userId) {
  if (!userId) return null;
  const key = String(userId);
  const entry = _cache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }

  // Refresh LRU order on hit
  _cache.delete(key);
  _cache.set(key, entry);

  return entry.userMeta;
}

/**
 * Store user auth metadata into in-process cache with TTL and capacity bounds.
 * @param {string|number} userId
 * @param {{ status: string, ver: number }} userMeta
 * @param {number} [ttlMs=30000]
 */
function setUserAuthCache(userId, userMeta, ttlMs = DEFAULT_TTL_MS) {
  if (!userId || !userMeta) return;
  const key = String(userId);

  // If already exists, delete first to refresh position
  if (_cache.has(key)) {
    _cache.delete(key);
  } else if (_cache.size >= MAX_ENTRIES) {
    // Evict oldest entry (first key in iteration order)
    const oldestKey = _cache.keys().next().value;
    if (oldestKey !== undefined) {
      _cache.delete(oldestKey);
    }
  }

  _cache.set(key, {
    userMeta: {
      status: userMeta.status,
      ver: Number(userMeta.ver || 1),
    },
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Clear in-process cache entry for a user, or all entries.
 * Must be called on permission bump or account deletion/status change in the same process.
 * @param {string|number} [userId]
 */
function clearUserAuthCache(userId) {
  if (userId) {
    _cache.delete(String(userId));
  } else {
    _cache.clear();
  }
}

/**
 * Get current entry count (for telemetry / tests).
 * @returns {number}
 */
function getUserAuthCacheSize() {
  return _cache.size;
}

module.exports = {
  getUserAuthCache,
  setUserAuthCache,
  clearUserAuthCache,
  getUserAuthCacheSize,
  MAX_ENTRIES,
  DEFAULT_TTL_MS,
};
