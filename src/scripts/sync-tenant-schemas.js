require('dotenv').config();
const { Sequelize } = require('sequelize');
const { connect: initPlatformDb } = require('../database/platform');
const { Tenant } = require('../models/platform');
const registerTenantModels = require('../models/tenant');
const { decrypt } = require('../utils/crypto.utils');

async function syncTenant(tenant) {
  const connUrl = decrypt(tenant.connectionStringEncrypted);
  console.log(`\n🔄 Syncing schema for tenant: '${tenant.tenantCode}'...`);

  const tenantSeq = new Sequelize(connUrl, {
    dialect: 'mysql',
    logging: false,
    pool: { max: 3, min: 0, acquire: 30000, idle: 10000 },
  });

  try {
    await tenantSeq.authenticate();
    registerTenantModels(tenantSeq);
    await tenantSeq.sync({ force: false, alter: true });
    console.log(`   ✅ Schema synced successfully for '${tenant.tenantCode}'`);
  } catch (err) {
    console.error(`   ❌ Failed to sync '${tenant.tenantCode}':`, err);
  } finally {
    await tenantSeq.close();
  }
}

async function main() {
  console.log('🚀 Starting tenant database schemas sync...\n');

  await initPlatformDb();

  const tenants = await Tenant.findAll();
  const activeTenants = tenants.filter(t => t.connectionStringEncrypted !== 'PENDING_PROVISIONING');

  if (activeTenants.length === 0) {
    console.log('ℹ️ No active provisioned tenants found.');
    process.exit(0);
  }

  console.log(`Found ${activeTenants.length} active tenant(s) to sync.`);

  for (const tenant of activeTenants) {
    await syncTenant(tenant);
  }

  console.log('\n🎉 Tenant databases sync completed!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Sync script execution failed:', err);
  process.exit(1);
});
