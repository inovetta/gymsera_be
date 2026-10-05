/**
 * FLOW-06: Subscription Expiry, Freeze Extension, and Renewal Dates Regression Test
 *
 * Verifies:
 * 1. Freeze extends endDate by frozen days on both MemberSubscription and platform index.
 * 2. Renewal extends from max(now, endDate) in the branch timezone (not past expired endDate).
 * 3. Daily cron computes expiry in the branch timezone.
 * 4. Daily cron unfreezes FROZEN subscriptions whose freezeTo has elapsed.
 */
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const subscriptionService = require('../../src/services/subscription.service');
const { runExpiryCheck } = require('../../src/jobs/subscription-expiry.cron');
const { SubscriptionStatus } = require('../../src/constants/subscription-status');
const { computeBusinessDate } = require('../../src/services/ledger.service');

describe('FLOW-06: Subscription Dates, Freeze Extension & Branch Timezone Expiry', () => {
  let dbHarness;
  let tenantSeq;
  let models;
  let platformSeq;
  let platformModels;
  let testTenantId;
  let listing;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    const { setupPersonas, personaManager } = require('../harness/personas');
    await setupPersonas(dbHarness);

    tenantSeq = dbHarness.tenant1.sequelize;
    models = dbHarness.tenant1.models;
    platformSeq = dbHarness.platform.sequelize;
    platformModels = require('../../src/models/platform');

    testTenantId = personaManager.personas.owner.tenantId;

    const { Gym, Branch, MembershipPlan } = models;
    const { User } = platformModels;
    const { factories } = require('../harness');

    user = await User.create({
      email: 'flow06.member@example.com',
      passwordHash: 'dummy',
      fullName: 'Flow 06 Member',
      role: 'MEMBER',
      status: 'ACTIVE',
    });

    gym = await Gym.findOne();
    if (!gym) {
      gym = await Gym.create({
        name: 'Flow06 Fitness',
        phone: '+923001112233',
      });
    }

    branch = await Branch.create({
      gymId: gym.id,
      branchName: 'Karachi Central',
      timezone: 'Asia/Karachi',
    });

    listing = await factories.createGymListing(testTenantId, {
      branchId: branch.id,
      title: 'Flow06 Fitness Karachi',
      status: 'ACTIVE',
    });

    plan = await MembershipPlan.create({
      gymId: gym.id,
      branchId: branch.id,
      name: 'Monthly Standard',
      price: 5000,
      durationType: 'MONTHLY',
      durationValue: 1,
      freezeLimitDays: 15,
      status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('Freeze: extends endDate by frozen days', () => {
    test('freezing extends endDate by the exact freezeDays', async () => {
      const { MemberSubscription } = models;
      const { UserGymMembership } = platformModels;

      const sub = await MemberSubscription.create({
        userId: user.id,
        membershipPlanId: plan.id,
        branchId: branch.id,
        startDate: '2026-05-01',
        endDate: '2026-05-31',
        status: SubscriptionStatus.ACTIVE,
      });

      await UserGymMembership.create({
        userId: user.id,
        gymListingId: listing.id,
        tenantId: testTenantId,
        subscriptionId: sub.id,
        gymName: 'Flow06 Fitness',
        planName: plan.name,
        startDate: '2026-05-01',
        endDate: '2026-05-31',
        status: SubscriptionStatus.ACTIVE,
      });

      // Freeze for 10 days: 2026-05-10 to 2026-05-20
      const frozen = await subscriptionService.freeze(user.id, sub.id, '2026-05-10', '2026-05-20');

      expect(frozen.status).toBe(SubscriptionStatus.FROZEN);
      expect(frozen.freezeFrom).toBe('2026-05-10');
      expect(frozen.freezeTo).toBe('2026-05-20');

      // End date MUST be extended from 2026-05-31 by 10 days -> 2026-06-10
      expect(frozen.endDate).toBe('2026-06-10');

      // Platform index must also be updated
      const index = await UserGymMembership.findOne({ where: { subscriptionId: sub.id } });
      expect(index.status).toBe(SubscriptionStatus.FROZEN);
      expect(index.endDate).toBe('2026-06-10');
    });
  });

  describe('Renewal: extends from max(now, endDate)', () => {
    test('expired subscription renews from today in branch timezone, NOT from obsolete past endDate', async () => {
      const { MemberSubscription } = models;
      const { UserGymMembership } = platformModels;

      // An old subscription expired 3 months ago (2026-01-01 to 2026-01-31)
      const expiredSub = await MemberSubscription.create({
        userId: user.id,
        membershipPlanId: plan.id,
        branchId: branch.id,
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        status: SubscriptionStatus.EXPIRED,
      });

      await UserGymMembership.create({
        userId: user.id,
        gymListingId: listing.id,
        tenantId: testTenantId,
        subscriptionId: expiredSub.id,
        gymName: 'Flow06 Fitness',
        planName: plan.name,
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        status: SubscriptionStatus.EXPIRED,
      });

      const { subscription: renewed } = await subscriptionService.renew(user.id, expiredSub.id);

      const todayInTz = computeBusinessDate(new Date(), branch.timezone);
      // Renewing must start from today, NOT from 2026-01-31
      expect(renewed.startDate).toBe(todayInTz);
      expect(renewed.status).toBe(SubscriptionStatus.ACTIVE);

      // New end date must be in the future (1 month from today)
      expect(new Date(renewed.endDate).getTime()).toBeGreaterThan(new Date(todayInTz).getTime());
    });

    test('active subscription renews from current endDate (preserving remaining days)', async () => {
      const { MemberSubscription } = models;
      const { UserGymMembership } = platformModels;

      // Current date in branch timezone
      const todayInTz = computeBusinessDate(new Date(), branch.timezone);
      const futureEnd = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];

      const activeSub = await MemberSubscription.create({
        userId: user.id,
        membershipPlanId: plan.id,
        branchId: branch.id,
        startDate: todayInTz,
        endDate: futureEnd,
        status: SubscriptionStatus.ACTIVE,
      });

      await UserGymMembership.create({
        userId: user.id,
        gymListingId: listing.id,
        tenantId: testTenantId,
        subscriptionId: activeSub.id,
        gymName: 'Flow06 Fitness',
        planName: plan.name,
        startDate: todayInTz,
        endDate: futureEnd,
        status: SubscriptionStatus.ACTIVE,
      });

      const { subscription: renewed } = await subscriptionService.renew(user.id, activeSub.id);

      // Renewal extends from futureEnd
      expect(renewed.startDate).toBe(futureEnd);
      expect(renewed.status).toBe(SubscriptionStatus.ACTIVE);
    });
  });

  describe('Expiry Cron: branch timezone and unfreeze', () => {
    test('unfreezes FROZEN subscription whose freezeTo has elapsed', async () => {
      const { MemberSubscription } = models;
      const { UserGymMembership } = platformModels;

      // Frozen subscription with freezeTo in the past, but extended endDate in the future
      const pastFreezeTo = '2026-01-10';
      const futureEndDate = new Date(Date.now() + 20 * 86400000).toISOString().split('T')[0];

      const frozenSub = await MemberSubscription.create({
        userId: user.id,
        membershipPlanId: plan.id,
        branchId: branch.id,
        startDate: '2026-01-01',
        endDate: futureEndDate,
        status: SubscriptionStatus.FROZEN,
        freezeFrom: '2026-01-01',
        freezeTo: pastFreezeTo,
      });

      await UserGymMembership.create({
        userId: user.id,
        gymListingId: listing.id,
        tenantId: testTenantId,
        subscriptionId: frozenSub.id,
        gymName: 'Flow06 Fitness',
        planName: plan.name,
        startDate: '2026-01-01',
        endDate: futureEndDate,
        status: SubscriptionStatus.FROZEN,
      });

      // Run expiry check
      await runExpiryCheck();

      const refreshed = await MemberSubscription.findByPk(frozenSub.id);
      expect(refreshed.status).toBe(SubscriptionStatus.ACTIVE);

      const refreshedIndex = await UserGymMembership.findOne({ where: { subscriptionId: frozenSub.id } });
      expect(refreshedIndex.status).toBe(SubscriptionStatus.ACTIVE);
    });
  });
});
