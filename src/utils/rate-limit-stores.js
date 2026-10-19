/**
 * Rate limiter stores that can be shut down.
 *
 * express-rate-limit's MemoryStore starts a repeating `setInterval(..., windowMs)` when a limiter is
 * created (unref'd, so it never keeps the process alive). In production there is one app per process and
 * that is fine. In a test run, every test file builds its own app, and the timer is a real Node timer
 * that outlives the file: its closure keeps that file's whole module graph reachable (~22 MB per file),
 * which exhausted the heap of `jest --runInBand` in CI. Creating the stores here lets the test harness
 * (tests/harness/release-limiter-timers.js) stop them after every file. Same MemoryStore, same interval,
 * same behaviour in production.
 */
const { MemoryStore } = require('express-rate-limit');

const stores = new Set();

/** A MemoryStore for one limiter. Use as `rateLimit({ store: createMemoryStore(), ... })`. */
const createMemoryStore = () => {
  const store = new MemoryStore();
  stores.add(store);
  return store;
};

/** Stops every store's timer and forgets the stores. Never throws. */
const shutdownAll = () => {
  for (const store of stores) {
    try {
      store.shutdown();
    } catch (_) {
      /* one failing store must not leave the others running */
    }
  }
  stores.clear();
};

const activeStores = () => [...stores];

module.exports = { createMemoryStore, shutdownAll, activeStores };
