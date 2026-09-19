/**
 * Read-only diagnostic: dumps the raw GymListing + Branch data for every
 * tenant that has more than one organization, so branch-to-organization
 * attribution bugs can be diagnosed from ground truth instead of guessing
 * from what the UI renders.
 *
 * Usage: node src/scripts/diagnose-branch-attribution.js
 */
require('dotenv').config();
const { Tenant, GymListing } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');

(async () => {
  try {
    const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });

    for (const tenant of tenants) {
      if (!tenant.connectionStringEncrypted) continue;

      const listings = await GymListing.findAll({
        where: { tenantId: tenant.id },
        order: [['createdAt', 'ASC']],
      });
      if (listings.length < 2) continue;

      console.log('=====================================================');
      console.log(`Tenant: ${tenant.businessName || tenant.id} (${tenant.id})`);
      console.log('--- GymListings (platform DB) ---');
      for (const l of listings) {
        console.log(
          `  id=${l.id}  title=${JSON.stringify(l.title)}  status=${l.status}  branchId=${l.branchId}  reservedSlots=${l.reservedSlots}`
        );
      }

      try {
        const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const branches = await tenantDb.models.Branch.findAll({ order: [['createdAt', 'ASC']] });
        console.log('--- Branches (tenant DB) ---');
        for (const b of branches) {
          console.log(
            `  id=${b.id}  branchName=${JSON.stringify(b.branchName)}  status=${b.status}  gymId=${b.gymId}  gymListingId=${b.gymListingId}`
          );
        }

        const gyms = await tenantDb.models.Gym.findAll();
        console.log('--- Gyms (tenant DB) ---');
        for (const g of gyms) {
          console.log(`  id=${g.id}  name=${JSON.stringify(g.name)}  gymListingId=${g.gymListingId}`);
        }
      } catch (err) {
        console.log(`  [Error reading tenant DB: ${err.message}]`);
      }
    }

    console.log('=====================================================');
    console.log('Done.');
  } catch (err) {
    console.error('Diagnostic failed:', err);
  } finally {
    process.exit(0);
  }
})();
