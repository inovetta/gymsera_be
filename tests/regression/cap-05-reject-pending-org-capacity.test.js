const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
} = require('../harness');
const gymService = require('../../src/services/gym.service');
const adminService = require('../../src/services/admin.service');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const { GymListing, CapacityEvent, Notification } = require('../../src/models/platform');

describe('CAP-05: Rejecting a Pending Organization Returns Capacity via deleteBranch', () => {
  let dbHarness;
  let organizationId;
  let personas;
  let tenantDb;
  let hostUser;
  let adminUser;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    organizationId = personas.owner.organizationId;
    tenantDb = dbHarness.tenant1;
    hostUser = personas.owner.user;
    adminUser = personas.platformAdmin.user;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('Creating org consumes 1 capacity -> admin reject calls deleteBranch -> usedCapacity restored -> CapacityEvent recorded', async () => {
    const { Branch, Gym } = tenantDb.models;

    const initialUsedCapacity = await subscriptionQuotaService.getUsedCapacity(organizationId, tenantDb);

    // 2. Host creates a new organization with a new branch (status: PENDING)
    const pendingListing = await factories.createGymListing(organizationId, {
      title: 'Pending New Org',
      status: 'PENDING',
      reservedSlots: 0,
      hostId: hostUser.id,
    });
    const pendingGym = await Gym.create({
      id: pendingListing.id,
      name: 'Pending Gym',
    });
    const pendingBranch = await Branch.create({
      businessId: pendingGym.id,
      branchName: 'Pending Branch 1',
      status: 'ACTIVE',
    });
    await pendingListing.update({ branchId: pendingBranch.id });

    // Capacity consumed: should now be initial + 1 = 2
    const capacityAfterOrgCreation = await subscriptionQuotaService.getUsedCapacity(organizationId, tenantDb);
    expect(capacityAfterOrgCreation).toBe(initialUsedCapacity + 1);

    // 3. Admin rejects the pending organization
    const rejectionResult = await adminService.rejectBusiness(
      pendingListing.id,
      adminUser.id,
      'Documentation does not meet platform requirements'
    );
    expect(rejectionResult.capacityReturned).toBe(true);

    // 4. Verify branch in tenant DB was soft-deleted via deleteBranch
    await pendingBranch.reload();
    expect(pendingBranch.status).toBe('INACTIVE');

    // 5. Verify listing status is REJECTED
    await pendingListing.reload();
    expect(pendingListing.status).toBe('REJECTED');
    expect(pendingListing.rejectionReason).toBe('Documentation does not meet platform requirements');
    expect(pendingListing.rejectedBy).toBe(adminUser.id);

    // 6. Verify CapacityEvent was recorded for the branch deletion
    const deleteEvent = await CapacityEvent.findOne({
      where: {
        organizationId,
        branchId: pendingBranch.id,
        action: 'BRANCH_DELETED',
      },
    });
    expect(deleteEvent).not.toBeNull();
    expect(deleteEvent.delta).toBe(1);

    // 7. Verify usedCapacity is restored back to initialUsedCapacity
    const capacityAfterRejection = await subscriptionQuotaService.getUsedCapacity(organizationId, tenantDb);
    expect(capacityAfterRejection).toBe(initialUsedCapacity);

    // 8. Verify host received a notification explaining rejection and capacity return
    const notification = await Notification.findOne({
      where: {
        userId: hostUser.id,
        type: 'listing_rejected',
      },
      order: [['createdAt', 'DESC']],
    });
    expect(notification).not.toBeNull();
    expect(notification.title).toContain('Capacity Returned');
    expect(notification.message).toContain('branch capacity has been returned');
  });
});
