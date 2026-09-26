/**
 * Test Database Harness for GymsEra Backend
 *
 * Enforces Safety Rule R-19 (spec §14):
 * - Automated test suites run ONLY against local/Docker MySQL test databases.
 * - Platform test database: gymsera_test_platform
 * - Tenant 1 test database: gymsera_test_tenant_1
 * - Tenant 2 test database: gymsera_test_tenant_2
 * - NEVER points at production or shared databases.
 */
require('dotenv').config();

const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');
const { encrypt } = require('../../src/utils/crypto.utils');
const registerTenantModels = require('../../src/models/tenant');
const { runTenantMigrations } = require('../../src/database/tenant-migration-runner');

// Force test environment
process.env.NODE_ENV = 'test';
process.env.PLATFORM_DB_NAME = process.env.PLATFORM_TEST_DB_NAME || 'gymsera_test_platform';

const PLATFORM_TEST_DB = process.env.PLATFORM_DB_NAME;
const TENANT_1_TEST_DB = 'gymsera_test_tenant_1';
const TENANT_2_TEST_DB = 'gymsera_test_tenant_2';

const dbHost = process.env.PLATFORM_DB_HOST || 'localhost';
const dbPort = parseInt(process.env.PLATFORM_DB_PORT || '3306');
const dbUser = process.env.PLATFORM_DB_USER || 'root';
const dbPass = process.env.PLATFORM_DB_PASS !== undefined ? process.env.PLATFORM_DB_PASS : '';

const tenantHost = process.env.TENANT_DB_HOST || 'localhost';
const tenantPort = parseInt(process.env.TENANT_DB_PORT || '3306');
const tenantUser = process.env.TENANT_DB_USER || 'root';
const tenantPass = process.env.TENANT_DB_PASS !== undefined ? process.env.TENANT_DB_PASS : '';

let adminConnection = null;
let tenant1Sequelize = null;
let tenant2Sequelize = null;

/**
 * Connect to MySQL server as admin to manage test databases.
 */
async function getAdminConnection() {
  if (!adminConnection) {
    adminConnection = await mysql.createConnection({
      host: dbHost,
      port: dbPort,
      user: dbUser,
      password: dbPass,
      multipleStatements: true,
    });
  }
  return adminConnection;
}

const ALLOWED_TEST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'mysql']);

/**
 * Strict safety guard for test execution (spec §14 Rule R-19).
 * Refuses to start test setup unless:
 * 1. NODE_ENV === 'test'
 * 2. Host is localhost, 127.0.0.1, ::1, or the CI service container ('mysql')
 * 3. Every targeted database name starts with 'gymsera_test_'
 */
function assertTestEnvironmentSafety(overrides = {}) {
  const nodeEnv = overrides.nodeEnv !== undefined ? overrides.nodeEnv : process.env.NODE_ENV;
  if (nodeEnv !== 'test') {
    throw new Error(
      `[Test Safety Guard] Refusing to start test setup: NODE_ENV must be 'test' (received '${nodeEnv}'). Safety Rule R-19.`
    );
  }

  const hosts = overrides.hosts || [
    process.env.PLATFORM_DB_HOST || 'localhost',
    process.env.TENANT_DB_HOST || 'localhost',
  ];

  for (const host of hosts) {
    const normalizedHost = String(host || '').toLowerCase().trim();
    if (!normalizedHost || !ALLOWED_TEST_HOSTS.has(normalizedHost)) {
      throw new Error(
        `[Test Safety Guard] Refusing to start test setup: host '${host}' is not localhost or CI container (allowed: ${Array.from(ALLOWED_TEST_HOSTS).join(', ')}). Safety Rule R-19.`
      );
    }
  }

  const databases = overrides.databases || [
    process.env.PLATFORM_DB_NAME || PLATFORM_TEST_DB,
    TENANT_1_TEST_DB,
    TENANT_2_TEST_DB,
  ];

  for (const db of databases) {
    const dbName = String(db || '').trim();
    if (!dbName.startsWith('gymsera_test_')) {
      throw new Error(
        `[Test Safety Guard] Refusing to start test setup: database '${db}' does not start with 'gymsera_test_'. Safety Rule R-19.`
      );
    }
  }
}

/**
 * Creates the isolated test databases if they don't already exist.
 */
