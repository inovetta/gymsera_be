const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
} = require('../harness');
const gymService = require('../../src/services/gym.service');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const { GymListing, CapacityEvent } = require('../../src/models/platform');

describe('CAP-06: Restoring a Branch Whose Organization Was Auto-Deactivated', () => {
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

  test('Delete last branch deactivates org and preserves slot -> restore reactivates org in same flow and consumes slot with no fresh capacity', async () => {
    const { Branch, Gym, MembershipPlan } = tenantDb.models;

    // 1. Create a dedicated organization and its single active branch
    const listing = await factories.createGymListing(tenantId, {
      title: 'Auto Deactivated Org',
      status: 'ACTIVE',
      reservedSlots: 0,
      hostId: hostUser.id,
    });
    const gym = await Gym.create({
      gymListingId: listing.id,
      name: 'Auto Deactivated Gym',
    });
    const branch = await Branch.create({
      gymId: gym.id,
      gymListingId: listing.id,
      branchName: 'Sole Branch',
      status: 'ACTIVE',
    });
    await listing.update({ branchId: branch.id });

    // Required plan so deleteBranch cascades cleanly
    await MembershipPlan.create({
      gymId: gym.id,
      branchId: branch.id,
      name: 'Plan 1',
      price: 100,
      status: 'ACTIVE',
      isPublic: true,
      isDeactivated: false,
    });

    const usedBeforeDelete = await subscriptionQuotaService.getUsedCapacity(tenantId, tenantDb);

    // 2. Delete the branch with confirmOrganizationDeletion = true
    await gymService.deleteBranch(tenantDb, branch.id, hostUser.id, {
      confirmOrganizationDeletion: true,
    });

    // Verify branch is INACTIVE
    await branch.reload();
    expect(branch.status).toBe('INACTIVE');

    // Verify organization was auto-deactivated and its reservedSlots was preserved (incremented by 1)
    await listing.reload();
    expect(listing.status).toBe('INACTIVE');
    expect(listing.reservedSlots).toBe(1);

    // 3. Restore the branch
    const restoreResult = await gymService.restoreBranch(tenantDb, tenantId, branch.id, hostUser.id);
    expect(restoreResult.branch).toBeDefined();

    // 4. Verify branch is now ACTIVE
    await branch.reload();
    expect(branch.status).toBe('ACTIVE');

    // 5. Verify organization was reactivated in the same flow
    await listing.reload();
    expect(listing.status).toBe('ACTIVE');
    expect(listing.branchId).toBe(branch.id);

    // 6. Verify organization's preserved reserved slot was consumed first (decremented from 1 to 0)
    expect(listing.reservedSlots).toBe(0);

    // 7. Verify usedCapacity after restore equals usedBeforeDelete (no fresh capacity leaked)
    const usedAfterRestore = await subscriptionQuotaService.getUsedCapacity(tenantId, tenantDb);
    expect(usedAfterRestore).toBe(usedBeforeDelete);

    // 8. Verify CapacityEvent was recorded for the restoration with delta -1
    const restoreEvent = await CapacityEvent.findOne({
      where: {
        tenantId,
        branchId: branch.id,
        action: 'BRANCH_RESTORED',
      },
      order: [['createdAt', 'DESC']],
    });
    expect(restoreEvent).not.toBeNull();
    expect(restoreEvent.delta).toBe(-1);
    expect(restoreEvent.reservedSlotsBefore).toBe(1);
    expect(restoreEvent.reservedSlotsAfter).toBe(0);

    // 9. Verify capacity audit passes with zero drift
    const audit = await subscriptionQuotaService.auditCapacity(tenantId, tenantDb);
    expect(audit.ok).toBe(true);
    expect(audit.driftedListings.length).toBe(0);
    expect(audit.totalDrift).toBe(0);
    expect(audit.invariantHolds).toBe(true);
  });
});
