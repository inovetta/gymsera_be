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

// No test may ever reach a real Apple / Google / Stripe account (spec §14
// R-19). Blank every provider credential a local .env may hold, so a call
// that slips past the fakes in tests/harness/billing-fakes.js fails with
// "not configured" instead of going out over the network. Set to '' rather
// than deleted: a later dotenv.config() never overrides a key that exists.
for (const key of [
  'APPLE_IAP_KEY_ID',
  'APPLE_IAP_ISSUER_ID',
  'APPLE_IAP_BUNDLE_ID',
  'APPLE_IAP_PRIVATE_KEY_PATH',
  'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
]) {
  process.env[key] = '';
}

// Tests never use the real mailbox: fixed fake SMTP settings (an `.invalid`
// host that can never resolve), so e-mail code paths behave the same locally
// and in CI. Messages are captured by tests/harness/mail-fake.js; anything
// that escapes is stopped by the network jail (tests/harness/no-network.js).
Object.assign(process.env, {
  SMTP_HOST: 'smtp.gymsera-test.invalid',
  SMTP_PORT: '587',
  SMTP_USER: 'noreply@gymsera.test',
  SMTP_PASS: 'test-only-not-a-real-password',
  SMTP_FROM: 'GymsEra Test <noreply@gymsera.test>',
});
process.env.PLATFORM_DB_NAME = process.env.PLATFORM_TEST_DB_NAME || 'gymsera_test_platform';

// Test MySQL 5.7 port resolution (Safety Rule R-19):
// CI service container runs on 3306.
// Local test harness defaults to 3308 (Docker MySQL 5.7 container) unless overridden.
const testPort = String(
  process.env.TEST_MYSQL_PORT ||
  process.env.PLATFORM_TEST_DB_PORT ||
  (process.env.CI ? (process.env.MYSQL_PORT || '3306') : (process.env.PLATFORM_DB_PORT === '3306' ? '3308' : (process.env.PLATFORM_DB_PORT || '3308')))
);
process.env.PLATFORM_DB_PORT = testPort;
process.env.TENANT_DB_PORT = testPort;

const PLATFORM_TEST_DB = process.env.PLATFORM_DB_NAME;
const TENANT_1_TEST_DB = 'gymsera_test_tenant_1';
const TENANT_2_TEST_DB = 'gymsera_test_tenant_2';

const dbHost = process.env.PLATFORM_TEST_DB_HOST || process.env.PLATFORM_DB_HOST || process.env.MYSQL_HOST || 'localhost';
const dbPort = parseInt(testPort);
const dbUser = process.env.PLATFORM_TEST_DB_USER || process.env.PLATFORM_DB_USER || process.env.MYSQL_USER || 'root';
const dbPass = process.env.PLATFORM_TEST_DB_PASS !== undefined ? process.env.PLATFORM_TEST_DB_PASS : (process.env.PLATFORM_DB_PASS !== undefined ? process.env.PLATFORM_DB_PASS : '');

const tenantHost = process.env.TENANT_TEST_DB_HOST || process.env.TENANT_DB_HOST || process.env.MYSQL_HOST || 'localhost';
const tenantPort = parseInt(testPort);
const tenantUser = process.env.TENANT_TEST_DB_USER || process.env.TENANT_DB_USER || process.env.MYSQL_USER || 'root';
const tenantPass = process.env.TENANT_TEST_DB_PASS !== undefined ? process.env.TENANT_TEST_DB_PASS : (process.env.TENANT_DB_PASS !== undefined ? process.env.TENANT_DB_PASS : '');

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
    define: {
      underscored: true,
      timestamps: true,
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
    },
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
    define: {
      underscored: true,
      timestamps: true,
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
    },
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

/**
 * Test fixture helper (spec §14, Task Step 2.10):
 * Creates a tenant test database with mixed collations matching production:
 * - `branches`: utf8mb4_unicode_ci (or column id utf8mb4_unicode_ci)
 * - `payments`: utf8mb4_general_ci (or column branch_id utf8mb4_general_ci)
 * - seeds branches and payments with business_date = NULL
 * - schema_migrations records versions 1..3 applied (so Migration 004 is next)
 */
