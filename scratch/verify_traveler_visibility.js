require('dotenv').config();
const { connect: connectPlatformDb } = require('../src/database/platform');
const { Tenant, GymListing } = require('../src/models/platform');
const TenantDbManager = require('../src/database/TenantDbManager');
const discoveryService = require('../src/services/discovery.service');

async function test() {
  await connectPlatformDb();
  console.log('Connected to Platform DB.');

  const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
  console.log(`Found ${tenants.length} active tenants.`);

  for (const tenant of tenants) {
    if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
    try {
      console.log(`Connecting to Tenant DB for ${tenant.businessName} (ID: ${tenant.id})...`);
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { Branch } = tenantDb.models;
      const branches = await Branch.findAll();
      console.log(`Found ${branches.length} branches.`);

      for (const branch of branches) {
        console.log(`- Branch: ${branch.branchName} (ID: ${branch.id}) status: ${branch.status}, travelerVisibilityStatus: ${branch.travelerVisibilityStatus}`);
        
        // Update all branches to 'active' traveler visibility to verify
        await branch.update({
          travelerVisibilityStatus: 'active',
          deactivationReason: null,
          deactivatedAt: null,
          deactivatedBy: null,
        });
        console.log(`  Updated ${branch.branchName} travelerVisibilityStatus to 'active'`);
      }
    } catch (err) {
      console.error(`Error connecting to tenant DB ${tenant.id}:`, err.message);
    }
  }

  // Check discovery service response
  const featured = await discoveryService.featuredGyms();
  console.log(`\nFeatured Gyms after activating all branches: ${featured.length}`);
  featured.forEach(g => {
    console.log(`- Gym: ${g.title} (ID: ${g.id}) with branches count: ${g.branches.length}`);
  });

  // Now deactivate one branch to verify deactivation filter
  for (const tenant of tenants) {
    if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
    try {
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { Branch } = tenantDb.models;
      const branches = await Branch.findAll();
      if (branches.length > 0) {
        const target = branches[0];
        console.log(`\nDeactivating traveler visibility for branch: ${target.branchName} (ID: ${target.id})...`);
        await target.update({
          travelerVisibilityStatus: 'deactivated',
          deactivationReason: 'Test deactivation reason notes',
          deactivatedAt: new Date(),
          deactivatedBy: '00000000-0000-0000-0000-000000000000',
        });
        console.log(`Deactivated ${target.branchName}.`);
        break;
      }
    } catch (err) {
      console.error(err);
    }
  }

  // Check discovery service response again
  const featuredAfterDeactivation = await discoveryService.featuredGyms();
  console.log(`\nFeatured Gyms after deactivation: ${featuredAfterDeactivation.length}`);
  featuredAfterDeactivation.forEach(g => {
    console.log(`- Gym: ${g.title} (ID: ${g.id}) with branches count: ${g.branches.length}`);
  });

  process.exit(0);
}

test().catch(err => {
  console.error(err);
  process.exit(1);
});
