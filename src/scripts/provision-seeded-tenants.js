/**
 * provision-seeded-tenants.js
 *
 * One-off script to provision tenant databases for IRONPEAK and VITALITYFIT
 * (the seeder creates them with connectionStringEncrypted = 'PENDING_PROVISIONING').
 *
 * Run with:   node src/scripts/provision-seeded-tenants.js
 */
require('dotenv').config();
const mysql     = require('mysql2/promise');
const { Sequelize } = require('sequelize');

const { connect: initPlatformDb } = require('../database/platform');
const { Tenant }         = require('../models/platform');
const registerTenantModels = require('../models/tenant');
const { encrypt }        = require('../utils/crypto.utils');

const getTenantDbConfig = () => ({
  host:          process.env.TENANT_DB_HOST       || 'localhost',
  port:          parseInt(process.env.TENANT_DB_PORT || '3306'),
  adminUser:     process.env.TENANT_DB_ADMIN_USER  || 'root',
  adminPassword: process.env.TENANT_DB_ADMIN_PASS  || '',
  appUser:       process.env.TENANT_DB_USER        || 'gymsera_tenant',
  appPassword:   process.env.TENANT_DB_PASS        || 'tenant_pass',
});

const buildDbName = (tenantCode) => {
  const safe = tenantCode.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `gymsera_${safe}`;
};

async function provisionTenant(tenant, dbConfig) {
  const dbName  = buildDbName(tenant.tenantCode);
  const connUrl = `mysql://${dbConfig.appUser}:${dbConfig.appPassword}@${dbConfig.host}:${dbConfig.port}/${dbName}`;

  console.log(`\n🔧 Provisioning '${tenant.tenantCode}' → DB: ${dbName}`);

  // Create DB + grant access
  const adminConn = await mysql.createConnection({
    host:     dbConfig.host,
    port:     dbConfig.port,
    user:     dbConfig.adminUser,
    password: dbConfig.adminPassword,
  });

  try {
    await adminConn.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`   ✅ Database '${dbName}' created (or already exists)`);

    // Create the app user if it doesn't exist yet (idempotent on staging servers
    // where the user may not have been pre-created).
    await adminConn.execute(
      `CREATE USER IF NOT EXISTS '${dbConfig.appUser}'@'%' IDENTIFIED BY '${dbConfig.appPassword}'`
    );
    console.log(`   ✅ User '${dbConfig.appUser}' ensured`);

    await adminConn.execute(
      `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbConfig.appUser}'@'%'`
    );
    await adminConn.execute('FLUSH PRIVILEGES');
    console.log(`   ✅ Privileges granted to '${dbConfig.appUser}'`);
  } finally {
    await adminConn.end();
  }

  // Sync tenant models
  const tenantSeq = new Sequelize(connUrl, {
    dialect: 'mysql',
    logging:  false,
    pool: { max: 3, min: 0, acquire: 30000, idle: 10000 },
  });

  try {
    await tenantSeq.authenticate();
    registerTenantModels(tenantSeq);
    await tenantSeq.sync({ force: false, alter: true });
    console.log(`   ✅ Tenant schema synced`);
  } finally {
    await tenantSeq.close();
  }

  // Update platform DB record
  const encryptedConnStr = encrypt(connUrl);
  await tenant.update({
    dbName,
    connectionStringEncrypted: encryptedConnStr,
  });
  console.log(`   ✅ Tenant record updated with encrypted connection string`);
}

async function main() {
  console.log('🚀 Provisioning seeded tenant databases...\n');

  await initPlatformDb();

  const tenants = await Tenant.findAll({
    where: { connectionStringEncrypted: 'PENDING_PROVISIONING' },
  });

  if (tenants.length === 0) {
    console.log('ℹ️  No tenants with PENDING_PROVISIONING found — nothing to do.');
    process.exit(0);
  }

  console.log(`Found ${tenants.length} tenant(s) to provision: ${tenants.map(t => t.tenantCode).join(', ')}`);

  const dbConfig = getTenantDbConfig();

  for (const tenant of tenants) {
    await provisionTenant(tenant, dbConfig);
  }

  console.log('\n🎉 All tenants provisioned successfully!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Provisioning failed:', err);
  process.exit(1);
});
