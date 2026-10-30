/**
 * P7c items 1 and 2 (NEW-170 P0, NEW-171 P1; owner decision R-82, spec §7.5.8).
 *
 * A tenant with no entitling plan (ACTIVE / GRACE) but an ended or expired one
 * (EXPIRED, ON_HOLD, PAUSED, REVOKED) is entitled to 0 branches, so every active
 * branch is over quota:
 *   - day 0 to 7: over-quota grace, nothing locked, the countdown is reported;
 *   - after 7 days: every active branch is billing-locked (keep-list order);
 *   - members keep checking in for 7 days after the lock, then not;
 *   - a plan that entitles again unlocks every branch.
 * EXPIRED cuts capacity like the other ended states, and the nightly capacity
 * pass also covers tenants with no entitling plan.
 *
 * Before P7c: reconcileCapacity wrote overQuotaCount only to entitling rows, and
 * enforceBranchBillingLocksForTenant unlocked everything when there was none
 * (branch-billing-lock.service.js:35), so a lapsed plan never locked a branch.
 *
 * Time is moved with fake Date only (timers stay real for the database driver).
 * Every provider call is faked (tests/harness/billing-fakes.js).
 */
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
const { City, TenantSubscription, GymListing } = require('../../src/models/platform');
const appleBilling = require('../../src/services/apple-billing.service');
const googlePlayBilling = require('../../src/services/google-play-billing.service');
const lockService = require('../../src/services/branch-billing-lock.service');
const { runExpiryCheck, reconcileCapacityForAllTenants } = require('../../src/jobs/subscription-expiry.cron');

const DAY = fakes.DAY;
const REAL_TIMERS = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
];

