require('dotenv').config();
const { sequelize, Tenant, TenantSubscription, PlatformPackage, GymListing } = require('../src/models/platform');
const TenantDbManager = require('../src/database/TenantDbManager');
const q = require('../src/services/subscription-quota.service');

(async () => {
  const id = process.argv[2];
  try {
    const t = await Tenant.findByPk(id);
    if (!t) { console.log('NO SUCH TENANT'); process.exit(1); }

    console.log('\n=== TENANT ===');
    console.log('name             :', t.businessName);
    console.log('status           :', t.status);
    console.log('selectedPackageId:', t.selectedPackageId || '(none)');
    if (t.selectedPackageId) {
      const p = await PlatformPackage.findByPk(t.selectedPackageId);
      console.log('  legacy package :', p ? p.name + ' maxBranches=' + p.maxBranches : '(MISSING ROW)');
    }

    console.log('\n=== SUBSCRIPTION ROWS (newest first) ===');
    const subs = await TenantSubscription.findAll({
      where: { tenantId: id },
      include: [{ model: PlatformPackage, as: 'package', attributes: ['name', 'maxBranches'] }],
      order: [['createdAt', 'DESC']],
    });
    subs.forEach((s) => {
      console.log('\n', s.status, '|', s.platform || 'NO-PLATFORM');
      console.log('   branchCount  :', s.branchCount === null ? 'NULL  <== cannot set maxBranches' : s.branchCount);
      console.log('   billingPlanId:', s.billingPlanId || '(none)');
      console.log('   package      :', s.package ? s.package.name + ' maxBranches=' + s.package.maxBranches : '(none)');
      console.log('   platformPkgId:', s.platformPackageId || '(none)');
      console.log('   amount/cycle :', s.amount, s.billingCycle);
      console.log('   dates        :', s.startDate, '->', s.endDate);
      console.log('   env          :', s.environment || '(n/a)');
    });
    console.log('\nACTIVE row count :', subs.filter((s) => s.status === 'ACTIVE').length, '(must be 1)');

    console.log('\n=== WHAT THE CAPACITY CHECK SEES ===');
    const a = await q.getActiveSubscription(id);
    console.log('getActiveSubscription:', a ? a.id + ' branchCount=' + a.branchCount : 'NULL');
    const max = await q.resolveMaxBranches(t, a);
    let from = 'default 1';
    if (a && a.branchCount != null) from = 'activeSub.branchCount (STORE-VERIFIED)';
    else if (a && a.package) from = 'activeSub.package.maxBranches (LEGACY)';
    else if (t.selectedPackageId) from = 'tenant.selectedPackageId (LEGACY FALLBACK)';
    console.log('resolveMaxBranches   :', max, ' <== FROM:', from);
    if (a) console.log('overQuotaCount       :', a.overQuotaCount);

    if (t.status === 'ACTIVE' && t.connectionStringEncrypted) {
      const db = await TenantDbManager.getConnection(id, t.connectionStringEncrypted);
      const used = await q.getUsedCapacity(id, db);
      const active = await db.models.Branch.count({ where: { status: 'ACTIVE' } });
      console.log('\n=== ORGANIZATIONS ===');
      const ls = await GymListing.findAll({ where: { tenantId: id }, attributes: ['id', 'title', 'status', 'reservedSlots'] });
      for (const l of ls) {
        const b = await db.models.Branch.count({ where: { status: 'ACTIVE', gymListingId: l.id } });
        console.log(' ', (l.title || l.id), '|', l.status, '| activeBranches=' + b, '| reservedSlots=' + l.reservedSlots);
      }
      console.log('\n=== VERDICT ===');
      console.log('maxBranches      :', max);
      console.log('activeBranches   :', active);
      console.log('usedCapacity     :', used, '(active + reservedSlots)');
      console.log('remaining (new org)   :', Math.max(0, max - used), Math.max(0, max - used) > 0 ? 'ALLOWED' : 'BLOCKED');
      console.log('buildable (new branch):', Math.max(0, max - active), Math.max(0, max - active) > 0 ? 'ALLOWED' : 'BLOCKED');
    }
    console.log('');
    await sequelize.close();
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
