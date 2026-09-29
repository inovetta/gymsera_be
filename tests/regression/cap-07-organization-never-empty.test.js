const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
} = require('../harness');
const gymService = require('../../src/services/gym.service');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const branchBillingLockService = require('../../src/services/branch-billing-lock.service');
const { GymListing, TenantSubscription } = require('../../src/models/platform');

describe('CAP-07: Organization Never Empty & Capacity Invariant Verification', () => {
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

    // Give tenant plenty of branch capacity for random property-based testing
    const sub = await subscriptionQuotaService.getActiveSubscription(tenantId);
    if (sub) {
      await sub.update({ branchCount: 20, overQuotaCount: 0 });
    } else {
      await factories.createTenantSubscription(tenantId, { branchCount: 20, overQuotaCount: 0 });
    }
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('auditCapacity reports ACTIVE organization with zero active branches and marks ok=false', async () => {
    const { Gym } = tenantDb.models;

    // Create an active listing without any branches
    const emptyListing = await factories.createGymListing(tenantId, {
      title: 'Empty Active Org',
      status: 'ACTIVE',
      reservedSlots: 0,
      hostId: hostUser.id,
    });
    await Gym.create({
      gymListingId: emptyListing.id,
      name: 'Empty Gym',
    });

    const audit = await subscriptionQuotaService.auditCapacity(tenantId, tenantDb);
    expect(audit.hasEmptyActiveOrgs).toBe(true);
    expect(audit.emptyActiveOrgs.some((o) => o.listingId === emptyListing.id)).toBe(true);
    expect(audit.ok).toBe(false);

    // Clean up by deactivating the empty listing so subsequent tests start clean
    await emptyListing.update({ status: 'INACTIVE' });
  });

  test('deleteBranch without confirmation throws 409 last_branch_in_organization; confirmed delete deactivates org so it never stays empty', async () => {
    const { Branch, Gym, MembershipPlan } = tenantDb.models;

    const listing = await factories.createGymListing(tenantId, {
      title: 'Guarded Org',
      status: 'ACTIVE',
      reservedSlots: 0,
      hostId: hostUser.id,
    });
    const gym = await Gym.create({
      gymListingId: listing.id,
      name: 'Guarded Gym',
    });
    const branch = await Branch.create({
      gymId: gym.id,
      gymListingId: listing.id,
      branchName: 'Guarded Branch',
      status: 'ACTIVE',
    });
    await listing.update({ branchId: branch.id });

    await MembershipPlan.create({
      gymId: gym.id,
      branchId: branch.id,
      name: 'P1',
      price: 10,
      status: 'ACTIVE',
      isPublic: true,
      isDeactivated: false,
    });

    // 1. Delete without confirmation must reject with 409
    await expect(
      gymService.deleteBranch(tenantDb, branch.id, hostUser.id, { confirmOrganizationDeletion: false })
    ).rejects.toMatchObject({
      code: 'last_branch_in_organization',
      statusCode: 409,
    });

    // Verify branch and org remain ACTIVE
    await branch.reload();
    await listing.reload();
    expect(branch.status).toBe('ACTIVE');
    expect(listing.status).toBe('ACTIVE');

    // 2. Confirmed delete deactivates the org so it is never an empty ACTIVE org
    await gymService.deleteBranch(tenantDb, branch.id, hostUser.id, { confirmOrganizationDeletion: true });
    await branch.reload();
    await listing.reload();
    expect(branch.status).toBe('INACTIVE');
    expect(listing.status).toBe('INACTIVE');

    // auditCapacity passes with zero empty active orgs
    const audit = await subscriptionQuotaService.auditCapacity(tenantId, tenantDb);
    expect(audit.hasEmptyActiveOrgs).toBe(false);
  });

  test('Property-based randomized sequence of create/delete/move/restore/lock/unlock preserves invariant and no active org is empty', async () => {
    const { Branch, Gym, MembershipPlan } = tenantDb.models;

    // Seed 2 active organizations each with 1 active branch
    const orgs = [];
    for (let i = 1; i <= 2; i++) {
      const listing = await factories.createGymListing(tenantId, {
        title: `Property Org ${i}`,
        status: 'ACTIVE',
        reservedSlots: 0,
        hostId: hostUser.id,
      });
      const gym = await Gym.create({
        gymListingId: listing.id,
        name: `Property Gym ${i}`,
      });
      const branch = await Branch.create({
        gymId: gym.id,
        gymListingId: listing.id,
        branchName: `Prop Branch ${i}`,
        status: 'ACTIVE',
      });
      await listing.update({ branchId: branch.id });
      await MembershipPlan.create({
        gymId: gym.id,
        branchId: branch.id,
        name: `Plan Prop ${i}`,
        price: 50,
        status: 'ACTIVE',
        isPublic: true,
        isDeactivated: false,
      });
      orgs.push({ listing, gym });
    }

    // Run 25 randomized operational steps
    const actionTypes = ['CREATE', 'DELETE', 'MOVE', 'RESTORE', 'LOCK', 'UNLOCK'];

    for (let step = 0; step < 25; step++) {
      const action = actionTypes[Math.floor(Math.random() * actionTypes.length)];

      try {
        if (action === 'CREATE') {
          // Find an active listing or pick the first
          const activeListings = await GymListing.findAll({ where: { tenantId, status: 'ACTIVE' } });
          if (activeListings.length > 0) {
            const target = activeListings[Math.floor(Math.random() * activeListings.length)];
            const gym = await Gym.findOne({ where: { gymListingId: target.id } });
            await gymService.createBranch(
              tenantDb,
              tenantId,
              {
                gymListingId: target.id,
                branchName: `Random Branch ${step}`,
                address: 'Random Street',
              },
              hostUser.id,
              { allowDefaultPackage: true }
            );
          }
        } else if (action === 'DELETE') {
          const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' } });
          if (activeBranches.length > 1) {
            const b = activeBranches[Math.floor(Math.random() * activeBranches.length)];
            await gymService.deleteBranch(tenantDb, b.id, hostUser.id, { confirmOrganizationDeletion: true });
          }
        } else if (action === 'MOVE') {
          const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' } });
          const activeListings = await GymListing.findAll({ where: { tenantId, status: 'ACTIVE' } });
          if (activeBranches.length > 1 && activeListings.length > 1) {
            const b = activeBranches[Math.floor(Math.random() * activeBranches.length)];
            const otherListings = activeListings.filter((l) => l.id !== b.gymListingId);
            if (otherListings.length > 0) {
              const targetListing = otherListings[0];
              await gymService.moveBranch(tenantDb, tenantId, b.id, targetListing.id, hostUser.id);
            }
          }
        } else if (action === 'RESTORE') {
          const inactiveBranches = await Branch.findAll({ where: { status: 'INACTIVE' } });
          if (inactiveBranches.length > 0) {
            const b = inactiveBranches[Math.floor(Math.random() * inactiveBranches.length)];
            await gymService.restoreBranch(tenantDb, tenantId, b.id, hostUser.id);
          }
        } else if (action === 'LOCK') {
          const activeBranches = await Branch.findAll({
            where: { status: 'ACTIVE', billingLockedAt: null },
          });
          if (activeBranches.length > 0) {
            const b = activeBranches[Math.floor(Math.random() * activeBranches.length)];
            await b.update({ billingLockedAt: new Date(), billingLockReason: 'Test Lock' });
          }
        } else if (action === 'UNLOCK') {
          const lockedBranches = await Branch.findAll({
            where: { billingLockedAt: { [require('sequelize').Op.ne]: null } },
          });
          if (lockedBranches.length > 0) {
            const b = lockedBranches[Math.floor(Math.random() * lockedBranches.length)];
            await b.update({ billingLockedAt: null, billingLockReason: null });
          }
        }
      } catch (opErr) {
        // Controlled capacity / guard rejections are allowed in random operations
      }

      // INVARIANT CHECK AFTER EVERY STEP:
      const audit = await subscriptionQuotaService.auditCapacity(tenantId, tenantDb);
      // 1. No ACTIVE organization has zero active branches
      expect(audit.hasEmptyActiveOrgs).toBe(false);
      expect(audit.emptyActiveOrgs.length).toBe(0);

      // 2. Capacity invariant holds
      expect(audit.invariantHolds).toBe(true);

      // 3. No ledger drift on live organizations
      expect(audit.driftedListings.length).toBe(0);
      expect(audit.totalDrift).toBe(0);
    }
  });
});
