const path = require('path');
const backendPath = __dirname;
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
  const tenants = await Tenant.findAll();
  console.log(`Found ${tenants.length} tenants in platform database.`);

  for (const tenant of tenants) {
    try {
      console.log(`\nConnecting to database for tenant: ${tenant.gymName} (${tenant.id})`);
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { Payment, MemberSubscription } = tenantDb.models;

      // Find all membership payments with null branchId
      const payments = await Payment.findAll({
        where: {
          paymentFor: 'MEMBERSHIP',
          branchId: null
        }
      });

      console.log(`Found ${payments.length} membership payments with null branchId.`);
      let updatedCount = 0;

      for (const payment of payments) {
        if (payment.referenceEntityId) {
          const subscription = await MemberSubscription.findByPk(payment.referenceEntityId);
          if (subscription && subscription.branchId) {
            await payment.update({ branchId: subscription.branchId });
            updatedCount++;
          }
        }
      }

      console.log(`Successfully backfilled branchId for ${updatedCount} payments.`);
    } catch (err) {
      console.error(`Failed to process tenant ${tenant.gymName}:`, err.message);
    }
  }

  console.log('\nBackfill completed successfully.');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
