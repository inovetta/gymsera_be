const path = require('path');
const backendPath = '/Users/powertech/Developer/Apps/InovettaTech/SaaS/gymsera_be/src';
const TenantDbManager = require(path.join(backendPath, 'database/TenantDbManager'));
const { Tenant } = require(path.join(backendPath, 'models/platform'));
const { connect: connectPlatform } = require(path.join(backendPath, 'database/platform'));

async function main() {
  process.env.NODE_ENV = 'development';
  process.env.PLATFORM_DB_HOST = 'localhost';
  process.env.PLATFORM_DB_PORT = '3306';
  process.env.PLATFORM_DB_NAME = 'gymsera_platform';
  process.env.PLATFORM_DB_USER = 'root';
  process.env.PLATFORM_DB_PASS = '';
  process.env.TENANT_CONN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  await connectPlatform();
  const tenantId = '8a4b6e17-69ff-4fb8-bfb6-160ad8ae31f7';
  const tenant = await Tenant.findOne({ where: { id: tenantId } });
  if (!tenant) {
    console.error('Tenant not found in platform DB');
    process.exit(1);
  }

  console.log('Found tenant:', tenant.gymName);
  const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  
  const gyms = await tenantDb.models.Gym.findAll();
  console.log('\n--- Gyms ---');
  for (const g of gyms) {
    console.log(`ID: ${g.id}, Name: ${g.name}, gymListingId: ${g.gymListingId}`);
  }

  const branches = await tenantDb.models.Branch.findAll();
  console.log('\n--- Branches ---');
  for (const b of branches) {
    console.log(`ID: ${b.id}, Name: ${b.branchName}, gymId: ${b.gymId}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
