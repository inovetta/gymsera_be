'use strict';

/**
 * Regression test for REL-03: MySQL GET_LOCK fallback when Redis is disabled.
 *
 * Requirements:
 * - Runs with Redis DISABLED (DISABLE_REDIS=true).
 * - No mocks of the lock (exercises real MySQL platform DB GET_LOCK / RELEASE_LOCK).
 * - MySQL fallback must acquire and release a lock.
 * - A second concurrent caller must be refused (lock collision).
 * - After release, subsequent acquisition must succeed.
 */

process.env.DISABLE_REDIS = 'true';

const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { acquireDistributedLock, withDistributedLock } = require('../../src/utils/distributed-lock');

describe('REL-03: MySQL GET_LOCK fallback without Redis', () => {
  beforeAll(async () => {
    await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('acquireDistributedLock acquires and releases MySQL lock, refusing concurrent caller', async () => {
    const lockName = `test_raw_lock_${Date.now()}`;

    // 1. First caller acquires lock
    const lock1 = await acquireDistributedLock(lockName, 10000);
    expect(lock1.acquired).toBe(true);

    // 2. Second concurrent caller must be refused
    const lock2 = await acquireDistributedLock(lockName, 10000);
    expect(lock2.acquired).toBe(false);

    // 3. First caller releases lock
    await lock1.release();

    // 4. Subsequent caller can now acquire lock
    const lock3 = await acquireDistributedLock(lockName, 10000);
    expect(lock3.acquired).toBe(true);
    await lock3.release();
  });

  test('withDistributedLock runs exclusively and refuses second concurrent execution', async () => {
    const lockName = `test_with_lock_${Date.now()}`;
    let p1StartedResolve;
    const p1Started = new Promise((resolve) => { p1StartedResolve = resolve; });
    let p2Attempted = false;

    // Worker 1 holds lock
    const p1 = withDistributedLock(lockName, 10000, async () => {
      p1StartedResolve();
      await new Promise((r) => setTimeout(r, 150));
      return 'worker1_done';
    });

    await p1Started;

    // Worker 2 attempts while worker 1 holds lock -> must be refused / skipped
    const res2 = await withDistributedLock(lockName, 10000, async () => {
      p2Attempted = true;
      return 'worker2_done';
    });

    expect(res2.skipped).toBe(true);
    expect(p2Attempted).toBe(false);

    const res1 = await p1;
    expect(res1.skipped).toBe(false);
    expect(res1.result).toBe('worker1_done');

    // After worker 1 completes, running again must succeed
    const res3 = await withDistributedLock(lockName, 10000, async () => {
      return 'worker3_done';
    });
    expect(res3.skipped).toBe(false);
    expect(res3.result).toBe('worker3_done');
  });
});
