require('dotenv').config();
const { Sequelize } = require('sequelize');
const { Tenant } = require('./src/models/platform');
const registerTenantModels = require('./src/models/tenant');
const { decrypt } = require('./src/utils/crypto.utils');

async function main() {
  const tenants = await Tenant.findAll();

  for (const tenant of tenants) {
    if (tenant.connectionStringEncrypted && tenant.connectionStringEncrypted !== 'PENDING_PROVISIONING') {
      const connUrl = decrypt(tenant.connectionStringEncrypted);
      const tenantSeq = new Sequelize(connUrl, {
        dialect: 'mysql',
        logging: false,
      });
      try {
        await tenantSeq.authenticate();
        const models = registerTenantModels(tenantSeq);
        const { Branch } = models;

        const [affectedCount] = await Branch.update(
          { travelerVisibilityStatus: 'active' },
          { where: { status: 'ACTIVE' } }
        );

        console.log(`Updated ${affectedCount} active branches to visible on tenant: ${tenant.tenantCode}`);
      } catch (err) {
        console.error(`Failed to update tenant: ${tenant.tenantCode}: ${err.message}`);
      } finally {
        await tenantSeq.close();
      }
    }
  }
}

main().then(() => console.log('Activation complete.')).catch(console.error);
