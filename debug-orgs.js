const path = require('path');
const backendPath = '/Users/powertech/Developer/Apps/InovettaTech/SaaS/gymsera_be/src';
const discoveryService = require(path.join(backendPath, 'services/discovery.service'));
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
  try {
    const result = await discoveryService.listOrganizations({ page: 1, limit: 12 });
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error during listOrganizations:', err);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