describe('P7c items 1 and 2: a lapsed plan locks branches after the 7-day grace', () => {
  let dbHarness;
  let tenantDb;
  let tenant;
  let listing;
  let branches;
  let plan5;
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
    listing = await factories.createGymListing(tenant.id, { reservedSlots: 1 });
    branches = [
      await factories.createBranch(tenantDb, listing.id, { branchName: 'Older', createdAt: new Date(start - 2 * DAY) }),
      await factories.createBranch(tenantDb, listing.id, { branchName: 'Newer', createdAt: new Date(start - DAY) }),
    ];
    plan5 = await factories.createBillingPlan({ branchCount: 5, sortOrder: 5 });
  });

  const advanceDays = (days) => jest.setSystemTime(start + days * DAY);
  const reload = () => Promise.all(branches.map((b) => b.reload()));
  const lockedCount = async () => {
    await reload();
    return branches.filter((b) => b.billingLockedAt).length;
  };
  const reservedSlots = async () => (await GymListing.findByPk(listing.id)).reservedSlots;

  // ── providers ──────────────────────────────────────────────────────────────
  const apple = () => {
    const { truth } = fakes.installAppleFakes({
      'apple-1': fakes.appleTransaction({ originalTransactionId: 'apple-1', productId: plan5.iosMonthlyProductId }),
    });
    return {
      truth,
      buy: () => appleBilling.syncFromApple({ transactionId: 'apple-1', tenantId: tenant.id }),
      sync: () => appleBilling.syncFromApple({ transactionId: 'apple-1', tenantId: tenant.id }),
    };
  };
  const google = () => {
    const { truth } = fakes.installGoogleFakes({ tok: fakes.googlePurchase({ productId: plan5.androidProductId }) });
    return {
      truth,
      sync: () => googlePlayBilling.syncFromGoogle({ purchaseToken: 'tok', tenantId: tenant.id }),
    };
  };

  const LAPSES = {
    'expire (Apple reports expired)': {
      status: 'EXPIRED',
      setup: async () => {
        const p = apple();
        await p.buy();
        return {
          lapse: async () => {
            p.truth['apple-1'] = {
              ...fakes.appleTransaction({ originalTransactionId: 'apple-1', productId: plan5.iosMonthlyProductId, expiresInDays: -1 }),
              subscriptionStatus: 2,
            };
            await p.sync();
          },
          recover: async () => {
            p.truth['apple-1'] = {
              ...fakes.appleTransaction({
                originalTransactionId: 'apple-1', transactionId: 'apple-1-2', productId: plan5.iosMonthlyProductId, expiresInDays: 30,
              }),
              subscriptionStatus: 1,
            };
            await p.sync();
          },
        };
      },
    },
    'on hold (Google billing retry)': {
      status: 'ON_HOLD',
      setup: async () => {
        const p = google();
        await p.sync();
        return {
          lapse: async () => {
            p.truth.tok = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_ON_HOLD', expiresInDays: -1 });
            await p.sync();
          },
          recover: async () => {
            p.truth.tok = fakes.googlePurchase({ productId: plan5.androidProductId, latestOrderId: 'GPA.0000-0000-0000-00001..1' });
            await p.sync();
          },
        };
      },
    },
    'paused (Google)': {
      status: 'PAUSED',
      setup: async () => {
        const p = google();
        await p.sync();
        return {
          lapse: async () => {
            p.truth.tok = fakes.googlePurchase({ productId: plan5.androidProductId, state: 'SUBSCRIPTION_STATE_PAUSED' });
            await p.sync();
          },
          recover: async () => {
            p.truth.tok = fakes.googlePurchase({ productId: plan5.androidProductId, latestOrderId: 'GPA.0000-0000-0000-00001..2' });
            await p.sync();
          },
        };
      },
    },
    'revoke (Apple refund)': {
      status: 'REVOKED',
      setup: async () => {
        const p = apple();
        await p.buy();
        return {
          lapse: async () => {
            p.truth['apple-1'] = fakes.appleTransaction({
              originalTransactionId: 'apple-1', productId: plan5.iosMonthlyProductId, revocationDate: Date.now(),
            });
            await p.sync();
          },
          // The host pays again: a newer paid period (BILL-02).
          recover: async () => {
            p.truth['apple-1'] = fakes.appleTransaction({
              originalTransactionId: 'apple-1', transactionId: 'apple-1-2', productId: plan5.iosMonthlyProductId, expiresInDays: 60,
            });
            await p.sync();
          },
        };
      },
    },
  };

  describe.each(Object.keys(LAPSES))('%s', (name) => {
    const { status, setup } = LAPSES[name];

    test('7-day grace with nothing locked, then every branch locked; members check in for 7 more days; a plan unlocks', async () => {
      const { lapse, recover } = await setup();
      expect(await lockedCount()).toBe(0);

      await lapse();
      const row = await TenantSubscription.findOne({ where: { tenantId: tenant.id } });
      expect(row.status).toBe(status);
      // Unbuilt slots go first (EXPIRED included, item 2).
      expect(await reservedSlots()).toBe(0);

      // Day 0: grace, the countdown is reported, nothing locked.
      const day0 = await lockService.enforceBranchBillingLocksForTenant(tenant.id, tenantDb);
      expect(day0).toMatchObject({ overQuotaCount: 2, inGrace: true, lockedCount: 0, lapsed: true });
      expect(day0.remainingDays).toBe(7);
      expect(await lockedCount()).toBe(0);

      // Day 6: still grace, even after a daily re-fetch bumps the row (the grace
      // counts from when entitlement ended, not from the row's updatedAt).
      advanceDays(6);
      await row.update({ lastVerifiedAt: new Date() });
      await reconcileCapacityForAllTenants();
      expect(await lockedCount()).toBe(0);

      // Day 8: the nightly pass locks every active branch.
      advanceDays(8);
      await reconcileCapacityForAllTenants();
      expect(await lockedCount()).toBe(2);
      for (const b of branches) expect(() => lockService.assertBranchCheckinAllowed(b)).not.toThrow();
      expect(() => lockService.assertBranchNotBillingLocked(branches[0])).toThrow(
        expect.objectContaining({ code: 'branch_billing_locked' })
      );

      // 7 days after the lock, member check-ins stop.
      advanceDays(16);
      for (const b of branches) {
        expect(() => lockService.assertBranchCheckinAllowed(b)).toThrow(
          expect.objectContaining({ code: 'member_checkin_grace_expired' })
        );
      }

      // A plan that entitles again unlocks every branch.
      await recover();
      expect((await TenantSubscription.findOne({ where: { tenantId: tenant.id } })).status).toBe('ACTIVE');
      expect(await lockedCount()).toBe(0);
    });
  });

  test('a lapse after an earlier recovery starts a fresh 7-day grace', async () => {
    const { lapse, recover } = await LAPSES['on hold (Google billing retry)'].setup();
    await lapse();
    advanceDays(3);
    await recover();
    advanceDays(20);
    await lapse();
    const res = await lockService.enforceBranchBillingLocksForTenant(tenant.id, tenantDb);
    expect(res).toMatchObject({ inGrace: true, lockedCount: 0, remainingDays: 7 });
  });

  test('the daily expiry of a MANUAL plan past its end date cuts capacity and the nightly pass locks after 7 days', async () => {
    await factories.createTenantSubscription(tenant.id, {
      platform: 'MANUAL', branchCount: 5, status: 'ACTIVE', paymentStatus: 'PAID',
      startDate: new Date(start - 40 * DAY), endDate: new Date(start - 2 * DAY),
    });
    await runExpiryCheck();
    const row = await TenantSubscription.findOne({ where: { tenantId: tenant.id } });
    expect(row.status).toBe('EXPIRED');
    expect(await reservedSlots()).toBe(0);
    expect(await lockedCount()).toBe(0);

    advanceDays(8);
    await runExpiryCheck();
    expect(await lockedCount()).toBe(2);
  });

  test('a lapsed plan lists every active branch in the keep-list order: the host keep-list does not save a branch at 0', async () => {
    const { lapse } = await LAPSES['expire (Apple reports expired)'].setup();
    await lapse();
    advanceDays(8);
    const res = await lockService.enforceBranchBillingLocksForTenant(tenant.id, tenantDb);
    expect(res.overQuotaCount).toBe(2);
    expect(res.lockedBranchIds.sort()).toEqual(branches.map((b) => b.id).sort());
  });

  test('a tenant with no plan rows at all is not treated as lapsed (legacy default unchanged)', async () => {
    advanceDays(30);
    const res = await lockService.enforceBranchBillingLocksForTenant(tenant.id, tenantDb);
    expect(res).toMatchObject({ overQuotaCount: 0, lockedCount: 0 });
    expect(await lockedCount()).toBe(0);
  });
});
