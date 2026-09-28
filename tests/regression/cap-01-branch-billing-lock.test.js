const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
} = require('../harness');
const gymService = require('../../src/services/gym.service');
const branchBillingLockService = require('../../src/services/branch-billing-lock.service');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const membershipPlanService = require('../../src/services/membership-plan.service');
const paymentService = require('../../src/services/payment.service');
const attendanceService = require('../../src/services/attendance.service');
const { TenantSubscription, CapacityEvent } = require('../../src/models/platform');
const { OVERQUOTA_GRACE_DAYS, MEMBER_CHECKIN_GRACE_DAYS } = require('../../src/config/billing.config');

describe('CAP-01: Real Branch Billing Lock on Over-Quota Tenants', () => {
  let dbHarness;
  let tenantId;
  let personas;
  let tenantDb;
  let hostUser;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenantId = personas.owner.tenantId;
    tenantDb = dbHarness.tenant1;
    hostUser = personas.owner.user;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('Downgrade below active count -> during grace period (7 days) countdown is shown, zero branches locked', async () => {
    const { Branch, Gym } = tenantDb.models;

    const listing = await factories.createGymListing(tenantId, {
      title: 'Grace Org',
      status: 'ACTIVE',
      reservedSlots: 0,
    });
    const gym = await Gym.create({
      gymListingId: listing.id,
      name: 'Grace Gym',
    });

    const branch1 = await Branch.create({
      gymId: gym.id,
      gymListingId: listing.id,
      branchName: 'Branch 1',
      status: 'ACTIVE',
    });
    const branch2 = await Branch.create({
      gymId: gym.id,
      gymListingId: listing.id,
      branchName: 'Branch 2',
      status: 'ACTIVE',
    });

    // Ensure active subscription with branchCount = 1 (overQuotaCount = 1)
    // and appliedAt = now (day 0 of 7-day grace)
    let sub = await subscriptionQuotaService.getActiveSubscription(tenantId);
    if (!sub) {
      sub = await factories.createTenantSubscription(tenantId, {
        branchCount: 1,
        overQuotaCount: 1,
        status: 'ACTIVE',
        pendingChange: {
          newTier: 'starter',
          effectiveDate: new Date(),
          appliedAt: new Date(),
        },
      });
    } else {
      await sub.update({
        branchCount: 1,
        overQuotaCount: 1,
        pendingChange: {
          newTier: 'starter',
          effectiveDate: new Date(),
          appliedAt: new Date(),
        },
      });
    }

    const result = await branchBillingLockService.enforceBranchBillingLocksForTenant(tenantId, tenantDb);
    expect(result.inGrace).toBe(true);
    expect(result.lockedCount).toBe(0);
    expect(result.remainingDays).toBeGreaterThan(0);

    // Verify branches remain unlocked
    await branch1.reload();
    await branch2.reload();
    expect(branch1.billingLockedAt).toBeNull();
    expect(branch2.billingLockedAt).toBeNull();
  });

  test('After OVERQUOTA_GRACE_DAYS expired, sweep locks exactly overQuotaCount branches respecting getBranchesToKeep', async () => {
    const { Branch, Gym } = tenantDb.models;

    // Create 3 active branches with distinct creation times
    const listing = await factories.createGymListing(tenantId, {
      title: 'Lock Org',
      status: 'ACTIVE',
      reservedSlots: 0,
    });
    const gym = await Gym.create({
      gymListingId: listing.id,
      name: 'Lock Gym',
    });

    const now = Date.now();
    const branchOld = await Branch.create({
      gymId: gym.id,
      gymListingId: listing.id,
      branchName: 'Branch Old',
      status: 'ACTIVE',
      createdAt: new Date(now - 30000),
    });
    const branchMid = await Branch.create({
      gymId: gym.id,
      gymListingId: listing.id,
      branchName: 'Branch Mid',
      status: 'ACTIVE',
      createdAt: new Date(now - 20000),
    });
    const branchNew = await Branch.create({
      gymId: gym.id,
      gymListingId: listing.id,
      branchName: 'Branch New',
      status: 'ACTIVE',
      createdAt: new Date(now - 10000),
    });

    // Tenant has 3 branches (plus earlier 2 = 5 active branches total).
    // Let's set subscription to have overQuotaCount = 2, with appliedAt = 8 days ago (grace expired).
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const sub = await subscriptionQuotaService.getActiveSubscription(tenantId);
    await sub.update({
      branchCount: 3,
      overQuotaCount: 2,
      pendingChange: {
        newTier: 'starter',
        appliedAt: eightDaysAgo,
      },
    });

    // Mock getBranchesToKeep to specify that branchNew should be KEPT
    jest.spyOn(subscriptionQuotaService, 'getBranchesToKeep').mockResolvedValue([branchNew.id]);

    const result = await branchBillingLockService.enforceBranchBillingLocksForTenant(tenantId, tenantDb);
    expect(result.inGrace).toBe(false);
    expect(result.overQuotaCount).toBe(2);

    // Exactly 2 branches should be locked across all active branches
    const allLocked = await Branch.findAll({
      where: { billingLockedAt: { [require('sequelize').Op.ne]: null } },
    });
    expect(allLocked.length).toBe(2);

    // branchNew was in keep list -> MUST NOT be locked!
    await branchNew.reload();
    expect(branchNew.billingLockedAt).toBeNull();

    // CapacityEvent rows created
    const lockEvents = await CapacityEvent.findAll({
      where: {
        tenantId,
        action: 'BRANCH_BILLING_LOCKED',
      },
    });
    expect(lockEvents.length).toBe(2);
    expect(lockEvents[0].actorType).toBe('SYSTEM');
    expect(lockEvents[0].delta).toBe(0);

    // Running the sweep a second time changes nothing (idempotent)
    const secondResult = await branchBillingLockService.enforceBranchBillingLocksForTenant(tenantId, tenantDb);
    expect(secondResult.lockedCount).toBe(0);
    expect(secondResult.unlockedCount).toBe(0);
  });

  test('A locked branch refuses new members, sales, plans, and staff in one shared guard', async () => {
    const { Branch, Gym } = tenantDb.models;

    const lockedBranch = await Branch.findOne({
      where: { billingLockedAt: { [require('sequelize').Op.ne]: null } },
    });
    expect(lockedBranch).not.toBeNull();

    const gym = await Gym.findByPk(lockedBranch.gymId);

    // 1. Refuse plan creation
    await expect(
      membershipPlanService.createPlan(tenantDb, {
        branchId: lockedBranch.id,
        gymId: gym.id,
        name: 'New Gold Plan',
        price: 99,
        durationMonths: 1,
      })
    ).rejects.toMatchObject({
      code: 'branch_billing_locked',
      statusCode: 403,
    });

    // 2. Refuse member enrollment
    await expect(
      gymService.enrollMember(tenantDb, tenantId, {
        branchId: lockedBranch.id,
        email: 'locked@example.com',
        fullName: 'Locked Member',
      })
    ).rejects.toMatchObject({
      code: 'branch_billing_locked',
      statusCode: 403,
    });

    // 3. Refuse payment / sale recording
    await expect(
      paymentService.recordPayment(tenantDb, hostUser.id, 'GYM_HOST', {
        branchId: lockedBranch.id,
        amount: 50,
        currency: 'PKR',
        method: 'CASH',
      })
    ).rejects.toMatchObject({
      code: 'branch_billing_locked',
      statusCode: 403,
    });

    // 4. Refuse staff addition
    await expect(
      gymService.assignStaff(tenantDb, lockedBranch.id, hostUser.id, 'TRAINER')
    ).rejects.toMatchObject({
      code: 'branch_billing_locked',
      statusCode: 403,
    });
  });

  test('Member check-in: allowed during MEMBER_CHECKIN_GRACE_DAYS (7 days), refused after', async () => {
    const { Branch } = tenantDb.models;

    const lockedBranch = await Branch.findOne({
      where: { billingLockedAt: { [require('sequelize').Op.ne]: null } },
    });

    // 1. Check-in right after lock (day 0) is ALLOWED
    expect(() => {
      branchBillingLockService.assertBranchCheckinAllowed(lockedBranch);
    }).not.toThrow();

    // 2. Set billingLockedAt to 8 days ago (grace expired)
    const eightDaysAgo = new Date(Date.now() - (MEMBER_CHECKIN_GRACE_DAYS + 1) * 24 * 60 * 60 * 1000);
    await lockedBranch.update({ billingLockedAt: eightDaysAgo });

    // Check-in is now REFUSED with 403 member_checkin_grace_expired
    expect(() => {
      branchBillingLockService.assertBranchCheckinAllowed(lockedBranch);
    }).toThrow(
      expect.objectContaining({
        code: 'member_checkin_grace_expired',
        statusCode: 403,
      })
    );
  });

  test('Automatic unlock when capacity returns (upgrade or delete branch)', async () => {
    const { Branch } = tenantDb.models;

    // Account upgrades: overQuotaCount becomes 0
    const sub = await subscriptionQuotaService.getActiveSubscription(tenantId);
    await sub.update({
      branchCount: 10,
      overQuotaCount: 0,
      pendingChange: null,
    });

    // Reconcile/sweep capacity
    const result = await branchBillingLockService.enforceBranchBillingLocksForTenant(tenantId, tenantDb);
    expect(result.overQuotaCount).toBe(0);
    expect(result.unlockedCount).toBe(2);

    // All branches are now unlocked
    const remainingLocked = await Branch.findAll({
      where: { billingLockedAt: { [require('sequelize').Op.ne]: null } },
    });
    expect(remainingLocked.length).toBe(0);

    // CapacityEvent rows written for unlock
    const unlockEvents = await CapacityEvent.findAll({
      where: {
        tenantId,
        action: 'BRANCH_BILLING_UNLOCKED',
      },
    });
    expect(unlockEvents.length).toBe(2);
    expect(unlockEvents[0].actorType).toBe('SYSTEM');
    expect(unlockEvents[0].delta).toBe(0);

    // Previously locked branch can now accept member enrollments and plans again
    const previouslyLockedBranch = await Branch.findOne({ where: { status: 'ACTIVE' } });
    const plan = await membershipPlanService.createPlan(tenantDb, {
      branchId: previouslyLockedBranch.id,
      gymId: previouslyLockedBranch.gymId,
      name: 'Restored Plan',
      price: 150,
      durationMonths: 1,
    });
    expect(plan).toBeDefined();
    expect(plan.name).toBe('Restored Plan');
  });
});
