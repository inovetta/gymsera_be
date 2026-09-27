/**
 * Database connection settings — passwords come ONLY from the environment.
 * There is deliberately no built-in password to fall back to: a missing
 * variable must stop the server at startup (assertDatabaseConfigured, called
 * by server.js and api/index.js), never silently try a default. An explicitly
 * empty value (e.g. `PLATFORM_DB_PASS=` for a local/CI MySQL with no root
 * password) counts as set. See spec §13 SEC-DB-FALLBACK.
 */
const REQUIRED_DATABASE_SETTINGS = ['PLATFORM_DB_PASS', 'TENANT_DB_ADMIN_PASS', 'TENANT_DB_PASS'];

/** The required database password variables that are not set at all in `env`. */
const missingDatabaseSettings = (env = process.env) => REQUIRED_DATABASE_SETTINGS.filter((key) => env[key] === undefined);

/**
 * Throws a clear error naming every missing database password variable. Run at
 * startup so a misconfigured server refuses to start instead of using a default.
 */
const assertDatabaseConfigured = (env = process.env) => {
  const missing = missingDatabaseSettings(env);
  if (missing.length > 0) {
    const err = new Error(
      `Database is not configured: missing ${missing.join(', ')}. Set them in the environment ` +
        '(there is no built-in fallback; an empty value is allowed only if the database really has no password). ' +
        'The server will not start without them.'
    );
    err.code = 'DATABASE_NOT_CONFIGURED';
    throw err;
  }
};

module.exports = {
  platform: {
    host: process.env.PLATFORM_DB_HOST || 'localhost',
    port: parseInt(process.env.PLATFORM_DB_PORT || '3306'),
    database: process.env.PLATFORM_DB_NAME || 'gymsera_platform',
    username: process.env.PLATFORM_DB_USER || 'gymsera',
    password: process.env.PLATFORM_DB_PASS,
  },
  // The MySQL server that hosts all per-tenant databases.
  // TenantProvisioningService uses admin credentials to CREATE DATABASE.
  // Individual tenant connections use the regular tenant user.
  tenantServer: {
    host: process.env.TENANT_DB_HOST || 'localhost',
    port: parseInt(process.env.TENANT_DB_PORT || '3306'),
    adminUser: process.env.TENANT_DB_ADMIN_USER || 'root',
    adminPass: process.env.TENANT_DB_ADMIN_PASS,
    user: process.env.TENANT_DB_USER || 'gymsera_tenant',
    pass: process.env.TENANT_DB_PASS,
  },
  REQUIRED_DATABASE_SETTINGS,
  missingDatabaseSettings,
  assertDatabaseConfigured,
};
