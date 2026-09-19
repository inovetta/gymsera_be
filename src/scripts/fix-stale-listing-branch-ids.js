/**
 * One-off repair for GymListing.branchId pointers left stale by branch
 * moves that happened before gym.service.js#moveBranch started keeping
 * them in sync (see that function's own comment for the full story — a
 * branch's own gymListingId was always correct, but the OLD listing's
 * branchId kept pointing at a branch that had since moved elsewhere,
 * which is what made a moved branch visibly appear under both its old and
 * new organization in the Gyms tab at once).
 *
 * For every GymListing with a branchId set, checks whether that branch
 * actually still belongs to this listing (gymListingId matches). If not,
 * reassigns branchId to another real branch still under this listing, or
 * clears it to null if none remain.
 *
 * Usage: node src/scripts/fix-stale-listing-branch-ids.js
 */
require('dotenv').config();
const { Tenant, GymListing } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');

(async () => {
  console.log('--- Fixing stale GymListing.branchId pointers ---');
  let checked = 0;
  let fixed = 0;

  try {
    const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });

    for (const tenant of tenants) {
      if (!tenant.connectionStringEncrypted) continue;

      const listings = await GymListing.findAll({
        where: { tenantId: tenant.id, branchId: { [require('sequelize').Op.ne]: null } },
      });
      if (listings.length === 0) continue;

      let tenantDb;
      try {
        tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      } catch (err) {
        console.warn(`[Skip] Tenant ${tenant.id}: ${err.message}`);
        continue;
      }

      for (const listing of listings) {
        checked++;
        const pointedBranch = await tenantDb.models.Branch.findByPk(listing.branchId);
        const isStale = !pointedBranch || pointedBranch.gymListingId !== listing.id;
        if (!isStale) continue;

        const realBranch = await tenantDb.models.Branch.findOne({
          where: { gymListingId: listing.id, status: 'ACTIVE' },
        });
        await listing.update({ branchId: realBranch ? realBranch.id : null });
        console.log(
          `[Fixed] Tenant ${tenant.businessName || tenant.id}: listing "${listing.title}" (${listing.id}) ` +
            `branchId ${listing.branchId ? 'was stale' : ''} -> ${realBranch ? realBranch.id : 'null'}`
        );
        fixed++;
      }
    }

    console.log('-----------------------------------');
    console.log(`Checked ${checked} listing(s) with a branchId set, fixed ${fixed}.`);
  } catch (err) {
    console.error('Repair failed:', err);
  } finally {
    process.exit(0);
  }
})();
