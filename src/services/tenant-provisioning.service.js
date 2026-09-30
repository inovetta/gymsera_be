/**
 * TenantProvisioningService
 *
 * Called from admin.service.js when an admin approves a tenant (and by the
 * daily sweep in subscription-expiry.cron.js). Runs inline in the request so it
 * works the same on serverless (Vercel) and on a traditional always-on server
 * — no background worker required.
 *
 * Resumable and idempotent (FLOW-02, spec §12.3 / §11.3). Six steps, each
 * recorded on the Tenant row (`provisioningState`) once its work is done:
 *
 *  1. DB_CREATED           CREATE DATABASE IF NOT EXISTS, app-user grants, the
 *                          configured app user can log in (no credential fallback, R-25)
 *  2. MODELS_SYNCED        tenant Sequelize models synced
 *  3. LISTING_CREATED      GymListing found or created on the platform DB (cross-DB link)
 *  4. BRANCH_CREATED       Gym, initial Branch and its membership plans found or created
 *  5. SUBSCRIPTION_LINKED  the plan for approval (FLOW-03 / BILL-13) or the legacy
 *                          package plan, then the unbuilt-slot attribution
 *  6. ACTIVE               tenant migrations to the latest version, then the Tenant
 *                          becomes ACTIVE with dbName + connection string
 * Then (best-effort, once): Redis cache primed, approval e-mail and notification.
 *
 * A run holds a lease on the Tenant row (`provisioningLockToken` +
 * `provisioningLockedUntil`), renewed at every step: a second approve while it
 * runs gets the in-progress state instead of running twice; a run that died
 * (e.g. a serverless timeout) leaves a lease that expires, after which Resume
 * or the sweep takes over. A failure releases the lease and records the error;
 * the tenant stays APPROVED at the last finished step. Every step finds existing
 * rows by their natural keys before creating, so a step that was interrupted
 * after its work but before it was recorded is simply redone.
 */
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { Sequelize, Op } = require('sequelize');

const { Tenant, User, City, Area, GymListing, TenantSubscription, PlatformPackage } = require('../models/platform');
const subscriptionQuotaService = require('./subscription-quota.service');
const registerTenantModels = require('../models/tenant');
const { encrypt } = require('../utils/crypto.utils');
const { redactString } = require('../utils/log-redaction');
const emailService = require('./email.service');
const { safeRedisSetex } = require('../config/redis.config');
const { TenantStatus } = require('../constants/subscription-status');

// ── Env helpers ───────────────────────────────────────────────────────────────
// Credentials come ONLY from TENANT_DB_ADMIN_USER / TENANT_DB_ADMIN_PASS (to
// create the database) and TENANT_DB_USER / TENANT_DB_PASS (what the tenant
// runs as). No platform credentials, no `root`, no empty-password guess: a
// missing or rejected credential stops provisioning with a clear error
// (decision R-25, same approach as SEC-DB-FALLBACK). An explicitly empty
// password is allowed (local/CI MySQL without one); an empty user is not.
const REQUIRED_TENANT_DB_SETTINGS = ['TENANT_DB_ADMIN_USER', 'TENANT_DB_ADMIN_PASS', 'TENANT_DB_USER', 'TENANT_DB_PASS'];

const tenantDbNotConfigured = (message) => {
  const err = new Error(message);
  err.code = 'TENANT_DB_NOT_CONFIGURED';
  return err;
};

