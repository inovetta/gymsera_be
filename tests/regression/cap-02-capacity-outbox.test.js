const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
  asPersona,
} = require('../harness');
const gymService = require('../../src/services/gym.service');
const capacityOutboxService = require('../../src/services/capacity-outbox.service');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const { GymListing, CapacityEvent } = require('../../src/models/platform');

describe('CAP-02: Cross-Database Capacity Credit Outbox and Durability', () => {
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

  test('Normal branch deletion writes outbox entry and processes it immediately', async () => {
    const { Branch, CapacityOutbox } = tenantDb.models;

    // Create an organization and an active branch
    const listing = await factories.createGymListing(tenantId, {
      title: 'Outbox Test Org 1',
      status: 'ACTIVE',
      reservedSlots: 0,
    });

    const gym = await tenantDb.models.Gym.create({
      gymListingId: listing.id,
      name: 'Outbox Gym 1',
    });

    const branch = await Branch.create({
      gymId: gym.id,
      gymListingId: listing.id,
      branchName: 'Outbox Normal Branch',
      status: 'ACTIVE',
    });

    // Also need an initial membership plan so delete cascades cleanly
    await tenantDb.models.MembershipPlan.create({
      gymId: gym.id,
      branchId: branch.id,
      name: 'Plan 1',
      price: 50,
      status: 'ACTIVE',
      isPublic: true,
      isDeactivated: false,
    });

    // Delete the branch
    await gymService.deleteBranch(tenantDb, branch.id, hostUser.id, { confirmOrganizationDeletion: true });

    // Verify tenant DB
    await branch.reload();
    expect(branch.status).toBe('INACTIVE');

    // Verify outbox row exists and was processed immediately
    const outboxRow = await CapacityOutbox.findOne({
      where: {
        eventType: 'BRANCH_DELETED',
        idempotencyKey: { [require('sequelize').Op.like]: `branch_delete:${branch.id}:%` },
      },
    });
    expect(outboxRow).not.toBeNull();
    expect(outboxRow.status).toBe('PROCESSED');
    expect(outboxRow.processedAt).not.toBeNull();

    // Verify platform DB got the credit
    await listing.reload();
    expect(listing.reservedSlots).toBe(1);

    // Verify CapacityEvent exists
    const event = await CapacityEvent.findOne({
      where: { idempotencyKey: outboxRow.idempotencyKey },
    });
    expect(event).not.toBeNull();
    expect(event.action).toBe('BRANCH_DELETED');
    expect(event.delta).toBe(1);
  });

  test('Failure after tenant commit leaves outbox entry PENDING; daily sweep recovers credit exactly once with zero audit drift', async () => {
    const { Branch, CapacityOutbox } = tenantDb.models;

    // Create an organization and an active branch
    const listing = await factories.createGymListing(tenantId, {
      title: 'Outbox Test Org 2',
      status: 'ACTIVE',
      reservedSlots: 0,
    });

    const gym = await tenantDb.models.Gym.create({
      gymListingId: listing.id,
      name: 'Outbox Gym 2',
    });

    const branch = await Branch.create({
      gymId: gym.id,
      gymListingId: listing.id,
      branchName: 'Outbox Crash Branch',
      status: 'ACTIVE',
    });

    await tenantDb.models.MembershipPlan.create({
      gymId: gym.id,
      branchId: branch.id,
      name: 'Plan 2',
      price: 50,
      status: 'ACTIVE',
      isPublic: true,
      isDeactivated: false,
    });

    // Intercept capacityOutboxService.processOutboxEntry to simulate crash / network drop right after tenant commit
    const originalProcess = capacityOutboxService.processOutboxEntry;
    const processSpy = jest.spyOn(capacityOutboxService, 'processOutboxEntry')
      .mockImplementation(async (tdb, outboxId) => {
        // Record failure on outbox row as if process crashed / network threw
        const Model = tdb.models.CapacityOutbox;
        const entry = await Model.findByPk(outboxId);
        if (entry) {
          await entry.increment('attempts', { by: 1 });
          await entry.update({ status: 'FAILED', lastError: 'Simulated network failure to platform DB' });
        }
        throw new Error('Simulated network failure to platform DB');
      });

    // Execute deleteBranch
    await gymService.deleteBranch(tenantDb, branch.id, hostUser.id, { confirmOrganizationDeletion: true });

    // Restore spy
    processSpy.mockRestore();

    // 1. Verify tenant DB shows branch INACTIVE
    await branch.reload();
    expect(branch.status).toBe('INACTIVE');

    // 2. Verify Outbox row exists and is NOT processed yet
    const outboxRow = await CapacityOutbox.findOne({
      where: {
        eventType: 'BRANCH_DELETED',
        idempotencyKey: { [require('sequelize').Op.like]: `branch_delete:${branch.id}:%` },
      },
    });
    expect(outboxRow).not.toBeNull();
    expect(outboxRow.status).toBe('FAILED');
    expect(outboxRow.processedAt).toBeNull();
    expect(outboxRow.attempts).toBeGreaterThanOrEqual(1);

    // 3. Platform DB has NOT received the credit yet
    await listing.reload();
    expect(listing.reservedSlots).toBe(0);

    // 4. Run the capacity outbox sweep (same as subscription-expiry.cron.js)
    const sweepResult = await capacityOutboxService.sweepAllTenantsOutbox();
    expect(sweepResult.totalProcessed).toBeGreaterThanOrEqual(1);

    // 5. Verify outbox row is now PROCESSED
    await outboxRow.reload();
    expect(outboxRow.status).toBe('PROCESSED');
    expect(outboxRow.processedAt).not.toBeNull();
    expect(outboxRow.lastError).toBeNull();

    // 6. Verify platform DB has received the credit exactly once
    await listing.reload();
    expect(listing.reservedSlots).toBe(1);

    // 7. Verify re-running sweep changes nothing (idempotent)
    const secondSweep = await capacityOutboxService.sweepAllTenantsOutbox();
    expect(secondSweep.totalProcessed).toBe(0);
    await listing.reload();
    expect(listing.reservedSlots).toBe(1);

    // 8. Verify auditCapacity reports no drift
    const audit = await subscriptionQuotaService.auditCapacity(tenantId, tenantDb);
    expect(audit.driftedListings.filter(l => l.listingId === listing.id)).toHaveLength(0);
    expect(audit.totalDrift).toBe(0);
  });
});
