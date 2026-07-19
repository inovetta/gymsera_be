require('dotenv').config();
const { connect: initPlatformDb } = require('../src/database/platform');
const { GymListing, Tenant } = require('../src/models/platform');
const TenantDbManager = require('../src/database/TenantDbManager');

async function main() {
  console.log('Connecting to Platform DB...');
  await initPlatformDb();
  console.log('Connected.');

  console.log('\n=== TENANTS ===');
  const tenants = await Tenant.findAll();
  for (const t of tenants) {
    console.log(`Tenant: ID=${t.id}, Code=${t.tenantCode}, Name=${t.businessName}, Status=${t.status}`);
  }

  console.log('\n=== GYM LISTINGS ===');
  const listings = await GymListing.findAll();
  for (const gl of listings) {
    console.log(`Listing: ID=${gl.id}, Title="${gl.title}", TenantID=${gl.tenantId}, BranchID=${gl.branchId}, Status=${gl.status}, Featured=${gl.isFeatured}`);
  }

  console.log('\n=== TENANT DB BRANCHES ===');
  for (const t of tenants) {
    if (t.status !== 'ACTIVE') {
      console.log(`Skipping inactive tenant: ${t.tenantCode}`);
      continue;
    }
    if (!t.connectionStringEncrypted || t.connectionStringEncrypted === 'PENDING_PROVISIONING') {
      console.log(`Skipping tenant with pending database: ${t.tenantCode}`);
      continue;
    }
    try {
      const tenantDb = await TenantDbManager.getConnection(t.id, t.connectionStringEncrypted);
      const { Branch } = tenantDb.models;
      const branches = await Branch.findAll();
      console.log(`Tenant ${t.tenantCode} has ${branches.length} branches:`);
      for (const b of branches) {
        console.log(`  - Branch: ID=${b.id}, Name="${b.branchName}", Status=${b.status}, TravelerVisibility=${b.travelerVisibilityStatus}`);
      }
    } catch (err) {
      console.error(`  - Failed to connect to tenant DB for ${t.tenantCode}:`, err.message);
    }
  }

  process.exit(0);
}

main().catch(console.error);