const getTenantDbConfig = (env = process.env) => {
  const missing = REQUIRED_TENANT_DB_SETTINGS.filter(
    (key) => env[key] === undefined || (key.endsWith('_USER') && String(env[key]).trim() === '')
  );
  if (missing.length > 0) {
    throw tenantDbNotConfigured(
      `Tenant database server is not configured: missing ${missing.join(', ')}. ` +
        'Provisioning uses only these settings (there is no fallback to other credentials).'
    );
  }
  const host = env.TENANT_DB_HOST || env.PLATFORM_DB_HOST || '127.0.0.1';
  const port = parseInt(env.TENANT_DB_PORT || env.PLATFORM_DB_PORT || '3306');
  return {
    host,
    port,
    adminUser: env.TENANT_DB_ADMIN_USER,
    adminPassword: env.TENANT_DB_ADMIN_PASS,
    appUser: env.TENANT_DB_USER,
    appPassword: env.TENANT_DB_PASS,
  };
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
 * Connect to the tenant MySQL server as the configured admin user. Only the
 * host spelling may be retried (127.0.0.1 <-> localhost, same server);
 * credentials never change (R-25).
 */
const createSafeAdminConnection = async (dbConfig) => {
  const hostsToTry = [dbConfig.host];
  if (dbConfig.host === 'localhost') hostsToTry.push('127.0.0.1');
  else if (dbConfig.host === '127.0.0.1') hostsToTry.push('localhost');

  let lastError;
  for (const host of hostsToTry) {
    try {
      const conn = await mysql.createConnection({
        host,
        port: dbConfig.port,
        user: dbConfig.adminUser,
        password: dbConfig.adminPassword,
        connectTimeout: 10000,
      });
      dbConfig.host = host;
      console.log(`[Provisioning] Connected to MySQL as '${dbConfig.adminUser}' on ${host}:${dbConfig.port}`);
      return conn;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `MySQL admin connection failed for TENANT_DB_ADMIN_USER '${dbConfig.adminUser}' (${lastError?.code || lastError?.message || 'Unknown error'}). ` +
      'Check TENANT_DB_ADMIN_USER / TENANT_DB_ADMIN_PASS; no other credentials are tried.'
  );
};


// ── Resumable step machine (FLOW-02) ──────────────────────────────────────────

const PROVISIONING_STEPS = [
  'DB_CREATED',
  'MODELS_SYNCED',
  'LISTING_CREATED',
  'BRANCH_CREATED',
  'SUBSCRIPTION_LINKED',
  'ACTIVE',
];
// Recorded by approve before the first step runs: the intent to provision.
const PROVISIONING_REQUESTED = 'REQUESTED';

// How long a run may go without finishing a step before another run may take
// over. Renewed at every step; the slowest step (model sync) takes seconds.
const PROVISIONING_LEASE_MS = 10 * 60 * 1000;

// Test seam (same pattern as email.service#mailTransport): onStep(step, phase)
// runs 'before' a step's work and 'after' it, before the step is recorded.
const provisioningHooks = { onStep: null };

const runHook = async (step, phase) => {
  if (typeof provisioningHooks.onStep === 'function') await provisioningHooks.onStep(step, phase);
};

const stepNumber = (state) => PROVISIONING_STEPS.indexOf(state) + 1; // REQUESTED / unknown → 0

/** What the admin sees: "Provisioning… (step n/6)", Resume or in progress. */
const provisioningSummary = (tenant, now = new Date()) => {
  const state = tenant.provisioningState || null;
  const leaseHeld = Boolean(
    tenant.provisioningLockToken && tenant.provisioningLockedUntil && new Date(tenant.provisioningLockedUntil) > now
  );
  const active = tenant.status === TenantStatus.ACTIVE;
  return {
    state,
    step: active ? PROVISIONING_STEPS.length : stepNumber(state),
    totalSteps: PROVISIONING_STEPS.length,
    inProgress: leaseHeld && !active,
    lockedUntil: leaseHeld && !active ? tenant.provisioningLockedUntil : null,
    lastError: tenant.provisioningError || null,
    canResume: tenant.status === TenantStatus.APPROVED && !leaseHeld,
  };
};

const lockLost = (tenantId) => {
  const err = new Error(
    `Provisioning of tenant ${tenantId} stopped: another run took over, or the tenant is no longer APPROVED.`
  );
  err.code = 'PROVISIONING_LOCK_LOST';
  return err;
};

const leaseUntil = () => new Date(Date.now() + PROVISIONING_LEASE_MS);

/** Takes the lease if nobody holds a live one. Returns the token, or null. */
const claimLease = async (tenantId) => {
  const token = crypto.randomUUID();
  const now = new Date();
  const [affected] = await Tenant.update(
    { provisioningLockToken: token, provisioningLockedUntil: leaseUntil() },
    {
      where: {
        id: tenantId,
        status: TenantStatus.APPROVED,
        [Op.or]: [
          { provisioningLockToken: null },
          { provisioningLockedUntil: null },
          { provisioningLockedUntil: { [Op.lt]: now } },
        ],
      },
    }
  );
  return affected === 1 ? token : null;
};

/** Writes `fields` only while this run still holds the lease on an APPROVED tenant. */
const writeUnderLease = async (tenantId, token, fields) => {
  const where = { id: tenantId, provisioningLockToken: token, status: TenantStatus.APPROVED };
  const [affected] = await Tenant.update(fields, { where });
  // MySQL counts changed rows: a renewal within the same second (DATETIME has
  // 1-second precision) changes nothing, so confirm the lease is still ours.
  if (affected !== 1 && (await Tenant.count({ where })) !== 1) throw lockLost(tenantId);
};

const releaseLease = async (tenantId, token, error) => {
  const message = redactString(String(error?.message || error || 'Unknown error')).slice(0, 500);
  await Tenant.update(
    { provisioningLockToken: null, provisioningLockedUntil: null, provisioningError: message },
    { where: { id: tenantId, provisioningLockToken: token } }
  ).catch((err) => console.warn(`[Provisioning] Could not release the lease for tenant ${tenantId}:`, err.message));
};

const onboardingBranchData = (tenant) => {
  let b = tenant.mainBranchDataJson || {};
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) { b = {}; }
  }
  return b;
};

