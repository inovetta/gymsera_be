module.exports = {
  platform: {
    host: process.env.PLATFORM_DB_HOST || 'localhost',
    port: parseInt(process.env.PLATFORM_DB_PORT || '3306'),
    database: process.env.PLATFORM_DB_NAME || 'gymsera_platform',
    username: process.env.PLATFORM_DB_USER || 'gymsera',
    password: process.env.PLATFORM_DB_PASS !== undefined ? process.env.PLATFORM_DB_PASS : 'gymsera_pass',
  },
  // The MySQL server that hosts all per-tenant databases.
  // TenantProvisioningService uses admin credentials to CREATE DATABASE.
  // Individual tenant connections use the regular tenant user.
  tenantServer: {
    host: process.env.TENANT_DB_HOST || 'localhost',
    port: parseInt(process.env.TENANT_DB_PORT || '3307'),
    adminUser: process.env.TENANT_DB_ADMIN_USER || 'root',
    adminPass: process.env.TENANT_DB_ADMIN_PASS !== undefined ? process.env.TENANT_DB_ADMIN_PASS : 'rootpass',
    user: process.env.TENANT_DB_USER || 'gymsera_tenant',
    pass: process.env.TENANT_DB_PASS !== undefined ? process.env.TENANT_DB_PASS : 'tenant_pass',
  },
};
