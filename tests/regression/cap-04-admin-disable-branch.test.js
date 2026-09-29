const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
  asPersona,
} = require('../harness');
const adminService = require('../../src/services/admin.service');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const discoveryService = require('../../src/services/discovery.service');
const { GymListing, TenantSubscription } = require('../../src/models/platform');

describe('CAP-04: Admin Disable Branch Lifecycle and Policy Suspension', () => {
  let dbHarness;
  let tenantId;
  let personas;
  let listing;
  let branch;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenantId = personas.owner.tenantId;

    listing = await GymListing.findOne({ where: { tenantId } });
    const { Branch, MembershipPlan } = dbHarness.tenant1.models;
    branch = await Branch.findOne({ where: { gymListingId: listing.id } });

    // Ensure branch has an active plan and is published to discovery
    await MembershipPlan.create({
      gymId: branch.gymId,
      branchId: branch.id,
      name: 'Public Pass',
      price: 100,
      status: 'ACTIVE',
      isPublic: true,
      isDeactivated: false,
    });
    await branch.update({
      status: 'ACTIVE',
      travelerVisibilityStatus: 'active',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('Admin disable leaves capacity unchanged, hides branch from discovery, and writes audit rows', async () => {
    const { Branch, AuditLog, BranchVisibilityHistory } = dbHarness.tenant1.models;

    // Check capacity before admin disable
    const usedCapacityBefore = await subscriptionQuotaService.getUsedCapacity(tenantId, dbHarness.tenant1);
    const listingBefore = await GymListing.findByPk(listing.id);
    const reservedSlotsBefore = listingBefore.reservedSlots;

    // Admin disables branch for policy reason
    const res = await asPersona('platformAdmin').post(
      `/admin/tenants/${tenantId}/branches/${branch.id}/suspend`,
      { reason: 'TOS violation: unauthorized equipment' }
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // 1. Verify capacity is completely UNCHANGED
    const usedCapacityAfter = await subscriptionQuotaService.getUsedCapacity(tenantId, dbHarness.tenant1);
    expect(usedCapacityAfter).toBe(usedCapacityBefore);

    const listingAfter = await GymListing.findByPk(listing.id);
    expect(listingAfter.reservedSlots).toBe(reservedSlotsBefore);

    // 2. Verify branch fields: status stays ACTIVE, adminSuspended is true
    await branch.reload();
    expect(branch.status).toBe('ACTIVE');
    expect(branch.adminSuspended).toBe(true);
    expect(branch.adminSuspendedReason).toBe('TOS violation: unauthorized equipment');
    expect(branch.adminSuspendedBy).toBe(personas.platformAdmin.user.id);
    expect(branch.travelerVisibilityStatus).toBe('deactivated');

    // 3. Verify hidden from public discovery
    const nearby = await discoveryService.nearbyGyms({
      lat: branch.latitude || 31.5204,
      lng: branch.longitude || 74.3587,
      radiusKm: 50,
    });
    const foundInDiscovery = nearby.gyms?.some((b) => b.id === branch.id) ||
      nearby.branches?.some((b) => b.id === branch.id);
    expect(foundInDiscovery).toBeFalsy();

    // 4. Verify host cannot bypass policy by republishing visibility
    const hostUpdateRes = await asPersona('owner').patch(`/gyms/branches/${branch.id}`, {
      travelerVisibilityStatus: 'active',
    });
    expect(hostUpdateRes.status).toBe(403);

    // 5. Verify audit rows written
    const auditRow = await AuditLog.findOne({
      where: {
        branchId: branch.id,
        action: 'branch.admin_suspend',
      },
      order: [['createdAt', 'DESC']],
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow.actorUserId).toBe(personas.platformAdmin.user.id);
    expect(auditRow.actorRoleKey).toBe('PLATFORM_ADMIN');

    const historyRow = await BranchVisibilityHistory.findOne({
      where: {
        branchId: branch.id,
        status: 'deactivated',
      },
      order: [['changedAt', 'DESC']],
    });
    expect(historyRow).not.toBeNull();
    expect(historyRow.reason).toBe('TOS violation: unauthorized equipment');
  });

  test('Admin unsuspend restores branch policy state without touching capacity', async () => {
    const { Branch, AuditLog } = dbHarness.tenant1.models;

    const usedCapacityBefore = await subscriptionQuotaService.getUsedCapacity(tenantId, dbHarness.tenant1);

    const res = await asPersona('platformAdmin').post(
      `/admin/tenants/${tenantId}/branches/${branch.id}/unsuspend`
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Capacity unchanged
    const usedCapacityAfter = await subscriptionQuotaService.getUsedCapacity(tenantId, dbHarness.tenant1);
    expect(usedCapacityAfter).toBe(usedCapacityBefore);

    await branch.reload();
    expect(branch.adminSuspended).toBe(false);
    expect(branch.adminSuspendedReason).toBeNull();
    expect(branch.status).toBe('ACTIVE');

    // Audit log for unsuspend
    const auditRow = await AuditLog.findOne({
      where: {
        branchId: branch.id,
        action: 'branch.admin_unsuspend',
      },
      order: [['createdAt', 'DESC']],
    });
    expect(auditRow).not.toBeNull();
  });

  test('Admin delete calls deleteBranch, changes status to INACTIVE and credits capacity via reservedSlots', async () => {
    const { Branch } = dbHarness.tenant1.models;

    const listingBefore = await GymListing.findByPk(listing.id);
    const reservedSlotsBefore = listingBefore.reservedSlots;

    // Admin deletes branch with confirmOrganizationDeletion
    const res = await asPersona('platformAdmin')
      .delete(`/admin/tenants/${tenantId}/branches/${branch.id}`)
      .send({ confirmOrganizationDeletion: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await branch.reload();
    expect(branch.status).toBe('INACTIVE');

    // Deletion credited a reservedSlot to the listing
    const listingAfter = await GymListing.findByPk(listing.id);
    expect(listingAfter.reservedSlots).toBe(reservedSlotsBefore + 1);
  });
});
