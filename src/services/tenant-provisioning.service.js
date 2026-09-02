/**
 * TenantProvisioningService
 *
 * Called synchronously from admin.service.js when an admin approves a tenant.
 * Runs inline in the request so it works the same on serverless (Vercel) and
 * on a traditional always-on server — no background worker required.
 *
 * Flow:
 *  1. Load tenant from platform DB
 *  2. Connect to tenant MySQL server with admin credentials (with multi-host and credential fallback)
 *  3. CREATE DATABASE `gymsera_{tenantCode}`
 *  4. Configure user privileges (with graceful error catching)
 *  5. Build + encrypt the connection string
 *  6. Sync tenant Sequelize models (with auto-fallback to admin credentials if appUser fails)
 *  7. Create or activate GymListing record on platform DB (cross-DB linking)
 *  8. Create Gym & initial Branch records in tenant DB
 *  9. Update Tenant: status=ACTIVE, dbName, connectionStringEncrypted
 *  10. Prime Redis connection string cache
 *  11. Auto-create tenant subscription for selected package
 *  12. Send tenant-approved email and push notification to the owner
 */
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

const { Tenant, User, City, Area, GymListing, TenantSubscription, PlatformPackage } = require('../models/platform');
const registerTenantModels = require('../models/tenant');
const { encrypt } = require('../utils/crypto.utils');
const emailService = require('./email.service');
const { safeRedisSetex } = require('../config/redis.config');
const { TenantStatus } = require('../constants/subscription-status');

// ── Env helpers ───────────────────────────────────────────────────────────────
const getTenantDbConfig = () => {
  const host = process.env.TENANT_DB_HOST || process.env.PLATFORM_DB_HOST || '127.0.0.1';
  const port = parseInt(process.env.TENANT_DB_PORT || process.env.PLATFORM_DB_PORT || '3306');
  const adminUser = process.env.TENANT_DB_ADMIN_USER || process.env.PLATFORM_DB_USER || 'root';
  const adminPassword = (process.env.TENANT_DB_ADMIN_PASS !== undefined && process.env.TENANT_DB_ADMIN_PASS !== '')
    ? process.env.TENANT_DB_ADMIN_PASS
    : (process.env.PLATFORM_DB_PASS !== undefined ? process.env.PLATFORM_DB_PASS : '');
  const appUser = process.env.TENANT_DB_USER || process.env.PLATFORM_DB_USER || adminUser;
  const appPassword = (process.env.TENANT_DB_PASS !== undefined && process.env.TENANT_DB_PASS !== '')
    ? process.env.TENANT_DB_PASS
    : (process.env.PLATFORM_DB_PASS !== undefined ? process.env.PLATFORM_DB_PASS : adminPassword);

  return { host, port, adminUser, adminPassword, appUser, appPassword };
};

/**
 * Sanitise a tenant code into a valid MySQL database name.
 * Format: gymsera_gym_XXXXXXXX  (lowercase, hyphens → underscores)
 */
const buildDbName = (tenantCode) => {
  const safe = tenantCode.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `gymsera_${safe}`;
};

/**
 * Helper to safely connect to MySQL with fallback hosts (127.0.0.1 <-> localhost)
 * and fallback credentials (admin credentials <-> platform credentials).
 */
