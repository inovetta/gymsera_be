const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
  asPersona,
} = require('../harness');
const gymService = require('../../src/services/gym.service');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const { GymListing, TenantSubscription, CapacityEvent } = require('../../src/models/platform');
const { Op } = require('sequelize');

describe('CAP-08: Branch Capacity Concurrency Controls', () => {
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

  test('20 parallel createBranch calls with room for 3 -> exactly 3 succeed, 17 fail with 403 branch_limit_reached', async () => {
    const { Branch, Gym } = tenantDb.models;

    // 1. Reset active branches and set capacity to exactly 3
    await Branch.update({ status: 'INACTIVE' }, { where: {} });
    await GymListing.update({ status: 'INACTIVE', reservedSlots: 0 }, { where: { tenantId } });

    let sub = await subscriptionQuotaService.getActiveSubscription(tenantId);
    if (sub) {
      await sub.update({ branchCount: 3, overQuotaCount: 0 });
    } else {
      sub = await factories.createTenantSubscription(tenantId, { branchCount: 3, overQuotaCount: 0 });
    }

    const listing = await factories.createGymListing(tenantId, {
      title: 'Concurrency Org',
      status: 'ACTIVE',
      reservedSlots: 0,
      hostId: hostUser.id,
    });
    await Gym.create({
      gymListingId: listing.id,
      name: 'Concurrency Gym',
    });

    // Verify initial capacity is 0 used out of 3 max
    const initialUsed = await subscriptionQuotaService.getUsedCapacity(tenantId, tenantDb);
    expect(initialUsed).toBe(0);

    // 2. Launch 20 concurrent createBranch requests
    const branchPromises = Array.from({ length: 20 }, (_, i) =>
      gymService.createBranch(
        tenantDb,
        tenantId,
        {
          gymListingId: listing.id,
          branchName: `Parallel Branch ${i + 1}`,
          packages: [
            {
              name: `Plan ${i + 1}`,
              price: 50,
              durationType: 'MONTHLY',
              durationValue: 1,
            },
          ],
        },
        hostUser.id
      )
    );

    const results = await Promise.allSettled(branchPromises);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(succeeded.length).toBe(3);
    expect(rejected.length).toBe(17);

    // Verify rejection reasons
    for (const rej of rejected) {
      expect(rej.reason.statusCode).toBe(403);
      expect(rej.reason.code).toBe('branch_limit_reached');
    }

    // Verify tenantDb branch count and capacity invariant
    const activeBranches = await Branch.count({ where: { status: 'ACTIVE' } });
    expect(activeBranches).toBe(3);

    const usedCapacity = await subscriptionQuotaService.getUsedCapacity(tenantId, tenantDb);
    expect(usedCapacity).toBe(3);

    const audit = await subscriptionQuotaService.auditCapacity(tenantId, tenantDb);
    expect(audit.invariantHolds).toBe(true);
    expect(audit.totalDrift).toBe(0);
    expect(audit.ok).toBe(true);
  }, 60000);

  test('Parallel delete + restore of the same branch preserves consistency without duplicate credits or phantom slots', async () => {
    const { Branch } = tenantDb.models;

    // Ensure we have capacity room
    let sub = await subscriptionQuotaService.getActiveSubscription(tenantId);
    await sub.update({ branchCount: 10, overQuotaCount: 0 });

    // Clean up inactive listings from test 1
    await GymListing.update({ status: 'INACTIVE', reservedSlots: 0 }, { where: { tenantId } });

    const listing = await factories.createGymListing(tenantId, {
      title: 'Del-Restore Org',
      status: 'ACTIVE',
      reservedSlots: 0,
      hostId: hostUser.id,
    });
    await tenantDb.models.Gym.create({
      gymListingId: listing.id,
      name: 'Del-Restore Gym',
    });

    // Create 2 branches in this listing so deleting one does not delete the org
    await gymService.createBranch(
      tenantDb,
      tenantId,
      {
        gymListingId: listing.id,
        branchName: 'Keep Org Alive Branch',
        allowDefaultPackage: true,
      },
      hostUser.id
    );

    const b2Result = await gymService.createBranch(
      tenantDb,
      tenantId,
      {
        gymListingId: listing.id,
        branchName: 'Contended Branch',
        allowDefaultPackage: true,
      },
      hostUser.id
    );
    const targetBranch = b2Result.branch;

    // Fire deleteBranch and restoreBranch simultaneously on the same branch
    const deletePromise = gymService.deleteBranch(
      tenantDb,
      targetBranch.id,
      hostUser.id,
      { confirmOrganizationDeletion: false }
    );
    const restorePromise = gymService.restoreBranch(
      tenantDb,
      tenantId,
      targetBranch.id,
      hostUser.id
    );

    const [deleteRes, restoreRes] = await Promise.allSettled([deletePromise, restorePromise]);

    // One of two valid outcomes under concurrency:
    // Case A: Delete runs first -> delete succeeds. Then restore runs -> restore succeeds. Both fulfilled. Branch ends up ACTIVE.
    // Case B: Restore runs first -> throws 404 (not deleted). Then delete runs -> delete succeeds. Branch ends up INACTIVE.
    if (deleteRes.status === 'fulfilled' && restoreRes.status === 'fulfilled') {
      const reloaded = await Branch.findByPk(targetBranch.id);
      expect(reloaded.status).toBe('ACTIVE');
    } else {
      expect(deleteRes.status).toBe('fulfilled');
      expect(restoreRes.status).toBe('rejected');
      expect(restoreRes.reason.statusCode).toBe(404);
      const reloaded = await Branch.findByPk(targetBranch.id);
      expect(reloaded.status).toBe('INACTIVE');
    }

    // Capacity invariant and audit must be clean regardless of race outcome
    const audit = await subscriptionQuotaService.auditCapacity(tenantId, tenantDb);
    expect(audit.invariantHolds).toBe(true);
    expect(audit.totalDrift).toBe(0);
    expect(audit.ok).toBe(true);

    // Also test parallel duplicate deletes: exactly one succeeds, the other fails with 404
    // Make sure targetBranch is active first
    const currentBranch = await Branch.findByPk(targetBranch.id);
    if (currentBranch.status === 'INACTIVE') {
      await gymService.restoreBranch(tenantDb, tenantId, targetBranch.id, hostUser.id);
    }

    const [dupDel1, dupDel2] = await Promise.allSettled([
      gymService.deleteBranch(tenantDb, targetBranch.id, hostUser.id, { confirmOrganizationDeletion: false }),
      gymService.deleteBranch(tenantDb, targetBranch.id, hostUser.id, { confirmOrganizationDeletion: false }),
    ]);

    const dupDelSuccess = [dupDel1, dupDel2].filter((r) => r.status === 'fulfilled');
    const dupDelFail = [dupDel1, dupDel2].filter((r) => r.status === 'rejected');

    expect(dupDelSuccess.length).toBe(1);
    expect(dupDelFail.length).toBe(1);
    expect(dupDelFail[0].reason.statusCode).toBe(404);

    // Also test parallel duplicate restores: exactly one succeeds, the other fails with 404
    const [dupRes1, dupRes2] = await Promise.allSettled([
      gymService.restoreBranch(tenantDb, tenantId, targetBranch.id, hostUser.id),
      gymService.restoreBranch(tenantDb, tenantId, targetBranch.id, hostUser.id),
    ]);

    const dupResSuccess = [dupRes1, dupRes2].filter((r) => r.status === 'fulfilled');
    const dupResFail = [dupRes1, dupRes2].filter((r) => r.status === 'rejected');

    expect(dupResSuccess.length).toBe(1);
    expect(dupResFail.length).toBe(1);
    expect(dupResFail[0].reason.statusCode).toBe(404);

    const postAudit = await subscriptionQuotaService.auditCapacity(tenantId, tenantDb);
    expect(postAudit.invariantHolds).toBe(true);
    expect(postAudit.totalDrift).toBe(0);
    expect(postAudit.ok).toBe(true);
  });

  test('Parallel new-organization creation competing for one donor slot: exactly one succeeds', async () => {
    const { Branch } = tenantDb.models;

    // Reset listings & branches to establish a clear donor state:
    // Set tenant capacity to 2.
    // Active branches = 1.
    // Donor listing has reservedSlots = 1.
    // Total usedCapacity = 2 (= maxBranches). Free capacity = 0.
    // Exactly 1 donor slot exists on the donor listing.
    let sub = await subscriptionQuotaService.getActiveSubscription(tenantId);
    await sub.update({ branchCount: 2, overQuotaCount: 0 });

    // Clean up previous listings
    await GymListing.update({ status: 'INACTIVE', reservedSlots: 0 }, { where: { tenantId } });

    const donorListing = await factories.createGymListing(tenantId, {
      title: 'Donor Org',
      status: 'ACTIVE',
      reservedSlots: 0,
      hostId: hostUser.id,
    });
    await tenantDb.models.Gym.create({
      gymListingId: donorListing.id,
      name: 'Donor Gym',
    });

    // Leave exactly 1 active branch in the donor listing
    await Branch.update({ status: 'INACTIVE' }, { where: {} });
    await gymService.createBranch(
      tenantDb,
      tenantId,
      {
        gymListingId: donorListing.id,
        branchName: 'Sole Active Branch',
        allowDefaultPackage: true,
      },
      hostUser.id,
      { skipCapacityCheck: true }
    );

    // Give donorListing 1 reserved slot with matching CapacityEvent so auditCapacity ledger has 0 drift
    await subscriptionQuotaService.recordCapacityEvent({
      tenantId,
      listingId: donorListing.id,
      action: 'SLOT_ATTRIBUTED_UPGRADE',
      delta: 1,
      reservedSlotsBefore: 0,
      reservedSlotsAfter: 1,
      actorUserId: hostUser.id,
      actorType: 'HOST',
      reason: 'Seeding test donor slot',
      idempotencyKey: `seed_donor_slot:${donorListing.id}`,
    });
    await donorListing.update({ reservedSlots: 1 });

    const usedBefore = await subscriptionQuotaService.getUsedCapacity(tenantId, tenantDb);
    expect(usedBefore).toBe(2); // 1 active branch + 1 reserved slot = 2 (maxBranches = 2)

    // Two parallel requests to create a new organization competing for the single donor slot
    const createReq1 = asPersona('owner').post('/host/listings', {
      gymName: 'Contender Org 1',
      branchSource: 'new',
      branchName: 'Contender Branch 1',
      address: '101 Street',
      packages: [{ name: 'Monthly', price: 50, durationType: 'MONTHLY', durationValue: 1 }],
    });

    const createReq2 = asPersona('owner').post('/host/listings', {
      gymName: 'Contender Org 2',
      branchSource: 'new',
      branchName: 'Contender Branch 2',
      address: '102 Street',
      packages: [{ name: 'Monthly', price: 50, durationType: 'MONTHLY', durationValue: 1 }],
    });

    const [res1, res2] = await Promise.all([createReq1, createReq2]);

    const successes = [res1, res2].filter((r) => [200, 201].includes(r.status));
    const failures = [res1, res2].filter((r) => [400, 403].includes(r.status));

    // Exactly one must succeed, and one must fail (either branch_limit_reached or approval_pending)
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    // Verify donor listing reservedSlots was decremented by 1 (1 -> 0)
    await donorListing.reload();
    expect(donorListing.reservedSlots).toBe(0);

    // Verify the capacity invariant holds and no capacity was duplicated
    const finalAudit = await subscriptionQuotaService.auditCapacity(tenantId, tenantDb);
    expect(finalAudit.invariantHolds).toBe(true);
    expect(finalAudit.totalDrift).toBe(0);
    expect(finalAudit.ok).toBe(true);
  });
});