async function createTestDatabases() {
  assertTestEnvironmentSafety();

  const conn = await getAdminConnection();

  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${PLATFORM_TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${TENANT_1_TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${TENANT_2_TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);

  try {
    await conn.query(`GRANT ALL PRIVILEGES ON \`gymsera_test_%\`.* TO 'gymsera_tenant'@'%'; FLUSH PRIVILEGES;`);
  } catch (_) {
    // Non-fatal if gymsera_tenant user does not exist or running without grant perms
  }
}

/**
 * Initializes platform and tenant test databases schemas.
 */
async function setupTestDatabases() {
  await createTestDatabases();

  // Initialize Platform models
  const { sequelize: platformSequelize, connect: connectPlatform } = require('../../src/database/platform');
  await platformSequelize.sync({ force: true });
  await connectPlatform();

  const { City } = require('../../src/models/platform');
  await City.findOrCreate({
    where: { id: 1 },
    defaults: { id: 1, name: 'Karachi', isActive: true },
  });

  // Initialize Tenant 1
  const t1Url = `mysql://${tenantUser}:${tenantPass}@${tenantHost}:${tenantPort}/${TENANT_1_TEST_DB}`;
  tenant1Sequelize = new Sequelize(t1Url, {
    dialect: 'mysql',
    logging: false,
    pool: { max: 5, min: 0, acquire: 20000, idle: 10000 },
    define: { underscored: true, timestamps: true },
  });
  await tenant1Sequelize.authenticate();
  const tenant1Models = registerTenantModels(tenant1Sequelize);
  await tenant1Sequelize.sync({ force: true });
  await runTenantMigrations(tenant1Sequelize, { tenantId: 'test-tenant-1' });

  // Initialize Tenant 2
  const t2Url = `mysql://${tenantUser}:${tenantPass}@${tenantHost}:${tenantPort}/${TENANT_2_TEST_DB}`;
  tenant2Sequelize = new Sequelize(t2Url, {
    dialect: 'mysql',
    logging: false,
    pool: { max: 5, min: 0, acquire: 20000, idle: 10000 },
    define: { underscored: true, timestamps: true },
  });
  await tenant2Sequelize.authenticate();
  const tenant2Models = registerTenantModels(tenant2Sequelize);
  await tenant2Sequelize.sync({ force: true });
  await runTenantMigrations(tenant2Sequelize, { tenantId: 'test-tenant-2' });

  return {
    platform: {
      sequelize: platformSequelize,
      database: PLATFORM_TEST_DB,
    },
    tenant1: {
      sequelize: tenant1Sequelize,
      models: tenant1Models,
      database: TENANT_1_TEST_DB,
      connUrl: t1Url,
      encryptedConnStr: encrypt(t1Url),
    },
    tenant2: {
      sequelize: tenant2Sequelize,
      models: tenant2Models,
      database: TENANT_2_TEST_DB,
      connUrl: t2Url,
      encryptedConnStr: encrypt(t2Url),
    },
  };
}

/**
 * Resets (cleans) table data between tests while keeping schemas intact.
 */
async function resetTestDatabases() {
  const { sequelize: platformSequelize } = require('../../src/database/platform');
  
  if (platformSequelize) {
    await platformSequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    const [tables] = await platformSequelize.query('SHOW TABLES');
    for (const row of tables) {
      const tableName = Object.values(row)[0];
      await platformSequelize.query(`TRUNCATE TABLE \`${tableName}\``).catch(() => {});
    }
    await platformSequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  for (const seq of [tenant1Sequelize, tenant2Sequelize]) {
    if (seq) {
      await seq.query('SET FOREIGN_KEY_CHECKS = 0');
      const [tables] = await seq.query('SHOW TABLES');
      for (const row of tables) {
        const tableName = Object.values(row)[0];
        await seq.query(`TRUNCATE TABLE \`${tableName}\``).catch(() => {});
      }
      await seq.query('SET FOREIGN_KEY_CHECKS = 1');
    }
  }

  // Clear TenantDbManager cache
  const TenantDbManager = require('../../src/database/TenantDbManager');
  TenantDbManager.pool.clear();
}

/**
 * Closes all connections.
 */
async function teardownTestDatabases() {
  const { sequelize: platformSequelize } = require('../../src/database/platform');
  if (platformSequelize) {
    await platformSequelize.close().catch(() => {});
  }
  if (tenant1Sequelize) {
    await tenant1Sequelize.close().catch(() => {});
  }
  if (tenant2Sequelize) {
    await tenant2Sequelize.close().catch(() => {});
  }
  if (adminConnection) {
    await adminConnection.end().catch(() => {});
    adminConnection = null;
  }
}

module.exports = {
  PLATFORM_TEST_DB,
  TENANT_1_TEST_DB,
  TENANT_2_TEST_DB,
  ALLOWED_TEST_HOSTS,
  assertTestEnvironmentSafety,
  getAdminConnection,
  createTestDatabases,
  setupTestDatabases,
  resetTestDatabases,
  teardownTestDatabases,
};