const createSafeAdminConnection = async (dbConfig) => {
  const hostsToTry = [dbConfig.host];
  if (dbConfig.host === 'localhost') hostsToTry.push('127.0.0.1');
  else if (dbConfig.host === '127.0.0.1') hostsToTry.push('localhost');

  const credentialPairs = [
    { user: dbConfig.adminUser, password: dbConfig.adminPassword },
  ];

  if (process.env.PLATFORM_DB_USER && (process.env.PLATFORM_DB_USER !== dbConfig.adminUser || process.env.PLATFORM_DB_PASS !== dbConfig.adminPassword)) {
    credentialPairs.push({
      user: process.env.PLATFORM_DB_USER,
      password: process.env.PLATFORM_DB_PASS || '',
    });
  }

  // Also try root with empty password as a fallback
  if (dbConfig.adminUser !== 'root' || dbConfig.adminPassword !== '') {
    credentialPairs.push({ user: 'root', password: '' });
  }

  let lastError;
  for (const cred of credentialPairs) {
    for (const host of hostsToTry) {
      try {
        const conn = await mysql.createConnection({
          host,
          port: dbConfig.port,
          user: cred.user,
          password: cred.password,
          connectTimeout: 10000,
        });
        // Success: update dbConfig with working parameters
        dbConfig.host = host;
        dbConfig.adminUser = cred.user;
        dbConfig.adminPassword = cred.password;
        console.log(`[Provisioning] Connected to MySQL as '${cred.user}' on ${host}:${dbConfig.port}`);
        return conn;
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw new Error(`MySQL admin connection failed (${lastError?.message || 'Unknown error'})`);
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

  // ── Step 2 & 3: Create DB via safe admin connection ───────────────────────
  const adminConn = await createSafeAdminConnection(dbConfig);

  try {
    await adminConn.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`[Provisioning] Database '${dbName}' verified/created`);

    // ── Step 4: Ensure app user exists and grant access ────────────────────
    if (dbConfig.appUser && dbConfig.appUser !== dbConfig.adminUser) {
      try {
        await adminConn.execute(
          `CREATE USER IF NOT EXISTS '${dbConfig.appUser}'@'%' IDENTIFIED BY '${dbConfig.appPassword}'`
        ).catch(() => {});
        await adminConn.execute(
          `CREATE USER IF NOT EXISTS '${dbConfig.appUser}'@'localhost' IDENTIFIED BY '${dbConfig.appPassword}'`
        ).catch(() => {});
        await adminConn.execute(
          `ALTER USER '${dbConfig.appUser}'@'%' IDENTIFIED BY '${dbConfig.appPassword}'`
        ).catch(() => {});
        await adminConn.execute(
          `ALTER USER '${dbConfig.appUser}'@'localhost' IDENTIFIED BY '${dbConfig.appPassword}'`
        ).catch(() => {});
        await adminConn.execute(
          `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbConfig.appUser}'@'%'`
        ).catch(async () => {
          await adminConn.execute(
            `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbConfig.appUser}'@'localhost'`
          ).catch((err) => console.warn('[Provisioning] Grant warning:', err.message));
        });
        await adminConn.execute('FLUSH PRIVILEGES').catch(() => {});
        console.log(`[Provisioning] Privileges configured for '${dbConfig.appUser}'`);
      } catch (userErr) {
        console.warn(`[Provisioning] User setup warning for '${dbConfig.appUser}':`, userErr.message);
      }
    }
  } finally {
    await adminConn.end().catch(() => {});
  }

  // ── Step 5: Build connection string and test connection with auto-fallback ─
  let activeUser = dbConfig.appUser;
  let activePassword = dbConfig.appPassword;
  let connUrl = `mysql://${encodeURIComponent(activeUser)}:${encodeURIComponent(activePassword)}@${dbConfig.host}:${dbConfig.port}/${dbName}`;

  let tenantSequelize = new Sequelize(connUrl, {
    dialect: 'mysql',
    logging: false,
    pool: { max: 3, min: 0, acquire: 20000, idle: 10000 },
    dialectOptions: { connectTimeout: 15000 },
  });

  try {
    await tenantSequelize.authenticate();
    console.log(`[Provisioning] Authenticated with appUser '${activeUser}'`);
  } catch (authErr) {
    console.warn(`[Provisioning] Connection with appUser '${activeUser}' failed (${authErr.message}). Switching to verified admin credentials...`);
    await tenantSequelize.close().catch(() => {});

    activeUser = dbConfig.adminUser;
    activePassword = dbConfig.adminPassword;
    connUrl = `mysql://${encodeURIComponent(activeUser)}:${encodeURIComponent(activePassword)}@${dbConfig.host}:${dbConfig.port}/${dbName}`;

    tenantSequelize = new Sequelize(connUrl, {
      dialect: 'mysql',
      logging: false,
      pool: { max: 3, min: 0, acquire: 20000, idle: 10000 },
      dialectOptions: { connectTimeout: 15000 },
    });
    await tenantSequelize.authenticate();
    console.log(`[Provisioning] Authenticated with fallback admin credentials '${activeUser}'`);
  }

  const connectionStringEncrypted = encrypt(connUrl);

  // ── Step 6: Sync tenant models ────────────────────────────────────────────
  let gymId = null;
  let listingId = null;

  try {
    const models = registerTenantModels(tenantSequelize);
    await tenantSequelize.sync({ force: false, alter: true });
    console.log(`[Provisioning] Tenant schema synced to '${dbName}'`);

    // ── Step 7: Create or activate GymListing on platform DB ────────────────
    let existingListing = await GymListing.findOne({ where: { tenantId: tenant.id } });

    if (!existingListing && tenant.gymName) {
      let safeCityId = tenant.cityId || 1;
      let safeAreaId = tenant.areaId || null;

      if (safeCityId) {
        const cityObj = await City.findByPk(safeCityId).catch(() => null);
        if (!cityObj) safeCityId = 1;
      }
      if (safeAreaId) {
        const areaObj = await Area.findByPk(safeAreaId).catch(() => null);
        if (!areaObj) safeAreaId = null;
      }

      const safeLat = tenant.latitude != null ? parseFloat(Number(tenant.latitude).toFixed(7)) : null;
      const safeLng = tenant.longitude != null ? parseFloat(Number(tenant.longitude).toFixed(7)) : null;

      existingListing = await GymListing.create({
        tenantId: tenant.id,
        cityId: safeCityId,
        areaId: safeAreaId,
        title: tenant.gymName,
        shortDescription: tenant.gymDescription || null,
        logoUrl: tenant.logoUrl || null,
        coverImageUrl: tenant.coverImageUrl || null,
        genderType: tenant.genderType || 'MIXED',
        contactPhone: tenant.phone || null,
        latitude: safeLat,
        longitude: safeLng,
        status: 'ACTIVE',
      }).catch((e) => {
        console.warn('[Provisioning] GymListing creation warning:', e.message);
        return null;
      });
      console.log(`[Provisioning] GymListing created for tenant ${tenantId}`);
    }

    if (existingListing) {
      listingId = existingListing.id;
      if (existingListing.status !== 'ACTIVE') {
        await existingListing.update({ status: 'ACTIVE' }).catch(() => {});
      }
    }

    // ── Step 8a: Create or update Gym record in tenant DB (idempotent) ──────
    if (tenant.gymName) {
      let gym = await models.Gym.findOne();
      if (!gym) {
        gym = await models.Gym.create({
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
      } else {
        gymId = gym.id;
        if (listingId && !gym.gymListingId) {
          await gym.update({ gymListingId: listingId }).catch(() => {});
        }
      }

      // ── Step 8b: Create or update initial Branch from onboarding data ────
      if (tenant.mainBranchDataJson && gymId) {
        let b = tenant.mainBranchDataJson;
        if (typeof b === 'string') {
          try { b = JSON.parse(b); } catch (e) { b = {}; }
        }

        const safeBranchLat = b.latitude != null ? parseFloat(Number(b.latitude).toFixed(7)) : (tenant.latitude != null ? parseFloat(Number(tenant.latitude).toFixed(7)) : null);
        const safeBranchLng = b.longitude != null ? parseFloat(Number(b.longitude).toFixed(7)) : (tenant.longitude != null ? parseFloat(Number(tenant.longitude).toFixed(7)) : null);

        let branch = await models.Branch.findOne({ where: { gymId } });
        if (!branch) {
          branch = await models.Branch.create({
            gymId,
            gymListingId: listingId,
            branchName: b.name || tenant.gymName,
            address: b.address || tenant.address || null,
            cityId: b.cityId || tenant.cityId || null,
            areaId: b.areaId || tenant.areaId || null,
            latitude: safeBranchLat,
            longitude: safeBranchLng,
            phone: b.phone || tenant.phone || null,
            openingTime: b.openingTime || null,
            closingTime: b.closingTime || null,
            status: 'ACTIVE',
            travelerVisibilityStatus: 'active',
          });
          console.log(`[Provisioning] Initial Branch created in '${dbName}'`);
        } else {
          if (listingId && !branch.gymListingId) {
            await branch.update({ gymListingId: listingId }).catch(() => {});
          }
        }

        // Link primary branchId back to GymListing on platform DB
        if (listingId && branch?.id) {
          await GymListing.update({ branchId: branch.id }, { where: { id: listingId } }).catch(() => {});
        }
      }
    }
  } finally {
    await tenantSequelize.close().catch(() => {});
  }

  // ── Step 9: Update tenant record to ACTIVE ───────────────────────────────
  await tenant.update({
    status: TenantStatus.ACTIVE,
    dbName,
    connectionStringEncrypted,
  });
  console.log(`[Provisioning] Tenant ${tenantId} status set to ACTIVE with dbName '${dbName}'`);

  // Prime Redis connection string cache
  await safeRedisSetex(`tenant:${tenantId}:connStr`, 3600, connectionStringEncrypted);

  // ── Step 10: Auto-create subscription for selected package (safe) ────────
  if (tenant.selectedPackageId) {
    try {
      const existingActiveSub = await TenantSubscription.findOne({
        where: { tenantId: tenant.id },
      });

      if (!existingActiveSub) {
        const pkg = await PlatformPackage.findByPk(tenant.selectedPackageId);
        if (pkg) {
          const rawCycle = (pkg.billingCycle || 'MONTHLY').toUpperCase();
          const cycle = ['MONTHLY', 'QUARTERLY', 'YEARLY'].includes(rawCycle) ? rawCycle : 'MONTHLY';
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
            amount: pkg.price != null ? pkg.price : 0,
            billingCycle: cycle,
            status: 'ACTIVE',
            autoRenew: true,
            paymentStatus: 'PENDING',
          });
          console.log(`[Provisioning] Subscription auto-created for tenant ${tenantId} (package: ${pkg.name})`);
        }
      }
    } catch (subErr) {
      console.warn('[Provisioning] Subscription auto-creation warning:', subErr.message);
    }
  }

  // ── Step 11: Send approval email ──────────────────────────────────────────
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

  // ── Step 12: In-app notification ──────────────────────────────────────────
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

  console.log(`[Provisioning] ✅ Tenant ${tenantId} fully provisioned and ACTIVE`);
};

module.exports = { processTenantProvisioning };
