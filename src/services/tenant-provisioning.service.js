/**
 * TenantProvisioningService
 *
 * Called synchronously from admin.service.js when an admin approves a tenant.
 * Runs inline in the request so it works the same on serverless (Vercel) and
 * on a traditional always-on server — no background worker required.
 *
 * Flow:
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

const { Tenant, User, City, GymListing, TenantSubscription, PlatformPackage } = require('../models/platform');
const registerTenantModels = require('../models/tenant');
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
 * @param {string} tenantId
 */
const processTenantProvisioning = async (tenantId) => {

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
    connectTimeout: 20000,
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

  // ── Step 7: Create GymListing on platform DB (moved up) ────────────────────
  let listingId = null;
  const existingListing = await GymListing.findOne({ where: { tenantId: tenant.id } });

  if (!existingListing && tenant.gymName) {
    const listing = await GymListing.create({
      tenantId: tenant.id,
      cityId: tenant.cityId,
      areaId: null,
      title: tenant.gymName,
      shortDescription: tenant.gymDescription || null,
      logoUrl: tenant.logoUrl || null,
      coverImageUrl: tenant.coverImageUrl || null,
      genderType: tenant.genderType || null,
      contactPhone: tenant.phone || null,
      latitude: tenant.latitude || null,
      longitude: tenant.longitude || null,
      status: 'ACTIVE',
    });
    listingId = listing.id;
    console.log(`[Provisioning] GymListing created for tenant ${tenantId}`);
  } else if (existingListing) {
    listingId = existingListing.id;
  }

  // ── Step 6: Sync tenant models ────────────────────────────────────────────
  const tenantSequelize = new Sequelize(connUrl, {
    dialect: 'mysql',
    logging: false,
    pool: { max: 3, min: 0, acquire: 30000, idle: 10000 },
    dialectOptions: { connectTimeout: 20000 },
  });

  let gymId = null;

  try {
    await tenantSequelize.authenticate();
    const models = registerTenantModels(tenantSequelize);
    await tenantSequelize.sync({ force: false, alter: false });
    console.log(`[Provisioning] Tenant models synced to '${dbName}'`);

    // ── Step 6b: Create Gym record in tenant DB ────────────────────────────
    if (tenant.gymName) {
      const gym = await models.Gym.create({
        name: tenant.gymName,
        description: tenant.gymDescription || null,
        contactPhone: tenant.phone || null,
        genderType: tenant.genderType || 'MIXED',
        logoUrl: tenant.logoUrl || null,
        coverImageUrl: tenant.coverImageUrl || null,
        gymListingId: listingId,
      });
      gymId = gym.id;
      console.log(`[Provisioning] Gym record created in '${dbName}' (id: ${gymId})`);

      // ── Step 6c: Create initial Branch from onboarding data ────────────
      if (tenant.mainBranchDataJson) {
        const b = tenant.mainBranchDataJson;
        await models.Branch.create({
          gymId,
          branchName: b.name || tenant.gymName,
          address: b.address || tenant.address || null,
          cityId: b.cityId || tenant.cityId || null,
          latitude: b.latitude != null ? b.latitude : null,
          longitude: b.longitude != null ? b.longitude : null,
          phone: b.phone || null,
          openingTime: b.openingTime || null,
          closingTime: b.closingTime || null,
          status: 'ACTIVE',
        });
        console.log(`[Provisioning] Initial Branch created in '${dbName}'`);
      }
    }
  } finally {
    await tenantSequelize.close();
  }

  // ── Step 8: Update tenant record ─────────────────────────────────────────
  await tenant.update({
    status: TenantStatus.ACTIVE,
    dbName,
    connectionStringEncrypted,
  });
  console.log(`[Provisioning] Tenant ${tenantId} status set to ACTIVE`);

  // ── Step 8b: Create subscription from selectedPackageId (if not already done) ─
  if (tenant.selectedPackageId) {
    const existingActiveSub = await TenantSubscription.findOne({
      where: { tenantId: tenant.id },
    });

    if (!existingActiveSub) {
      const pkg = await PlatformPackage.findByPk(tenant.selectedPackageId);
      if (pkg) {
        const cycle = pkg.billingCycle || 'MONTHLY';
        const start = new Date();
        const end = new Date(start);
        if (cycle === 'MONTHLY') end.setMonth(end.getMonth() + 1);
        else if (cycle === 'QUARTERLY') end.setMonth(end.getMonth() + 3);
        else if (cycle === 'YEARLY') end.setFullYear(end.getFullYear() + 1);

        await TenantSubscription.create({
          tenantId: tenant.id,
          platformPackageId: pkg.id,
          startDate: start.toISOString().split('T')[0],
          endDate: end.toISOString().split('T')[0],
          amount: pkg.price,
          billingCycle: cycle,
          status: 'ACTIVE',
          autoRenew: true,
          paymentStatus: 'PENDING',
        });
        console.log(`[Provisioning] Subscription auto-created for tenant ${tenantId} (package: ${pkg.name})`);
      }
    }
  }

  // ── Step 9: Send approval email ───────────────────────────────────────────
  // Provisioning above already succeeded and the tenant is ACTIVE — a broken
  // SMTP config must not surface as a "provisioning failed" error, since the
  // tenant can no longer be re-approved to retry it (status is now ACTIVE).
  if (tenant.owner) {
    try {
      await emailService.sendTenantApprovedEmail(
        tenant.owner.email,
        tenant.owner.fullName,
        tenant.businessName
      );
    } catch (err) {
      console.error(`[Provisioning] Failed to send approval email for tenant ${tenantId}:`, err.message);
    }
  }

  try {
    const notificationsService = require('./notifications.service');
    if (tenant.ownerUserId) {
      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'host_update',
        title: 'Host Application Approved',
        message: `Your organization ${tenant.gymName || tenant.businessName} has been approved.`,
        deepLink: '/host/profile',
        metadataJson: { tenantId: tenant.id }
      });
    }
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create approval notification:', notifErr.message);
  }

  console.log(`[Provisioning] ✅ Tenant ${tenantId} fully provisioned`);
};

module.exports = { processTenantProvisioning };
