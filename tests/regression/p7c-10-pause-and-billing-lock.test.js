/**
 * P7c with P5b (owner, 2026-10-30): a billing lock and a host pause are different states.
 *
 *   billing lock — branches.billing_locked_at, set and cleared only by the capacity
 *                  sweep (branch-billing-lock.service.js), from the plan;
 *   host pause   — branches.paused_at (P5b, tenant migration 021), set and cleared only
 *                  by the host (gym.service.js#pauseBranch / #resumeBranch).
 *
 * Rules tested here:
 *   1. resuming a paused branch never clears its billing lock;
 *   2. unlocking (a plan entitles again) never resumes a paused branch;
 *   3. a paused branch stays ACTIVE and holds its capacity, so it counts once (never twice,
 *      never zero) in over-quota decisions, and a repeated sweep never unlocks it by accident.
 */
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { City, TenantSubscription } = require('../../src/models/platform');
const gymService = require('../../src/services/gym.service');
const lockService = require('../../src/services/branch-billing-lock.service');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const { reconcileCapacityForAllTenants } = require('../../src/jobs/subscription-expiry.cron');

const DAY = 24 * 60 * 60 * 1000;
const REAL_TIMERS = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
];

describe('P7c with P5b: a billing lock and a host pause are separate states', () => {
  let dbHarness;
  let tenantDb;
  let tenant;
  let branches;
  let start;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenantDb = dbHarness.tenant1;
  });

  afterAll(async () => {
    jest.useRealTimers();
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await resetTestDatabases();
    start = Date.now();
    jest.useFakeTimers({ doNotFake: REAL_TIMERS, now: start });
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    const listing = await factories.createGymListing(tenant.id);
    branches = [
      await factories.createBranch(tenantDb, listing.id, { branchName: 'Open', createdAt: new Date(start - 2 * DAY) }),
      await factories.createBranch(tenantDb, listing.id, { branchName: 'Paused', createdAt: new Date(start - DAY) }),
    ];
  });

  const [OPEN, PAUSED] = [0, 1];
  const reload = () => Promise.all(branches.map((b) => b.reload()));
  const lapse = async () =>
    factories.createTenantSubscription(tenant.id, { platform: 'MANUAL', status: 'EXPIRED', branchCount: 5 });
  const afterGrace = async () => {
    jest.setSystemTime(start + 8 * DAY);
    await reconcileCapacityForAllTenants();
    await reload();
  };

  test('resuming a paused, billing-locked branch keeps the billing lock', async () => {
    await gymService.pauseBranch(tenantDb, branches[PAUSED].id, tenant.ownerUserId);
    await lapse();
    await afterGrace();
    expect(branches[PAUSED].billingLockedAt).not.toBeNull();
    const lockedAt = branches[PAUSED].billingLockedAt.getTime();

    await gymService.resumeBranch(tenantDb, branches[PAUSED].id);
    await reload();
    expect(branches[PAUSED].pausedAt).toBeNull();
    expect(branches[PAUSED].billingLockedAt.getTime()).toBe(lockedAt);
    expect(() => lockService.assertBranchNotBillingLocked(branches[PAUSED])).toThrow(
      expect.objectContaining({ code: 'branch_billing_locked' })
    );

    // Pausing a locked branch does not clear the lock either.
    await gymService.pauseBranch(tenantDb, branches[OPEN].id, tenant.ownerUserId);
    await reload();
    expect(branches[OPEN].billingLockedAt).not.toBeNull();
  });

  test('a plan that entitles again unlocks every branch and leaves the paused one paused', async () => {
    await gymService.pauseBranch(tenantDb, branches[PAUSED].id, tenant.ownerUserId);
    const pausedAt = (await branches[PAUSED].reload()).pausedAt.getTime();
    const ended = await lapse();
    await afterGrace();
    expect(branches.every((b) => b.billingLockedAt)).toBe(true);

    await ended.update({ status: 'ACTIVE', endDate: new Date(start + 40 * DAY) });
    await reconcileCapacityForAllTenants();
    await reload();
    expect(branches.every((b) => !b.billingLockedAt)).toBe(true);
    expect(branches[PAUSED].pausedAt.getTime()).toBe(pausedAt);
    expect(branches[OPEN].pausedAt).toBeNull();
  });

  test('a paused branch counts once: lapsed → both over quota; 1-branch plan → exactly one locked, twice in a row', async () => {
    await gymService.pauseBranch(tenantDb, branches[PAUSED].id, tenant.ownerUserId);

    const ended = await lapse();
    const lapsed = await lockService.getOverQuotaState(tenant.id, tenantDb);
    expect(lapsed.overQuotaCount).toBe(2);

    // A 1-branch plan: one of the two active branches is over, the paused one included once.
    await ended.update({ status: 'ACTIVE', branchCount: 1, endDate: new Date(start + 40 * DAY) });
    await reconcileCapacityForAllTenants();
    const row = await TenantSubscription.findByPk(ended.id);
    expect(row.overQuotaCount).toBe(1);
    expect(await subscriptionQuotaService.getUsedCapacity(tenant.id, tenantDb)).toBe(2);

    jest.setSystemTime(start + 30 * DAY);
    await row.update({ pendingChange: { appliedAt: new Date(start).toISOString() } });
    const first = await lockService.enforceBranchBillingLocksForTenant(tenant.id, tenantDb);
    const second = await lockService.enforceBranchBillingLocksForTenant(tenant.id, tenantDb);
    await reload();
    expect(first.lockedBranchIds).toHaveLength(1);
    expect(branches.filter((b) => b.billingLockedAt)).toHaveLength(1);
    expect(second).toMatchObject({ lockedCount: 0, unlockedCount: 0 });
    // Newest first (P5b's pause does not change the order): the paused branch is the one locked, still paused.
    expect(branches[PAUSED].billingLockedAt).not.toBeNull();
    expect(branches[PAUSED].pausedAt).not.toBeNull();
  });
});
