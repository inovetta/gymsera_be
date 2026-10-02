'use strict';

/**
 * Regression tests for REL-03, REL-04, REL-05:
 * REL-03: Distributed lock prevents duplicate job runs across instances (Redis SET NX PX / MySQL GET_LOCK).
 * REL-04: Subscription expiry cron marks subscriptions EXPIRED without mutating Tenant status to SUSPENDED.
 * REL-05: Graceful shutdown cleans up in-flight requests, socket connections, tenant DB connection pools, and Redis.
 */

const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { withDistributedLock } = require('../../src/utils/distributed-lock');
const { runExpiryCheck } = require('../../src/jobs/subscription-expiry.cron');
const { Tenant, TenantSubscription, User } = require('../../src/models/platform');

describe('Prompt 2A: REL-03 and REL-04 Reliability', () => {
  beforeAll(async () => {
    await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('REL-03: Distributed Locking', () => {
    test('Acquires lock, executes worker function, and releases lock', async () => {
      let executedCount = 0;
      const lockKey = 'test:lock:rel03:unique';

      const res = await withDistributedLock(lockKey, 10000, async () => {
        executedCount++;
        return 'work_completed';
      });

      expect(res.skipped).toBe(false);
      expect(res.result).toBe('work_completed');
      expect(executedCount).toBe(1);

      // Immediately running again should succeed because lock was released
      const res2 = await withDistributedLock(lockKey, 10000, async () => {
        executedCount++;
        return 'second_run';
      });

      expect(res2.skipped).toBe(false);
      expect(res2.result).toBe('second_run');
      expect(executedCount).toBe(2);
    });

    test('Concurrent lock acquisition fails/skips the second worker while first is active', async () => {
      const lockKey = 'test:lock:rel03:concurrent';
      let secondRan = false;
      let p1StartedResolve;
      const p1Started = new Promise((resolve) => { p1StartedResolve = resolve; });

      // First worker holds lock for 200ms
      const p1 = withDistributedLock(lockKey, 10000, async () => {
        p1StartedResolve();
        await new Promise((r) => setTimeout(r, 200));
        return 'p1_done';
      });

      // Wait until p1 is actively inside the lock
      await p1Started;

      // Second worker attempts while p1 is running
      const res2 = await withDistributedLock(lockKey, 10000, async () => {
        secondRan = true;
        return 'p2_done';
      });

      expect(res2.skipped).toBe(true);
      expect(secondRan).toBe(false);

      const res1 = await p1;
      expect(res1.skipped).toBe(false);
      expect(res1.result).toBe('p1_done');
    });
  });

  describe('REL-04: Subscription Expiry Cron Safe Execution', () => {
    let activeTenant;
    let expiredSub;

    beforeEach(async () => {
      const owner = await User.create({
        fullName: 'Rel04 Owner',
        email: `owner_${Date.now()}@example.test`,
        passwordHash: 'dummy-hash',
        role: 'MEMBER',
        isHost: true,
        status: 'ACTIVE',
      });

      // Create a tenant in ACTIVE status
      activeTenant = await Tenant.create({
        tenantCode: 'TEN-REL04-' + Date.now(),
        businessName: 'Rel04 Gym',
        ownerUserId: owner.id,
        email: owner.email,
        status: 'ACTIVE',
        dbName: 'gymsera_ten_rel04',
      });

      // Create an expired subscription for this tenant (yesterday end date)
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const pastStart = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      expiredSub = await TenantSubscription.create({
        tenantId: activeTenant.id,
        platform: 'MANUAL',
        status: 'ACTIVE',
        startDate: pastStart,
        endDate: yesterday,
        amount: 1000,
        billingCycle: 'MONTHLY',
        autoRenew: false,
      });
    });

    test('Expires subscription row without changing Tenant status to SUSPENDED', async () => {
      // Run the expiry check
      await runExpiryCheck();

      // Reload subscription
      await expiredSub.reload();
      expect(expiredSub.status).toBe('EXPIRED');

      // Reload tenant: MUST REMAIN 'ACTIVE', NOT 'SUSPENDED' (REL-04)
      await activeTenant.reload();
      expect(activeTenant.status).toBe('ACTIVE');
    });
  });
});
