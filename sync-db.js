const { Sequelize } = require('sequelize');
require('dotenv').config();
const { Tenant } = require('./src/models/platform');
const registerTenantModels = require('./src/models/tenant');
const { decrypt } = require('./src/utils/crypto.utils');

async function sync() {
  try {
    const tenants = await Tenant.findAll();
    console.log(`Found ${tenants.length} tenants. Syncing...`);

    for (const tenant of tenants) {
      if (tenant.connectionStringEncrypted !== 'PENDING_PROVISIONING') {
        const connUrl = decrypt(tenant.connectionStringEncrypted);
        console.log(`Syncing database for tenant ${tenant.tenantCode}...`);
        const tenantSeq = new Sequelize(connUrl, {
          dialect: 'mysql',
          logging: false,
        });
        try {
          await tenantSeq.authenticate();
          registerTenantModels(tenantSeq);
          await tenantSeq.sync({ force: false, alter: true });
          console.log(`Successfully synced database for tenant ${tenant.tenantCode}`);
        } catch (err) {
          console.error(`Failed to sync database for tenant ${tenant.tenantCode}:`, err.message);
        } finally {
          await tenantSeq.close();
        }
      } else {
        console.log(`Tenant ${tenant.tenantCode} is pending provisioning. Skipping.`);
      }
    }
    console.log('All database sync operations completed.');
    process.exit(0);
  } catch (err) {
    console.error('Error during sync:', err);
    process.exit(1);
  }
}

sync();