const firstListing = (tenantId) =>
  GymListing.findOne({ where: { tenantId }, order: [['createdAt', 'ASC']] });

/**
 * Per-run context. The tenant DB connection is opened lazily, so a resumed run
 * that starts at step 3 connects the same way step 1 left it.
 */
const createRunContext = (tenant) => {
  const dbConfig = getTenantDbConfig();
  const dbName = buildDbName(tenant.tenantCode);
  const ctx = {
    tenant,
    dbConfig,
    dbName,
    connUrl: null,
    sequelize: null,
    models: null,
    hostResolved: false,
    async openTenantDb() {
      if (ctx.sequelize) return ctx.sequelize;
      // The app user connects to the host the admin login settled on (the only
      // retry R-25 allows is that host spelling). A resumed run that skipped
      // step 1 settles it the same way, so the stored connection string is the
      // one a single run would store. Never other credentials: the admin ones
      // would become this tenant's permanent connection string (R-25).
      if (!ctx.hostResolved) {
        const adminConn = await createSafeAdminConnection(dbConfig);
        await adminConn.end().catch(() => {});
        ctx.hostResolved = true;
      }
      const url = `mysql://${encodeURIComponent(dbConfig.appUser)}:${encodeURIComponent(dbConfig.appPassword)}@${dbConfig.host}:${dbConfig.port}/${dbName}`;
      const seq = new Sequelize(url, {
        dialect: 'mysql',
        logging: false,
        pool: { max: 3, min: 0, acquire: 20000, idle: 10000 },
        dialectOptions: { connectTimeout: 15000 },
      });
      try {
        await seq.authenticate();
      } catch (authErr) {
        await seq.close().catch(() => {});
        throw new Error(
          `Tenant app user '${dbConfig.appUser}' cannot connect to '${dbName}' (${authErr.original?.code || authErr.name}). ` +
            'Check TENANT_DB_USER / TENANT_DB_PASS; the admin credentials are never used as a fallback.'
        );
      }
      ctx.connUrl = url;
      ctx.sequelize = seq;
      console.log(`[Provisioning] Authenticated with appUser '${dbConfig.appUser}'`);
      return seq;
    },
    async tenantDb() {
      const seq = await ctx.openTenantDb();
      if (!ctx.models) {
        ctx.models = registerTenantModels(seq);
        seq.models = ctx.models;
        seq.tenantId = tenant.id;
      }
      return seq;
    },
    async close() {
      if (ctx.sequelize) await ctx.sequelize.close().catch(() => {});
    },
  };
  return ctx;
};

// ── Step 1: database, app-user grants, app user can log in ───────────────────
const stepCreateDatabase = async (ctx) => {
  const { dbConfig, dbName } = ctx;
  const adminConn = await createSafeAdminConnection(dbConfig);

  try {
    await adminConn.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`[Provisioning] Database '${dbName}' verified/created`);

    // Ensure app user exists and grant access
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
  ctx.hostResolved = true;

  // The tenant runs as the configured app user: prove it can log in now.
  await ctx.openTenantDb();
};

// ── Step 2: tenant schema ─────────────────────────────────────────────────────
const stepSyncModels = async (ctx) => {
  const seq = await ctx.tenantDb();
  await seq.sync({ force: false, alter: true });
  console.log(`[Provisioning] Tenant schema synced to '${ctx.dbName}'`);
};

// ── Step 3: GymListing on the platform DB (found by tenantId, else created) ──
const stepCreateListing = async (ctx) => {
  const { tenant } = ctx;
  let existingListing = await firstListing(tenant.id);

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

    // Not swallowed (FLOW-02): without a listing the branch below would be
    // built unattached and the tenant activated with no public listing.
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
    });
    console.log(`[Provisioning] GymListing created for tenant ${tenant.id}`);
  }

  if (existingListing && existingListing.status !== 'ACTIVE') {
    await existingListing.update({ status: 'ACTIVE' }).catch(() => {});
  }
};

