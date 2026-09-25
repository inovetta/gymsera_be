/**
 * Read-only capacity diagnostic for one tenant.
 *
 * Answers, with real numbers rather than inference, why a host is being told
 * "Branch limit reached": what their subscription rows actually say, which
 * one getActiveSubscription picks, what resolveMaxBranches derives from it,
 * and how getUsedCapacity adds up against it.
 *
 * Writes nothing. Safe to run on production.
 *
 *   node scripts/diagnose-tenant-capacity.js <tenantId>
 */
require('dotenv').config();

const { sequelize, Tenant, TenantSubscription, PlatformPackage, GymListing, BillingPlan } = require('../src/models/platform');
const TenantDbManager = require('../src/database/TenantDbManager');
const subscriptionQuotaService = require('../src/services/subscription-quota.service');

const line = (n = 74) => console.log('─'.repeat(n));

(async () => {
  const tenantId = process.argv[2];
  if (!tenantId) {
    console.error('Usage: node scripts/diagnose-tenant-capacity.js <tenantId>');
    process.exit(1);
  }

  try {
    await sequelize.authenticate();

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) {
      console.error(`No tenant with id ${tenantId}`);
      process.exit(1);
    }

    console.log('');
    line();
    console.log(`TENANT  ${tenant.businessName || tenant.id}`);
    line();
    console.log(`  id               : ${tenant.id}`);
    console.log(`  status           : ${tenant.status}`);
    console.log(`  selectedPackageId: ${tenant.selectedPackageId || '(none)'}`);

    if (tenant.selectedPackageId) {
      const pkg = await PlatformPackage.findByPk(tenant.selectedPackageId);
      console.log(`    └─ legacy package: ${pkg ? `${pkg.name} → maxBranches ${pkg.maxBranches}` : '(missing row)'}`);
      console.log('       NOTE: this is the fallback resolveMaxBranches uses when there is');
      console.log('       no ACTIVE store-verified subscription. If the numbers below look');
      console.log('       like they came from here rather than the IAP purchase, that is why.');
    }

    console.log('');
    line();
    console.log('SUBSCRIPTION ROWS  (newest first — the order getActiveSubscription uses)');
    line();

    const subs = await TenantSubscription.findAll({
      where: { tenantId },
      include: [{ model: PlatformPackage, as: 'package', attributes: ['name', 'maxBranches'] }],
      order: [['createdAt', 'DESC']],
    });

    if (!subs.length) console.log('  (none)');
    for (const s of subs) {
      console.log('');
      console.log(`  ${s.status.padEnd(18)} ${s.platform || '(no platform)'}`);
      console.log(`    branchCount    : ${s.branchCount === null ? 'NULL  ← cannot drive maxBranches' : s.branchCount}`);
      console.log(`    billingPlanId  : ${s.billingPlanId || '(none)'}`);
      console.log(`    package        : ${s.package ? `${s.package.name} (maxBranches ${s.package.maxBranches})` : '(none — normal for store purchases)'}`);
      console.log(`    amount / cycle : ${s.amount} ${s.billingCycle}`);
      console.log(`    start → end    : ${s.startDate} → ${s.endDate}`);
      console.log(`    environment    : ${s.environment || '(n/a)'}`);
      console.log(`    externalOrigId : ${s.externalOriginalTransactionId || '(none)'}`);
      if (s.statusNote) console.log(`    statusNote     : ${s.statusNote}`);
    }

    const activeRows = subs.filter((s) => s.status === 'ACTIVE');
    if (activeRows.length > 1) {
      console.log('');
      console.log(`  *** ${activeRows.length} ACTIVE rows. The invariant allows exactly one. ***`);
    }

    console.log('');
    line();
    console.log('WHAT THE CAPACITY CHECK ACTUALLY SEES');
    line();

    const activeSub = await subscriptionQuotaService.getActiveSubscription(tenantId);
    console.log(`  getActiveSubscription → ${activeSub ? `${activeSub.id} (${activeSub.platform || 'legacy'}, branchCount ${activeSub.branchCount})` : 'null'}`);

    const maxBranches = await subscriptionQuotaService.resolveMaxBranches(tenant, activeSub);
    let derivedFrom = 'hardcoded default (1)';
    if (activeSub && activeSub.branchCount != null) derivedFrom = 'activeSub.branchCount (store-verified)';
    else if (activeSub && activeSub.package) derivedFrom = 'activeSub.package.maxBranches (legacy)';
    else if (tenant.selectedPackageId) derivedFrom = 'tenant.selectedPackageId (legacy fallback)';
    console.log(`  resolveMaxBranches    → ${maxBranches}   [from: ${derivedFrom}]`);

    let usedCapacity = null;
    let activeBranches = null;

    if (tenant.status === 'ACTIVE' && tenant.connectionStringEncrypted) {
      const tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
      usedCapacity = await subscriptionQuotaService.getUsedCapacity(tenantId, tenantDb);
      activeBranches = await tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } });

      const listings = await GymListing.findAll({
        where: { tenantId },
        attributes: ['id', 'title', 'status', 'reservedSlots'],
      });

      console.log('');
      console.log('  Organizations:');
      let reservedTotal = 0;
      for (const l of listings) {
        const branchesHere = await tenantDb.models.Branch.count({
          where: { status: 'ACTIVE', gymListingId: l.id },
        });
        if (l.status !== 'INACTIVE') reservedTotal += l.reservedSlots;
        console.log(
          `    ${(l.title || l.id).padEnd(24)} ${l.status.padEnd(9)} ` +
          `activeBranches ${branchesHere}  reservedSlots ${l.reservedSlots}` +
          (l.status === 'INACTIVE' ? '   (INACTIVE — not counted)' : '')
        );
      }

      console.log('');
      console.log(`  activeBranches (real, ACTIVE)     : ${activeBranches}`);
      console.log(`  reservedSlots  (paid, unbuilt)    : ${reservedTotal}`);
      console.log(`  getUsedCapacity = active+reserved : ${usedCapacity}`);
    } else {
      console.log('  (tenant DB unavailable — cannot compute usage)');
    }

    // ── Integrity audit ──────────────────────────────────────────────────
    // Same computation the daily cron and the Super Admin endpoint use —
    // not a second copy of the logic that could drift from them.
    try {
      const tenantDbForAudit =
        tenant.status === 'ACTIVE' && tenant.connectionStringEncrypted
          ? await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted)
          : null;
      const audit = await subscriptionQuotaService.auditCapacity(tenantId, tenantDbForAudit);

      console.log('');
      line();
      console.log(`INTEGRITY AUDIT  ${audit.ok ? 'PASS' : '*** FAIL ***'}`);
      line();
      for (const l of audit.listings) {
        console.log(
          `  ${(l.title || l.listingId).padEnd(24)} reservedSlots ${l.actualReservedSlots}` +
          `  ledger ${l.ledgerReservedSlots}` +
          (l.drift !== 0 ? `   <== DRIFT ${l.drift > 0 ? '+' : ''}${l.drift}` : '')
        );
      }
      if (audit.totalDrift !== 0) {
        console.log('');
        console.log(`  Total ledger drift: ${audit.totalDrift > 0 ? '+' : ''}${audit.totalDrift}`);
        console.log('  reservedSlots and capacity_events disagree. Most likely a slot');
        console.log('  credit lost when a cross-database step failed after the branch');
        console.log('  delete had already committed. Reported, never auto-repaired —');
        console.log('  rewriting either side would destroy the evidence.');
      }
      if (audit.overQuotaMismatch) {
        console.log('');
        console.log(`  overQuotaCount recorded ${audit.recordedOverQuota}, should be ${audit.expectedOverQuota}`);
      }
      if (audit.invariantHolds === false) {
        console.log('');
        console.log(`  INVARIANT BROKEN: used ${audit.usedCapacity} > plan ${audit.maxBranches}`);
      }
    } catch (auditErr) {
      console.log('');
      console.log('INTEGRITY AUDIT  (failed to run:', auditErr.message + ')');
    }

    if (usedCapacity !== null) {
      console.log('');
      line();
      console.log('VERDICT');
      line();
      const remaining = Math.max(0, maxBranches - usedCapacity);
      const buildable = Math.max(0, maxBranches - activeBranches);
      console.log(`  maxBranches                        : ${maxBranches}`);
      console.log(`  remainingBranches (max - used)     : ${remaining}   ← gates a NEW organization`);
      console.log(`  buildableBranches (max - active)   : ${buildable}   ← what the app shows the host`);
      console.log('');
      console.log(`  Add a branch to an existing org?   : ${buildable > 0 ? 'ALLOWED' : 'BLOCKED — branch_limit_reached'}`);
      console.log(`  Create a NEW organization?         : ${remaining > 0 ? 'ALLOWED' : 'BLOCKED — branch_limit_reached'}`);
      if (buildable > 0 && remaining === 0) {
        console.log('');
        console.log('  Both differ because unbuilt reservedSlots count as used but are still');
        console.log('  buildable. A new organization brings no slot of its own, so it is');
        console.log('  refused while building into an existing organization is allowed.');
      }
      if (activeSub && activeSub.overQuotaCount > 0) {
        console.log('');
        console.log(`  *** overQuotaCount = ${activeSub.overQuotaCount} — a past downgrade left more branches`);
        console.log('      than the plan covers. ALL new consumption is blocked until resolved. ***');
      }
    }

    console.log('');
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('');
    console.error('Diagnostic failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
