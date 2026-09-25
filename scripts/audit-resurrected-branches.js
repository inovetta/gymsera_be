/**
 * Forensic, read-only check across EVERY tenant for whether the
 * TenantDbManager.getConnection resurrection bug (fixed 2026-09-25) already
 * fired for real, before this fix landed.
 *
 * That bug ran, on every tenant's first connection-pool cache miss (every
 * deploy/iisreset, and every explicit TenantDbManager.release call —
 * notably suspendTenant/rejectTenant), an unconditional
 *   UPDATE branches SET status = 'ACTIVE' WHERE status = 'INACTIVE' OR ...
 * with no CapacityEvent, no reservedSlots debit, and no restoreBranch
 * capacity check — the exact free-branch shape, just triggered by server
 * uptime instead of a host action.
 *
 * The capacity-audit endpoint (auditCapacity) does NOT reliably catch this
 * historically: it compares reservedSlots against the CapacityEvent ledger,
 * but this bug never touched reservedSlots at all, and it only flags an
 * invariant violation when the resurrected branch actually pushed the
 * tenant over their plan. A tenant with spare headroom who got a branch
 * back for free would show a perfectly clean audit.
 *
 * This check is more direct: every CapacityEvent action='BRANCH_DELETED'
 * row names the exact branch that was deleted and credited. If that branch
 * is CURRENTLY status='ACTIVE' in the tenant DB, and there is no later,
 * legitimate event that explains it becoming active again
 * (SLOT_CONSUMED_BUILD via a real build, or the branch simply being
 * deleted-and-never-touched-again is fine — ACTIVE is the anomaly), that's
 * direct evidence this branch was resurrected without ever going through
 * restoreBranch.
 *
 * Writes nothing. Safe to run on production.
 *
 *   node scripts/audit-resurrected-branches.js
 */
require('dotenv').config();
const { sequelize, Tenant, CapacityEvent } = require('../src/models/platform');
const TenantDbManager = require('../src/database/TenantDbManager');

(async () => {
  console.log('--- Scanning for branches resurrected by the getConnection bug (fixed 2026-09-25) ---\n');

  const tenants = await Tenant.findAll({
    where: {},
    attributes: ['id', 'businessName', 'status', 'connectionStringEncrypted'],
  });

  let tenantsChecked = 0;
  let suspiciousBranches = 0;
  const findings = [];

  for (const tenant of tenants) {
    if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;

    const deletions = await CapacityEvent.findAll({
      where: { tenantId: tenant.id, action: 'BRANCH_DELETED' },
      attributes: ['branchId', 'createdAt', 'listingId'],
      order: [['createdAt', 'ASC']],
    });
    if (!deletions.length) continue;

    tenantsChecked++;
    let tenantDb;
    try {
      tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
    } catch (err) {
      console.log(`  [skip] ${tenant.businessName}: could not connect (${err.message})`);
      continue;
    }

    for (const del of deletions) {
      if (!del.branchId) continue;
      const branch = await tenantDb.models.Branch.findByPk(del.branchId).catch(() => null);
      if (!branch) continue; // branch row genuinely gone, nothing to check

      if (branch.status === 'ACTIVE') {
        // Legitimate re-activation goes through restoreBranch, which always
        // clears deactivatedAt/deactivatedBy back to null. If those are
        // still null-cleared AND there's no SLOT_CONSUMED_BUILD/other event
        // after the deletion for this branch, this row was very likely
        // flipped straight in the database, not through the app.
        const laterEvents = await CapacityEvent.count({
          where: {
            tenantId: tenant.id,
            branchId: del.branchId,
            createdAt: { [require('sequelize').Op.gt]: del.createdAt },
          },
        });
        suspiciousBranches++;
        findings.push({
          tenant: tenant.businessName,
          tenantId: tenant.id,
          branchId: del.branchId,
          branchName: branch.branchName,
          deletedAt: del.createdAt,
          laterCapacityEvents: laterEvents,
        });
      }
    }
  }

  console.log(`Tenants with at least one branch deletion in their history: ${tenantsChecked}`);
  console.log(`Branches currently ACTIVE despite a BRANCH_DELETED event: ${suspiciousBranches}\n`);

  if (findings.length) {
    console.log('=== SUSPECT BRANCHES ===');
    for (const f of findings) {
      console.log(`\n  Tenant   : ${f.tenant} (${f.tenantId})`);
      console.log(`  Branch   : ${f.branchName} (${f.branchId})`);
      console.log(`  Deleted  : ${f.deletedAt.toISOString()}`);
      console.log(`  Later capacity_events for this branch: ${f.laterCapacityEvents}`);
      console.log(
        f.laterCapacityEvents === 0
          ? '  --> HIGH CONFIDENCE: resurrected outside the app. No legitimate path leaves zero follow-up events.'
          : '  --> Has later events — check them manually; could be a legitimate restore.'
      );
    }
    console.log('\nThese are reports, not repairs. Confirm with the host before touching anything —');
    console.log('a branch a host is actively using should not be deleted out from under them even');
    console.log('if it arrived there by this bug; decide capacity/billing consequences deliberately.');
  } else {
    console.log('No evidence found. Either the bug never fired for a tenant with delete history,');
    console.log('or (worth knowing) a resurrected branch whose deletion predates the CapacityEvent');
    console.log('ledger itself would not be caught by this check — the ledger only covers what it');
    console.log('was recording at the time.');
  }

  await sequelize.close();
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
