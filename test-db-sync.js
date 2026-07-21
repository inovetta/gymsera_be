const { Sequelize } = require('sequelize');
require('dotenv').config();
const { Tenant } = require('./src/models/platform');
const registerTenantModels = require('./src/models/tenant');
const { decrypt } = require('./src/utils/crypto.utils');

async function run() {
  try {
    const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
    console.log(`Found ${tenants.length} active tenants.`);

    for (const tenant of tenants) {
      if (tenant.tenantCode === 'inovetta1') {
        const connUrl = decrypt(tenant.connectionStringEncrypted);
        console.log(`Syncing database for tenant ${tenant.tenantCode} using connection URL...`);
        const tenantSeq = new Sequelize(connUrl, {
          dialect: 'mysql',
          logging: console.log, // log SQL queries
        });

        try {
          await tenantSeq.authenticate();
          console.log('Authentication successful.');
          registerTenantModels(tenantSeq);
          
          console.log('Running sync()...');
          await tenantSeq.sync({ force: false, alter: true });
          console.log('Sync successful!');
        } catch (syncErr) {
          console.error('Sync failed with error:', syncErr);
        } finally {
          await tenantSeq.close();
        }
      }
    }
    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

run();