// ── Step 4: Gym, initial Branch and its membership plans (tenant DB) ─────────
const stepCreateBranch = async (ctx) => {
  const { tenant, dbName } = ctx;
  if (!tenant.gymName) return;

  const tenantDb = await ctx.tenantDb();
  const { models } = ctx;
  const listing = await firstListing(tenant.id);
  const listingId = listing ? listing.id : null;

  // ── Gym record (one per tenant DB) ─────────────────────────────────────────
  let gymId = null;
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

  // ── Initial Branch from onboarding data ────────────────────────────────────
  const b = onboardingBranchData(tenant);

  const safeBranchLat = b.latitude != null ? parseFloat(Number(b.latitude).toFixed(7)) : (tenant.latitude != null ? parseFloat(Number(tenant.latitude).toFixed(7)) : null);
  const safeBranchLng = b.longitude != null ? parseFloat(Number(b.longitude).toFixed(7)) : (tenant.longitude != null ? parseFloat(Number(tenant.longitude).toFixed(7)) : null);

  // Step 4's photos — see tenant.service.js#addOnboardingImages — live
  // on this same mainBranchDataJson blob until now, since there was no
  // Branch row for them to attach to any earlier than this.
  const onboardingImages = Array.isArray(b.imagesJson) ? b.imagesJson : [];

  let branch = await models.Branch.findOne({ where: { gymId } });
  if (!branch) {
    // CAP-03: Route through gymService.createBranch
    const gymService = require('./gym.service');
    const rawPackages = (Array.isArray(b.packages) && b.packages.length > 0)
      ? b.packages
      : (Array.isArray(b.plans) && b.plans.length > 0 ? b.plans : []);
    const branchResult = await gymService.createBranch(
      tenantDb,
      tenant.id,
      {
        gymListingId: listingId,
        branchName: b.name || tenant.gymName || 'Main Branch',
        address: b.address || tenant.address || null,
        addressLine1: b.address || tenant.address || null,
        cityId: b.cityId || tenant.cityId || null,
        areaId: b.areaId || tenant.areaId || null,
        latitude: safeBranchLat,
        longitude: safeBranchLng,
        phone: b.phone || tenant.phone || null,
        openingTime: b.openingTime || null,
        closingTime: b.closingTime || null,
        images: onboardingImages,
        packages: rawPackages,
      },
      null,
      {
        actorType: 'SYSTEM',
        allowDefaultPackage: true,
        isProvisioning: true,
        skipCapacityCheck: true,
        skipCapacityEvent: true,
        reason: 'Initial Branch created during tenant provisioning',
      }
    );
    branch = branchResult.branch;
    console.log(`[Provisioning] Initial Branch created in '${dbName}' (id: ${branch.id})`);
  } else {
    const updates = {};
    if (listingId && !branch.gymListingId) updates.gymListingId = listingId;
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
    if (branch.status !== 'ACTIVE') {
      const gymService = require('./gym.service');
      await gymService.restoreBranch(tenantDb, tenant.id, branch.id, null);
    }
  }

  // Link primary branchId back to GymListing on platform DB
  if (listingId && branch?.id) {
    await GymListing.update({ branchId: branch.id }, { where: { id: listingId } }).catch(() => {});
  }

  // ── Initial membership plans for the initial branch (found by branch + name) ──
  if (branch?.id) {
    const rawPlans = (Array.isArray(b.plans) && b.plans.length > 0)
      ? b.plans
      : (Array.isArray(b.packages) && b.packages.length > 0 ? b.packages : []);

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
};

// ── Step 5: the tenant's plan, then its unbuilt slots ────────────────────────
const stepLinkSubscription = async (ctx) => {
  const { tenant } = ctx;

  // The plan for approval (FLOW-03, BILL-13): a provider-backed plan the
  // tenant already has (e.g. a card subscription from registration) is
  // re-verified and nothing else is created (FLOW-03). Otherwise "pay later"
  // gets one branch for PAY_LATER_GRACE_DAYS in GRACE (BILL-13). Before the
  // reserved-slot attribution below reads the entitlement, before the tenant
  // is ACTIVE, and never swallowed (NEW-18 for this path). Idempotent.
  await require('./subscription-migration.service').planForApproval(tenant);

  // Legacy package plan when the tenant still has no plan row at all (found
  // by tenantId). Not swallowed any more (FLOW-02): a tenant must not become
  // ACTIVE without its plan.
  if (tenant.selectedPackageId) {
    const existingSub = await TenantSubscription.findOne({ where: { tenantId: tenant.id } });
    if (!existingSub) {
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
        console.log(`[Provisioning] Subscription auto-created for tenant ${tenant.id} (package: ${pkg.name})`);
      }
    }
  }

  // A host can subscribe to more branches than they build right away
  // (e.g. bought a 2-branch plan, provisioning only ever builds the 1 main
  // branch) — whatever's left over belongs to this, their first and at this
  // point only, organization, as a slot ready to build later. The capacity
  // event (idempotency key per listing) and the listing's reservedSlots are
  // written in one platform transaction, so a resumed run never applies it
  // twice or records one without the other.
  const listing = await firstListing(tenant.id);
  if (listing && tenant.gymName) {
    const activeSub = await subscriptionQuotaService.getActiveSubscription(tenant.id);
    const maxBranches = await subscriptionQuotaService.resolveMaxBranches(tenant, activeSub);
    const extraSlots = maxBranches - 1; // 1 branch was built in step 4
    if (extraSlots > 0) {
      await GymListing.sequelize.transaction(async (transaction) => {
        const { applied } = await subscriptionQuotaService.recordCapacityEvent(
          {
            tenantId: tenant.id,
            listingId: listing.id,
            action: 'SLOT_ATTRIBUTED_UPGRADE',
            delta: extraSlots,
            reservedSlotsBefore: 0,
            reservedSlotsAfter: extraSlots,
            actorType: 'SYSTEM',
            reason: `Initial provisioning: ${extraSlots} unbuilt slot(s) from a ${maxBranches}-branch plan attributed to the host's first organization`,
            idempotencyKey: `slot_attribute_provisioning:${listing.id}`,
          },
          { transaction }
        );
        if (applied) {
          await GymListing.update({ reservedSlots: extraSlots }, { where: { id: listing.id }, transaction });
          console.log(`[Provisioning] Attributed ${extraSlots} unbuilt slot(s) to GymListing ${listing.id}`);
        }
      });
    }
  }
};

