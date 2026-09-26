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
const subscriptionQuotaService = require('./subscription-quota.service');
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
      if (gymId) {
        let b = tenant.mainBranchDataJson || {};
        if (typeof b === 'string') {
          try { b = JSON.parse(b); } catch (e) { b = {}; }
        }

        const safeBranchLat = b.latitude != null ? parseFloat(Number(b.latitude).toFixed(7)) : (tenant.latitude != null ? parseFloat(Number(tenant.latitude).toFixed(7)) : null);
        const safeBranchLng = b.longitude != null ? parseFloat(Number(b.longitude).toFixed(7)) : (tenant.longitude != null ? parseFloat(Number(tenant.longitude).toFixed(7)) : null);

        // Step 4's photos — see tenant.service.js#addOnboardingImages — live
        // on this same mainBranchDataJson blob until now, since there was no
        // Branch row for them to attach to any earlier than this.
        const onboardingImages = Array.isArray(b.imagesJson) ? b.imagesJson : [];

        let branch = await models.Branch.findOne({ where: { gymId } });
        if (!branch) {
          branch = await models.Branch.create({
            gymId,
            gymListingId: listingId,
            branchName: b.name || tenant.gymName || 'Main Branch',
            address: b.address || tenant.address || null,
            cityId: b.cityId || tenant.cityId || null,
            areaId: b.areaId || tenant.areaId || null,
            latitude: safeBranchLat,
            longitude: safeBranchLng,
            phone: b.phone || tenant.phone || null,
            openingTime: b.openingTime || null,
            closingTime: b.closingTime || null,
            imagesJson: onboardingImages,
            status: 'ACTIVE',
            travelerVisibilityStatus: 'active',
          });
          console.log(`[Provisioning] Initial Branch created in '${dbName}' (id: ${branch.id})`);
        } else {
          const updates = {};
          if (listingId && !branch.gymListingId) updates.gymListingId = listingId;
          if (branch.status !== 'ACTIVE') updates.status = 'ACTIVE';
          if (b.name && !branch.branchName) updates.branchName = b.name;
          if (b.address && !branch.address) updates.address = b.address;
          // Only fill in if the branch has no photos of its own yet — never
          // clobber photos a host already added post-provisioning via the
          // edit-photos screen with stale onboarding-time data.
          if (onboardingImages.length > 0 && (!branch.imagesJson || branch.imagesJson.length === 0)) {
            updates.imagesJson = onboardingImages;
          }
          if (Object.keys(updates).length > 0) {
            await branch.update(updates).catch(() => {});
          }
        }

        // Link primary branchId back to GymListing on platform DB
        if (listingId && branch?.id) {
          await GymListing.update({ branchId: branch.id }, { where: { id: listingId } }).catch(() => {});
        }

        // A host can subscribe to more branches than they build right away
        // (e.g. bought a 2-branch plan, this provisioning step only ever
        // builds the 1 main branch) — whatever's left over belongs to this,
        // their first and at this point only, organization, as a slot ready
        // to build later. Never left unattributed: that's what made "how
        // many branches do I still have" impossible to answer per
        // organization once a host had more than one.
        if (listingId) {
          try {
            const activeSub = await subscriptionQuotaService.getActiveSubscription(tenantId);
            const maxBranches = await subscriptionQuotaService.resolveMaxBranches(tenant, activeSub);
            const extraSlots = maxBranches - 1; // 1 branch was just built above
            if (extraSlots > 0) {
              // A fresh GymListing always starts at reservedSlots: 0 (model
              // default) and this only ever runs once, during this org's own
              // creation — nothing else could have touched it yet.
              await subscriptionQuotaService.recordCapacityEvent(
                {
                  tenantId,
                  listingId,
                  action: 'SLOT_ATTRIBUTED_UPGRADE',
                  delta: extraSlots,
                  reservedSlotsBefore: 0,
                  reservedSlotsAfter: extraSlots,
                  actorType: 'SYSTEM',
                  reason: `Initial provisioning: ${extraSlots} unbuilt slot(s) from a ${maxBranches}-branch plan attributed to the host's first organization`,
                  idempotencyKey: `slot_attribute_provisioning:${listingId}`,
                },
                { transaction: null }
              );
              await GymListing.update({ reservedSlots: extraSlots }, { where: { id: listingId } });
              console.log(`[Provisioning] Attributed ${extraSlots} unbuilt slot(s) to GymListing ${listingId}`);
            }
          } catch (slotErr) {
            console.warn('[Provisioning] Failed to attribute reserved slots:', slotErr.message);
          }
        }

        // ── Step 8c: Create initial membership plans for the initial branch ────
        if (branch?.id) {
          const rawPlans = (Array.isArray(b.plans) && b.plans.length > 0)
            ? b.plans
            : (Array.isArray(b.packages) && b.packages.length > 0 ? b.packages : []);

          let createdPlansCount = 0;
          let lowestPrice = null;

          for (const p of rawPlans) {
            if (!p || !p.name || p.price === undefined || p.price === null) continue;
            try {
              const pPrice = parseFloat(p.price) || 0;
              let durationType = String(p.durationType || 'MONTHLY').toUpperCase();
              if (!['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'].includes(durationType)) {
                if (durationType.includes('DAY') || durationType.includes('DAILY')) durationType = 'DAILY';
                else if (durationType.includes('WEEK')) durationType = 'WEEKLY';
                else if (durationType.includes('QUART')) durationType = 'QUARTERLY';
                else if (durationType.includes('YEAR') || durationType.includes('ANNUAL')) durationType = 'YEARLY';
                else durationType = 'MONTHLY';
              }
              const durationValue = parseInt(p.durationValue, 10) || 1;
              const joiningFee = parseFloat(p.joiningFee) || 0;
              const securityFee = parseFloat(p.securityFee) || 0;
              const visitLimit = (p.visitLimit !== undefined && p.visitLimit !== null && p.visitLimit !== '')
                ? parseInt(p.visitLimit, 10) : null;
              const freezeLimitDays = parseInt(p.freezeLimitDays, 10) || 0;
              const isTrial = Boolean(p.isTrial);
              const isPublic = p.isPublic !== undefined ? Boolean(p.isPublic) : true;

              const existingPlan = await models.MembershipPlan.findOne({
                where: {
                  branchId: branch.id,
                  name: p.name.trim(),
                },
              });

              if (existingPlan) {
                await existingPlan.update({
                  description: p.description || existingPlan.description,
                  durationType,
                  durationValue,
                  price: pPrice,
                  joiningFee,
                  securityFee,
                  visitLimit,
                  freezeLimitDays,
                  isTrial,
                  isPublic,
                  status: 'ACTIVE',
                  isDeactivated: false,
                });
                console.log(`[Provisioning] Updated existing MembershipPlan '${p.name}' in '${dbName}'`);
              } else {
                await models.MembershipPlan.create({
                  gymId,
                  branchId: branch.id,
                  name: p.name.trim(),
                  description: p.description || null,
                  durationType,
                  durationValue,
                  price: pPrice,
                  joiningFee,
                  securityFee,
                  visitLimit,
                  freezeLimitDays,
                  isTrial,
                  isPublic,
                  isDeactivated: false,
                  status: 'ACTIVE',
                });
                console.log(`[Provisioning] Created MembershipPlan '${p.name}' in '${dbName}'`);
              }

              createdPlansCount++;
              if (lowestPrice === null || pPrice < lowestPrice) {
                lowestPrice = pPrice;
              }
            } catch (pErr) {
              console.warn('[Provisioning] MembershipPlan creation/update error:', pErr.message);
            }
          }

          // Fallback: If no plans were provided or created, ensure at least 1 standard plan exists
          const existingCount = await models.MembershipPlan.count({
            where: { branchId: branch.id, status: 'ACTIVE' }
          });
          if (existingCount === 0) {
            const defaultPrice = 5000;
            await models.MembershipPlan.create({
              gymId,
              branchId: branch.id,
              name: 'Standard Membership',
              description: 'Full access to gym facilities and equipment.',
              durationType: 'MONTHLY',
              durationValue: 1,
              price: defaultPrice,
              joiningFee: 0,
              securityFee: 0,
              isTrial: false,
              isPublic: true,
              isDeactivated: false,
              status: 'ACTIVE',
            }).catch((pErr) => console.warn('[Provisioning] Fallback plan creation error:', pErr.message));
            lowestPrice = defaultPrice;
            console.log(`[Provisioning] Fallback initial MembershipPlan created in '${dbName}'`);
          }

          if (listingId && lowestPrice !== null) {
            await GymListing.update({ minPrice: lowestPrice }, { where: { id: listingId } }).catch(() => {});
          }
        }
      }
    }

    // ── Step 8d: Run tenant migrations to the latest version (spec §6.5) ──
    const { runTenantMigrations } = require('../database/tenant-migration-runner');
    await runTenantMigrations(tenantSequelize, {
      tenantId: tenant.id,
      gymName: tenant.gymName,
    });
    console.log(`[Provisioning] Tenant migrations applied to latest version for '${dbName}'`);
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
