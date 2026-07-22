const { Sequelize } = require('sequelize');
require('dotenv').config();
const { Tenant, User } = require('./src/models/platform');
const TenantDbManager = require('./src/database/TenantDbManager');

async function run() {
  try {
    const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
    console.log(`Active tenants count: ${tenants.length}`);

    const branchId = '666d1917-3a3a-4e3f-81aa-702e3a1861ab';
    console.log(`Looking for branch: ${branchId}`);

    let found = false;
    for (const tenant of tenants) {
      try {
        const { sequelize, models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const branch = await models.Branch.findByPk(branchId);
        if (branch) {
          console.log(`Branch found in tenant: ${tenant.tenantCode}`);
          found = true;

          const requests = await models.StaffActionRequest.findAll();
          console.log(`Total staff action requests in tenant DB: ${requests.length}`);
          for (const r of requests) {
            console.log(`Request ID: ${r.id}, Action: ${r.actionType}, Status: ${r.status}, Payload:`, r.payloadJson);
          }
        }
      } catch (err) {
        console.error(`Error with tenant ${tenant.tenantCode}:`, err);
      }
    }

    if (!found) {
      console.log('Branch not found in any active tenant DB!');
    }

    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

run();
