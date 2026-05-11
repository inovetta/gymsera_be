/**
 * TenantProvisioningService
 *
 * Bull job processor for the `tenant-provisioning` queue.
 * Triggered when an admin approves a tenant.
 *
 * Job flow:
 *  1. Load tenant from platform DB
 *  2. Connect to tenant MySQL server with admin credentials
 *  3. CREATE DATABASE `gymsera_{tenantCode}`
 *  4. GRANT ALL PRIVILEGES on new DB to the app user
 *  5. Build + encrypt the connection string
 *  6. Sync tenant Sequelize models (create tables)
 *  7. Create GymListing record on platform DB
 *  8. Update Tenant: status=ACTIVE, dbName, connectionStringEncrypted
 *  9. Send tenant-approved email to the owner
 */
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

const { Tenant, User, City, GymListing } = require('../models/platform');
const { registerTenantModels } = require('../models/tenant');
const { encrypt } = require('../utils/crypto.utils');
const emailService = require('./email.service');
const { TenantStatus } = require('../constants/subscription-status');

// ── Env helpers ───────────────────────────────────────────────────────────────
const getTenantDbConfig = () => ({
  host: process.env.TENANT_DB_HOST || 'localhost',
  port: parseInt(process.env.TENANT_DB_PORT || '3306'),
  adminUser: process.env.TENANT_DB_ADMIN_USER || 'root',
  adminPassword: process.env.TENANT_DB_ADMIN_PASS || '',
  appUser: process.env.TENANT_DB_USER || 'gymsera_tenant',
  appPassword: process.env.TENANT_DB_PASS || 'tenant_pass',
});

/**
 * Sanitise a tenant code into a valid MySQL database name.
 * Format: gymsera_gym_XXXXXXXX  (lowercase, hyphens → underscores)
 */
const buildDbName = (tenantCode) => {
  const safe = tenantCode.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `gymsera_${safe}`;
};

// ── Main processor ────────────────────────────────────────────────────────────

/**
 * Provision a tenant database.
 * @param {import('bull').Job} job - Bull job with payload { tenantId }
 */
const processTenantProvisioning = async (job) => {
  const { tenantId } = job.data;

  console.log(`[Provisioning] Starting for tenant ${tenantId}`);

  // ── Step 1: Load tenant ───────────────────────────────────────────────────
  const tenant = await Tenant.findByPk(tenantId, {
    include: [{ model: User, as: 'owner', attributes: ['id', 'fullName', 'email'] }],
  });

  if (!tenant) throw new Error(`Tenant ${tenantId} not found in platform DB`);

  if (tenant.status === TenantStatus.ACTIVE && tenant.connectionStringEncrypted) {
    console.log(`[Provisioning] Tenant ${tenantId} is already ACTIVE — skipping`);
    return;
  }

  const dbConfig = getTenantDbConfig();
  const dbName = buildDbName(tenant.tenantCode);

  // ── Step 2 & 3: Create DB via admin connection ────────────────────────────
  const adminConn = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.adminUser,
    password: dbConfig.adminPassword,
  });

  try {
    // CREATE DATABASE is not injectable via parameterised queries in mysql2;
    // the name has been sanitised to [a-z0-9_] only above.
    await adminConn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`[Provisioning] Database '${dbName}' created`);

    // ── Step 4: Grant app user access ──────────────────────────────────────
    await adminConn.execute(
      `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbConfig.appUser}'@'%'`
    );
    await adminConn.execute('FLUSH PRIVILEGES');
    console.log(`[Provisioning] Granted privileges to '${dbConfig.appUser}'`);
  } finally {
    await adminConn.end();
  }

  // ── Step 5: Build + encrypt connection string ─────────────────────────────
  const connUrl = `mysql://${dbConfig.appUser}:${dbConfig.appPassword}@${dbConfig.host}:${dbConfig.port}/${dbName}`;
  const connectionStringEncrypted = encrypt(connUrl);

  // ── Step 6: Sync tenant models ────────────────────────────────────────────
  const tenantSequelize = new Sequelize(connUrl, {
    dialect: 'mysql',
    logging: false,
    pool: { max: 3, min: 0, acquire: 30000, idle: 10000 },
  });

  try {
    await tenantSequelize.authenticate();
    const models = registerTenantModels(tenantSequelize);
    await tenantSequelize.sync({ force: false, alter: false });
    console.log(`[Provisioning] Tenant models synced to '${dbName}'`);
  } finally {
    await tenantSequelize.close();
  }

  // ── Step 7: Create GymListing on platform DB ──────────────────────────────
  const existingListing = await GymListing.findOne({ where: { tenantId: tenant.id } });

  if (!existingListing && tenant.gymName) {
    await GymListing.create({
      tenantId: tenant.id,
      cityId: tenant.cityId,
      areaId: null,
      title: tenant.gymName,
      shortDescription: tenant.gymDescription || null,
      logoUrl: tenant.logoUrl || null,
      coverImageUrl: tenant.coverImageUrl || null,
      genderType: tenant.genderType || null,
      contactPhone: tenant.phone || null,
      status: 'ACTIVE',
    });
    console.log(`[Provisioning] GymListing created for tenant ${tenantId}`);
  }

  // ── Step 8: Update tenant record ─────────────────────────────────────────
  await tenant.update({
    status: TenantStatus.ACTIVE,
    dbName,
    connectionStringEncrypted,
  });
  console.log(`[Provisioning] Tenant ${tenantId} status set to ACTIVE`);

  // ── Step 9: Send approval email ───────────────────────────────────────────
  if (tenant.owner) {
    await emailService.sendTenantApprovedEmail(
      tenant.owner.email,
      tenant.owner.fullName,
      tenant.businessName
    );
  }

  console.log(`[Provisioning] ✅ Tenant ${tenantId} fully provisioned`);
};

module.exports = { processTenantProvisioning };
