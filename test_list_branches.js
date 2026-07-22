require('dotenv').config();
const { connect: initPlatformDb } = require('./src/database/platform');
const { Tenant } = require('./src/models/platform');
const TenantDbManager = require('./src/database/TenantDbManager');
const gymService = require('./src/services/gym.service');

async function main() {
  await initPlatformDb();
  const tenant = await Tenant.findOne({
    where: { tenantCode: 'IRONPEAK' }
  });
  if (!tenant) {
    console.log('IRONPEAK tenant not found');
    process.exit(1);
  }
  console.log('Found tenant:', tenant.id, tenant.tenantCode);

  const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  console.log('Connected to tenant DB');

  try {
    const result = await gymService.listBranches(tenantDb, tenant.id);
    console.log('SUCCESS! listBranches result has', result.branches.length, 'branches');
  } catch (err) {
    console.error('ERROR in listBranches:', err);
  }

  process.exit(0);
}

main().catch(console.error);