async function createMixedCollationTenantDb(customDbName = 'gymsera_test_mixed_collate') {
  assertTestEnvironmentSafety({ databases: [customDbName] });

  const conn = await getAdminConnection();
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${customDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);

  try {
    await conn.query(`GRANT ALL PRIVILEGES ON \`${customDbName}\`.* TO 'gymsera_tenant'@'%' IDENTIFIED BY 'tenant_pass'; FLUSH PRIVILEGES;`);
  } catch (_) {}

  const connUrl = `mysql://${tenantUser}:${tenantPass}@${tenantHost}:${tenantPort}/${customDbName}`;
  const seq = new Sequelize(connUrl, {
    dialect: 'mysql',
    logging: false,
    pool: { max: 5, min: 0, acquire: 20000, idle: 10000 },
    define: { underscored: true, timestamps: true },
  });

  await seq.authenticate();

  await seq.query('SET FOREIGN_KEY_CHECKS = 0');
  await seq.query('DROP TABLE IF EXISTS schema_migrations');
  await seq.query('DROP TABLE IF EXISTS payments');
  await seq.query('DROP TABLE IF EXISTS ledger_days');
  await seq.query('DROP TABLE IF EXISTS branches');
  await seq.query('DROP TABLE IF EXISTS gyms');

  // branches table with utf8mb4_unicode_ci
  await seq.query(`
    CREATE TABLE \`branches\` (
      \`id\` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
      \`gym_id\` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      \`gym_listing_id\` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      \`branch_name\` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
      \`timezone\` VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Asia/Karachi',
      \`status\` VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
      \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // payments table with branch_id in utf8mb4_general_ci
  await seq.query(`
    CREATE TABLE \`payments\` (
      \`id\` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
      \`branch_id\` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
      \`member_id\` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
      \`subscription_id\` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
      \`invoice_id\` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
      \`amount\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      \`currency\` VARCHAR(10) NOT NULL DEFAULT 'PKR',
      \`method\` VARCHAR(50) NOT NULL DEFAULT 'CASH',
      \`status\` VARCHAR(50) NOT NULL DEFAULT 'COMPLETED',
      \`business_date\` DATE NULL,
      \`collected_at\` DATETIME NULL,
      \`paid_at\` DATETIME NULL,
      \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
  `);

  // ledger_days table with branch_id in utf8mb4_general_ci
  await seq.query(`
    CREATE TABLE \`ledger_days\` (
      \`id\` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
      \`branch_id\` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
      \`business_date\` DATE NOT NULL,
      \`status\` VARCHAR(20) NOT NULL DEFAULT 'OPEN',
      \`opened_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`closed_by\` VARCHAR(36) NULL,
      \`closed_at\` DATETIME NULL,
      \`closed_expected_total\` DECIMAL(10,2) NULL,
      \`closed_verified_total\` DECIMAL(10,2) NULL,
      \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
  `);

  // schema_migrations with versions 1, 2, 3 applied
  await seq.query(`
    CREATE TABLE \`schema_migrations\` (
      \`version\` INT NOT NULL PRIMARY KEY,
      \`name\` VARCHAR(255) NOT NULL,
      \`applied_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await seq.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, '001_ensure_rbac_tables', NOW()), (2, '002_ensure_ledger_tables', NOW()), (3, '003_audit_and_tracking_columns', NOW())");

  // Seed sample branch, payments, and ledger_days with NULL business_date
  await seq.query(`
    INSERT INTO \`branches\` (\`id\`, \`branch_name\`, \`timezone\`)
    VALUES ('branch-karachi-001', 'Karachi Central', 'Asia/Karachi')
  `);

  await seq.query(`
    INSERT INTO \`payments\` (\`id\`, \`branch_id\`, \`method\`, \`amount\`, \`created_at\`, \`paid_at\`, \`collected_at\`, \`business_date\`)
    VALUES 
      ('pmt-cash-001', 'branch-karachi-001', 'CASH', 5000.00, '2026-03-15 14:00:00', '2026-03-15 14:00:00', NULL, NULL),
      ('pmt-bank-002', 'branch-karachi-001', 'BANK_TRANSFER', 8000.00, '2026-03-16 10:00:00', '2026-03-17 11:00:00', NULL, NULL)
  `);

  await seq.query(`
    INSERT INTO \`ledger_days\` (\`id\`, \`branch_id\`, \`business_date\`, \`status\`)
    VALUES ('ld-001', 'branch-karachi-001', '2026-03-15', 'OPEN')
  `);

  await seq.query('SET FOREIGN_KEY_CHECKS = 1');

  return {
    sequelize: seq,
    dbName: customDbName,
    connUrl,
    encryptedConnStr: encrypt(connUrl),
    cleanup: async () => {
      await seq.close().catch(() => {});
    },
  };
}

module.exports = {
  PLATFORM_TEST_DB,
  TENANT_1_TEST_DB,
  TENANT_2_TEST_DB,
  ALLOWED_TEST_HOSTS,
  assertTestEnvironmentSafety,
  getAdminConnection,
  createTestDatabases,
  createMixedCollationTenantDb,
  setupTestDatabases,
  resetTestDatabases,
  teardownTestDatabases,
};