// ── Step 6: migrations, then ACTIVE (the step record IS the activation) ──────
const stepActivate = async (ctx, token) => {
  const { tenant, dbName } = ctx;
  const seq = await ctx.tenantDb();
  const { runTenantMigrations } = require('../database/tenant-migration-runner');
  await runTenantMigrations(seq, { tenantId: tenant.id, gymName: tenant.gymName });
  console.log(`[Provisioning] Tenant migrations applied to latest version for '${dbName}'`);
  await runHook('ACTIVE', 'after');

  const connectionStringEncrypted = encrypt(ctx.connUrl);
  await writeUnderLease(tenant.id, token, {
    status: TenantStatus.ACTIVE,
    dbName,
    connectionStringEncrypted,
    provisioningState: 'ACTIVE',
    provisioningLockToken: null,
    provisioningLockedUntil: null,
    provisioningError: null,
  });
  console.log(`[Provisioning] Tenant ${tenant.id} status set to ACTIVE with dbName '${dbName}'`);
  return connectionStringEncrypted;
};

const STEP_WORK = {
  DB_CREATED: stepCreateDatabase,
  MODELS_SYNCED: stepSyncModels,
  LISTING_CREATED: stepCreateListing,
  BRANCH_CREATED: stepCreateBranch,
  SUBSCRIPTION_LINKED: stepLinkSubscription,
};

