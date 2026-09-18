const TenantDbManager = require('../database/TenantDbManager');
const { Tenant } = require('../models/platform');
const subscriptionQuotaService = require('../services/subscription-quota.service');

const audit = async () => {
  console.log('--- Starting Branch Limit Audit ---');
  try {
    const tenants = await Tenant.findAll();
    console.log(`Found ${tenants.length} tenants in platform database.`);

    let overLimitCount = 0;

    for (const tenant of tenants) {
      if (tenant.status !== 'ACTIVE' || !tenant.connectionStringEncrypted) {
        continue;
      }

      // 1. Get max branches limit
      const activeSub = await subscriptionQuotaService.getActiveSubscription(tenant.id);
      const maxBranches = await subscriptionQuotaService.resolveMaxBranches(tenant, activeSub);

      // 2. Connect to tenant DB & count active branches
      let usedBranches = 0;
      try {
        const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        usedBranches = await tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } });
      } catch (err) {
        console.error(`[Error] Failed to connect to database for tenant ${tenant.name || tenant.id}: ${err.message}`);
        continue;
      }

      // 3. Check if over limit
      if (usedBranches > maxBranches) {
        overLimitCount++;
        console.log(`[VIOLATION] Tenant: ${tenant.name || 'Unnamed'} (ID: ${tenant.id})`);
        console.log(`  - Subscribed Max Limit: ${maxBranches}`);
        console.log(`  - Actual Active Branches: ${usedBranches}`);
        console.log(`  - Excess Branches: ${usedBranches - maxBranches}`);
      }
    }

    console.log('-----------------------------------');
    console.log(`Audit complete. Found ${overLimitCount} tenants over their branch limit.`);
  } catch (err) {
    console.error('Audit failed:', err);
  } finally {
    process.exit(0);
  }
};

audit();
