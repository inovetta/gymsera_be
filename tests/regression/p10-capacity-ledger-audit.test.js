/**
 * Phase 7 P10 item 3: the nightly capacity audit reported "ledger says -2" and "invariant
 * broken" for 8 test tenants. Read-only investigation of every path that writes
 * GymListing.reservedSlots (create with a reserved slot, transfer, build, delete through the
 * outbox, restore, upgrade, trim, provisioning, backfill): each writes its capacity_events row in
 * the same transaction and applies the change only when the row was new, so no current path
 * double-decrements. Two things explain the report:
 *
 * 1. "ledger says -2" (reproduced below): slots that were on a listing with no ledger row (data
 *    written before the ledger was complete, be 4939bb4 2026-09-25, or by hand) are trimmed by the
 *    nightly pass once the tenant has lapsed (P7c, NEW-171: a lapsed tenant is entitled to 0). The
 *    trim records -2 correctly; the ledger had never seen the +2, so it now reads -2. The drift
 *    (+2) was already there before the trim. Data, not a code path.
 * 2. "invariant broken" (the defect, fixed): auditCapacity treated any tenant over its plan as
 *    broken (`usedCapacity <= maxBranches`). Since P7c every lapsed tenant with a branch is over a
 *    0-branch plan by design (R-82: branches stay, locked after the grace), and a downgrade never
 *    closes branches either. Its own contract says being over is a problem only when it is not
 *    the recorded overage; reconcileCapacity trims every unbuilt slot first, so a tenant over
 *    its plan is broken only while unbuilt slots remain. overQuotaMismatch still reports a wrong
 *    recorded overage.
 */
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const TenantDbManager = require('../../src/database/TenantDbManager');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const alertService = require('../../src/services/alert.service');
const { Notification, City, CapacityEvent } = require('../../src/models/platform');
const { reconcileCapacityForAllTenants } = require('../../src/jobs/subscription-expiry.cron');

describe('P10 item 3: capacity ledger audit on lapsed and over-quota tenants', () => {
  let h;

  const driftAlerts = async () =>
    (await Notification.findAll({ where: { type: 'PLATFORM_ALERT' } })).filter(
      (n) => (n.metadataJson || n.metadata || {}).alertCode === 'CAPACITY_DRIFT'
    );
  const tenantWith = async (subscription) => {
    const tenant = await factories.createTenant({ gymName: 'Ledger Test Gym', tenantDbName: 'gymsera_test_tenant_1' });
    await factories.createTenantSubscription(tenant.id, subscription);
    return tenant;
  };
  const branches = async (listing, n) => {
    for (let i = 0; i < n; i++) await factories.createBranch(h.tenant1, listing.id);
  };

  beforeAll(async () => {
    h = await setupTestDatabases();
  });
  afterAll(async () => {
    await TenantDbManager.releaseAll();
    await teardownTestDatabases();
  });
  beforeEach(async () => {
    await resetTestDatabases();
    await City.create({ id: 1, name: 'Karachi', isActive: true });
    alertService._resetForTests();
    await factories.createUser({ role: 'PLATFORM_ADMIN' });
  });

  test('reproduces "ledger says -2": unledgered slots on a lapsed tenant are trimmed; the drift was there before', async () => {
    const t = await tenantWith({ status: 'EXPIRED', branchCount: 3, overQuotaCount: 0 });
    // 2 unbuilt slots with no capacity_events row (data from before the ledger was complete).
    const listing = await factories.createGymListing(t.id, { status: 'ACTIVE', reservedSlots: 2 });
    await branches(listing, 1);

    const before = await subscriptionQuotaService.auditCapacity(t.id, h.tenant1);
    expect(before.listings[0]).toMatchObject({ actualReservedSlots: 2, ledgerReservedSlots: 0, drift: 2 });

    await reconcileCapacityForAllTenants();

    const after = await subscriptionQuotaService.auditCapacity(t.id, h.tenant1);
    expect(after.listings[0]).toMatchObject({ actualReservedSlots: 0, ledgerReservedSlots: -2, drift: 2 });
    const trims = await CapacityEvent.findAll({ where: { tenantId: t.id, action: 'SLOT_TRIMMED_DOWNGRADE' } });
    expect(trims.map((e) => e.delta)).toEqual([-2]); // one trim, recorded once: no double decrement
    // A second run the same day trims nothing and records nothing.
    await reconcileCapacityForAllTenants();
    expect(await CapacityEvent.count({ where: { tenantId: t.id, action: 'SLOT_TRIMMED_DOWNGRADE' } })).toBe(1);
    // The drift is still reported (the data needs an owner decision), now as drift only.
    expect(after.driftedListings).toHaveLength(1);
    expect(after.invariantHolds).toBe(true);
  });

  test('a lapsed tenant with branches and no unbuilt slot is over a 0-branch plan by design: no "invariant broken", no alert', async () => {
    const t = await tenantWith({ status: 'EXPIRED', branchCount: 3, overQuotaCount: 0 });
    const listing = await factories.createGymListing(t.id, { status: 'ACTIVE', reservedSlots: 0 });
    await branches(listing, 2);

    await reconcileCapacityForAllTenants();

    const audit = await subscriptionQuotaService.auditCapacity(t.id, h.tenant1);
    expect(audit).toMatchObject({ maxBranches: 0, activeBranches: 2, recordedOverQuota: 2, expectedOverQuota: 2 });
    expect(audit.invariantHolds).toBe(true);
    expect(audit.ok).toBe(true);
    expect(await driftAlerts()).toHaveLength(0);
  });

  test('an entitled tenant over its plan after a downgrade, overage recorded: ok', async () => {
    const t = await tenantWith({ status: 'ACTIVE', branchCount: 1, overQuotaCount: 0 });
    const listing = await factories.createGymListing(t.id, { status: 'ACTIVE', reservedSlots: 0 });
    await branches(listing, 3);

    await reconcileCapacityForAllTenants();

    const audit = await subscriptionQuotaService.auditCapacity(t.id, h.tenant1);
    expect(audit).toMatchObject({ maxBranches: 1, activeBranches: 3, recordedOverQuota: 2 });
    expect(audit.invariantHolds).toBe(true);
    expect(audit.ok).toBe(true);
    expect(await driftAlerts()).toHaveLength(0);
  });

  test('still broken: over the plan while unbuilt slots remain (the trim did not run)', async () => {
    const t = await tenantWith({ status: 'ACTIVE', branchCount: 1, overQuotaCount: 0 });
    const listing = await factories.createGymListing(t.id, { status: 'ACTIVE', reservedSlots: 1 });
    await branches(listing, 1);
    const audit = await subscriptionQuotaService.auditCapacity(t.id, h.tenant1);
    expect(audit.usedCapacity).toBe(2);
    expect(audit.invariantHolds).toBe(false);
    expect(audit.ok).toBe(false);
  });

  test('still reported: over the plan with the wrong recorded overage', async () => {
    const t = await tenantWith({ status: 'ACTIVE', branchCount: 1, overQuotaCount: 0 });
    const listing = await factories.createGymListing(t.id, { status: 'ACTIVE', reservedSlots: 0 });
    await branches(listing, 3);
    const audit = await subscriptionQuotaService.auditCapacity(t.id, h.tenant1);
    expect(audit.overQuotaMismatch).toBe(true);
    expect(audit.ok).toBe(false);
  });
});
