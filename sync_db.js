require('dotenv').config();
const { Sequelize } = require('sequelize');
const { Tenant } = require('./src/models/platform');
const registerTenantModels = require('./src/models/tenant');
const { decrypt } = require('./src/utils/crypto.utils');

async function main() {
  const tenants = await Tenant.findAll();
  const results = [];

  for (const tenant of tenants) {
    if (tenant.connectionStringEncrypted !== 'PENDING_PROVISIONING') {
      const connUrl = decrypt(tenant.connectionStringEncrypted);
      const tenantSeq = new Sequelize(connUrl, {
        dialect: 'mysql',
        logging: false,
      });
      try {
        await tenantSeq.authenticate();
        registerTenantModels(tenantSeq);
        await tenantSeq.sync({ force: false, alter: true });
        console.log(`Synced tenant: ${tenant.tenantCode} successfully`);
      } catch (err) {
        console.error(`Failed to sync tenant: ${tenant.tenantCode}: ${err.message}`);
      } finally {
        await tenantSeq.close();
      }
    } else {
      console.log(`Skipped tenant: ${tenant.tenantCode} (PENDING_PROVISIONING)`);
    }
  }
}

main().then(() => console.log('Sync complete.')).catch(console.error);