/** Once the tenant is ACTIVE: cache, approval e-mail, notification. Best-effort. */
const afterActivation = async (tenant, connectionStringEncrypted) => {
  await safeRedisSetex(`tenant:${tenant.id}:connStr`, 3600, connectionStringEncrypted);

  if (tenant.owner) {
    try {
      await emailService.sendTenantApprovedEmail(
        tenant.owner.email,
        tenant.owner.fullName,
        tenant.businessName
      );
    } catch (err) {
      console.error(`[Provisioning] Failed to send approval email for tenant ${tenant.id}:`, err.message);
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
};

// ── Main processor ────────────────────────────────────────────────────────────

/**
 * Provision (or resume provisioning) an APPROVED tenant.
 * @param {string} tenantId
 * @returns {Promise<{ activated?: boolean, alreadyActive?: boolean, inProgress?: boolean }>}
 *   `inProgress`: another run holds the lease; nothing was done.
 * @throws the step's error (the tenant stays APPROVED at the last finished step).
 */
const processTenantProvisioning = async (tenantId) => {
  console.log(`[Provisioning] Starting for tenant ${tenantId}`);

  const current = await Tenant.findByPk(tenantId);
  if (!current) throw new Error(`Tenant ${tenantId} not found in platform DB`);
  if (current.status === TenantStatus.ACTIVE && current.connectionStringEncrypted) {
    console.log(`[Provisioning] Tenant ${tenantId} is already ACTIVE — skipping`);
    return { alreadyActive: true };
  }
  if (current.status !== TenantStatus.APPROVED) {
    throw new Error(`Tenant ${tenantId} is ${current.status}, not APPROVED — nothing to provision`);
  }

  // Credentials are checked before the lease is taken: a server that is not
  // configured must not leave a lease behind (R-25).
  getTenantDbConfig();

  const token = await claimLease(tenantId);
  if (!token) {
    console.log(`[Provisioning] Tenant ${tenantId} is being provisioned by another run — not starting a second one`);
    return { inProgress: true };
  }

  const tenant = await Tenant.findByPk(tenantId, {
    include: [{ model: User, as: 'owner', attributes: ['id', 'fullName', 'email'] }],
  });
  const ctx = createRunContext(tenant);
  let connectionStringEncrypted;
  try {
    const done = stepNumber(tenant.provisioningState); // 0 = nothing done yet
    if (done > 0) console.log(`[Provisioning] Resuming tenant ${tenantId} after step ${done}/6 (${tenant.provisioningState})`);

    for (const step of PROVISIONING_STEPS.slice(done)) {
      await runHook(step, 'before');
      await writeUnderLease(tenantId, token, { provisioningLockedUntil: leaseUntil() });
      if (step === 'ACTIVE') {
        connectionStringEncrypted = await stepActivate(ctx, token);
      } else {
        await STEP_WORK[step](ctx);
        await runHook(step, 'after');
        await writeUnderLease(tenantId, token, { provisioningState: step, provisioningLockedUntil: leaseUntil() });
        console.log(`[Provisioning] Tenant ${tenantId}: step ${stepNumber(step)}/6 ${step} done`);
      }
    }
  } catch (err) {
    if (err.code !== 'PROVISIONING_LOCK_LOST') await releaseLease(tenantId, token, err);
    throw err;
  } finally {
    await ctx.close();
  }

  await afterActivation(tenant, connectionStringEncrypted);
  console.log(`[Provisioning] ✅ Tenant ${tenantId} fully provisioned and ACTIVE`);
  return { activated: true };
};

/**
 * Daily sweep (subscription-expiry.cron.js): finishes provisioning that
 * stopped halfway — a failed step, or a run that died and whose lease has
 * expired. Only tenants whose provisioning was started under FLOW-02 (a
 * recorded provisioningState); tenants left APPROVED by older code are for the
 * admin to Resume (see gymsera-flow02-provisioning-check.js).
 */
const resumeStalledProvisioning = async ({ limit = 5 } = {}) => {
  const now = new Date();
  const stalled = await Tenant.findAll({
    where: {
      status: TenantStatus.APPROVED,
      provisioningState: { [Op.ne]: null, [Op.notIn]: ['ACTIVE'] },
      [Op.or]: [{ provisioningLockedUntil: null }, { provisioningLockedUntil: { [Op.lt]: now } }],
    },
    attributes: ['id'],
    order: [['updatedAt', 'ASC']],
    limit,
  });

  const summary = { resumed: [], failed: [], inProgress: [] };
  for (const { id } of stalled) {
    try {
      const result = await processTenantProvisioning(id);
      if (result.inProgress) summary.inProgress.push(id);
      else summary.resumed.push(id);
    } catch (err) {
      summary.failed.push({ id, error: err.message });
      console.error(`[Provisioning sweep] Tenant ${id} still not provisioned:`, err.message);
    }
  }
  return summary;
};

module.exports = {
  processTenantProvisioning,
  resumeStalledProvisioning,
  provisioningSummary,
  provisioningHooks,
  PROVISIONING_STEPS,
  PROVISIONING_REQUESTED,
  PROVISIONING_LEASE_MS,
  getTenantDbConfig,
  createSafeAdminConnection,
  REQUIRED_TENANT_DB_SETTINGS,
};
