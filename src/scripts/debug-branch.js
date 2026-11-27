const TenantDbManager = require('../database/TenantDbManager');
const { Tenant } = require('../models/platform');
const { connect: connectPlatform } = require('../database/platform');

async function main() {
  process.env.NODE_ENV = 'development';
  await connectPlatform();
  const organizationId = '8a4b6e17-69ff-4fb8-bfb6-160ad8ae31f7';
  const tenant = await Tenant.findOne({ where: { id: organizationId } });
  if (!tenant) {
    console.error('Tenant not found in platform DB');
    process.exit(1);
  }

  console.log('Found tenant:', tenant.firstBusinessName);
  const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  
  const gyms = await tenantDb.models.Gym.findAll();
  console.log('\n--- Gyms ---');
  for (const g of gyms) {
    console.log(`ID: ${g.id}, Name: ${g.name}, businessId: ${g.businessId}`);
  }

  const branches = await tenantDb.models.Branch.findAll();
  console.log('\n--- Branches ---');
  for (const b of branches) {
    console.log(`ID: ${b.id}, Name: ${b.branchName}, businessId: ${b.businessId}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
