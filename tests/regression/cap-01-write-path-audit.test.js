const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
} = require('../harness');
const gymService = require('../../src/services/gym.service');
const membershipPlanService = require('../../src/services/membership-plan.service');
const paymentService = require('../../src/services/payment.service');
const subscriptionService = require('../../src/services/subscription.service');
const trainerService = require('../../src/services/trainer.service');
const teamService = require('../../src/services/team.service');
const meService = require('../../src/services/me.service');
const { PaymentStatus } = require('../../src/constants/payment-status');
const { SubscriptionStatus } = require('../../src/constants/subscription-status');

describe('CAP-01 Write-Path Audit: checkBranchBillingLock enforcement', () => {
  let dbHarness;
  let tenantId;
  let personas;
  let tenantDb;
  let hostUser;
  let lockedBranch;
  let activeGym;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenantId = personas.owner.tenantId;
    tenantDb = dbHarness.tenant1;
    hostUser = personas.owner.user;

    const { Branch, Gym } = tenantDb.models;
    activeGym = await Gym.findOne();
    if (!activeGym) {
      const listing = await factories.createGymListing(tenantId, {
        title: 'Audit Locked Gym Listing',
        status: 'ACTIVE',
        reservedSlots: 0,
      });
      activeGym = await Gym.create({
        gymListingId: listing.id,
        name: 'Audit Locked Gym',
      });
    }

    lockedBranch = await Branch.create({
      gymId: activeGym.id,
      gymListingId: activeGym.gymListingId,
      branchName: 'Audit Locked Branch',
      status: 'ACTIVE',
      billingLockedAt: new Date(),
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('Membership Plan edit paths on locked branch', () => {
    let testPlan;

    beforeAll(async () => {
      const { MembershipPlan } = tenantDb.models;
      testPlan = await MembershipPlan.create({
        gymId: activeGym.id,
        branchId: lockedBranch.id,
        name: 'Pre-existing Locked Plan',
        durationType: 'MONTHLY',
        durationValue: 1,
        price: 50,
        status: 'ACTIVE',
        isPublic: false,
        isDeactivated: false,
      });
    });

    test('updatePlan rejects when branch is billing locked', async () => {
      await expect(
        membershipPlanService.updatePlan(tenantDb, testPlan.id, { price: 60 })
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });

    test('toggleStatus rejects when branch is billing locked', async () => {
      await expect(
        membershipPlanService.toggleStatus(tenantDb, testPlan.id)
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });

    test('togglePublic rejects when branch is billing locked', async () => {
      await expect(
        membershipPlanService.togglePublic(tenantDb, testPlan.id)
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });

    test('updatePoster rejects when branch is billing locked', async () => {
      await expect(
        membershipPlanService.updatePoster(tenantDb, testPlan.id, 'https://example.com/poster.jpg')
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });

    test('setFeatured rejects when branch is billing locked', async () => {
      await expect(
        membershipPlanService.setFeatured(tenantDb, testPlan.id)
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });
  });

  describe('Subscription lifecycle paths on locked branch', () => {
    let testSub;

    beforeAll(async () => {
      const { MemberSubscription, MembershipPlan } = tenantDb.models;
      const plan = await MembershipPlan.create({
        gymId: activeGym.id,
        branchId: lockedBranch.id,
        name: 'Sub Test Plan',
        durationType: 'MONTHLY',
        durationValue: 1,
        price: 40,
        status: 'ACTIVE',
      });
      testSub = await MemberSubscription.create({
        userId: hostUser.id,
        branchId: lockedBranch.id,
        membershipPlanId: plan.id,
        startDate: '2026-01-01',
        endDate: '2026-02-01',
        status: SubscriptionStatus.PENDING,
      });
    });

    test('activateSubscription rejects when branch is billing locked', async () => {
      await expect(
        subscriptionService.activateSubscription(tenantDb, testSub.id)
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });
  });

  describe('Payment collection paths on locked branch', () => {
    let pendingPayment;

    beforeAll(async () => {
      const { Payment } = tenantDb.models;
      pendingPayment = await Payment.create({
        userId: hostUser.id,
        branchId: lockedBranch.id,
        amount: 100,
        currency: 'PKR',
        method: 'CASH',
        status: PaymentStatus.PENDING,
      });
    });

    test('verifyPayment rejects when branch is billing locked', async () => {
      await expect(
        paymentService.verifyPayment(tenantDb, pendingPayment.id, hostUser.id)
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });

    test('verifyOrRejectPayment (collect) rejects when branch is billing locked', async () => {
      await expect(
        paymentService.verifyOrRejectPayment(tenantDb, pendingPayment.id, hostUser.id, 'GYM_HOST', {
          action: 'collect',
        })
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });

    test('collectionAction (batch collect) rejects when branch is billing locked', async () => {
      await expect(
        paymentService.collectionAction(tenantDb, [pendingPayment.id], hostUser.id)
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });
  });

  describe('Trainer & Staff assignment paths on locked branch', () => {
    let trainerUser;

    beforeAll(async () => {
      const { User } = require('../../src/models/platform');
      trainerUser = await User.create({
        email: 'trainer-audit@gymsera.test',
        fullName: 'Trainer Audit',
        role: 'TRAINER',
        status: 'ACTIVE',
        isVerified: true,
      });
    });

    test('trainerService.createTrainer rejects when branch is billing locked', async () => {
      await expect(
        trainerService.createTrainer(tenantDb, {
          userId: trainerUser.id,
          branchId: lockedBranch.id,
          specialization: 'HIIT',
        })
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });

    test('trainerService.assignTrainer rejects when branch is billing locked', async () => {
      const { Trainer } = tenantDb.models;
      const trainer = await Trainer.create({
        userId: trainerUser.id,
        specialization: 'Yoga',
        status: 'ACTIVE',
      });
      await expect(
        trainerService.assignTrainer(tenantDb, trainer.id, lockedBranch.id)
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });

    test('teamService.updateAssignment rejects when assigning to locked branch', async () => {
      const { RoleAssignment } = tenantDb.models;
      const assignment = await RoleAssignment.create({
        userId: trainerUser.id,
        roleKey: 'trainer',
        roleLevel: 2,
        scopeType: 'ORG',
        status: 'ACTIVE',
      });

      const ctx = {
        tenantDb,
        tenantId,
        grants: {
          isOwner: true,
          assignmentIds: [],
          has: () => true,
        },
        userId: hostUser.id,
      };

      await expect(
        teamService.updateAssignment(ctx, assignment.id, {
          branchIds: [lockedBranch.id],
        })
      ).rejects.toMatchObject({
        code: 'branch_billing_locked',
        statusCode: 403,
      });
    });
  });
});
