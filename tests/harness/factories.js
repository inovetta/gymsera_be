/**
 * Factory utilities for GymsEra integration tests
 *
 * Implements factories for:
 * - Tenant (platform DB)
 * - GymListing (platform DB)
 * - Branch (tenant DB)
 * - TenantSubscription (platform DB)
 * - RoleAssignment (tenant DB)
 * - Payment (tenant DB)
 * plus helpers for User and BillingPlan.
 */
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { encrypt } = require('../../src/utils/crypto.utils');
const {
  User,
  Tenant,
  GymListing,
  TenantSubscription,
  BillingPlan,
  UserOrgIndex,
} = require('../../src/models/platform');

/**
 * Creates a platform user
 */
async function createUser(overrides = {}) {
  const id = overrides.id || uuidv4();
  const password = overrides.password || 'Test@12345';
  const email = overrides.email || `user_${id.slice(0, 8)}@gymseratest.com`;
  
  return User.create({
    id,
    email,
    passwordHash: bcrypt.hashSync(password, 8),
    fullName: overrides.fullName || 'Test User',
    phone: overrides.phone || '+923001234567',
    role: overrides.role || 'MEMBER',
    isVerified: overrides.isVerified !== undefined ? overrides.isVerified : true,
    status: overrides.status || 'ACTIVE',
    ...overrides,
  });
}

/**
 * Creates a BillingPlan in platform DB
 */
async function createBillingPlan(overrides = {}) {
  const id = overrides.id || uuidv4();
  const branchCount = overrides.branchCount || 5;

  return BillingPlan.create({
    id,
    branchCount,
    monthlyPrice: overrides.monthlyPrice || 4999.00,
    annualPrice: overrides.annualPrice || 49999.00,
    currency: overrides.currency || 'PKR',
    isActive: overrides.isActive !== undefined ? overrides.isActive : true,
    sortOrder: overrides.sortOrder || 1,
    iosMonthlyProductId: overrides.iosMonthlyProductId || `com.gymsera.plan.${branchCount}b.monthly`,
    iosAnnualProductId: overrides.iosAnnualProductId || `com.gymsera.plan.${branchCount}b.annual`,
    androidProductId: overrides.androidProductId || `plan_${branchCount}b`,
    androidMonthlyBasePlanId: overrides.androidMonthlyBasePlanId || 'monthly',
    androidAnnualBasePlanId: overrides.androidAnnualBasePlanId || 'annual',
    ...overrides,
  });
}

/**
 * Creates a Tenant in platform DB
 */
async function createTenant(overrides = {}) {
  const id = overrides.id || uuidv4();
  const suffix = id.slice(0, 6).toUpperCase();

  let ownerUserId = overrides.ownerUserId;
  if (!ownerUserId) {
    const owner = await createUser({
      role: 'GYM_HOST',
      email: overrides.email || `owner_${suffix.toLowerCase()}@gymseratest.com`,
      fullName: overrides.ownerName || `Owner ${suffix}`,
    });
    ownerUserId = owner.id;
  }

  // Default to connecting to tenant 1 test database
  const tenantHost = process.env.TENANT_DB_HOST || 'localhost';
  const tenantPort = process.env.TENANT_DB_PORT || '3306';
  const tenantUser = process.env.TENANT_DB_USER || 'root';
  const tenantPass = process.env.TENANT_DB_PASS !== undefined ? process.env.TENANT_DB_PASS : '';
  const tenantDbName = overrides.tenantDbName || 'gymsera_test_tenant_1';
  const defaultConn = `mysql://${tenantUser}:${tenantPass}@${tenantHost}:${tenantPort}/${tenantDbName}`;

  const tenant = await Tenant.create({
    id,
    tenantCode: overrides.tenantCode || `GYM-${suffix}`,
    gymName: overrides.gymName || `Test Gym ${suffix}`,
    businessName: overrides.businessName || `Test Gym Enterprises ${suffix}`,
    email: overrides.email || `tenant_${suffix.toLowerCase()}@gymseratest.com`,
    phone: overrides.phone || '+923007654321',
    cityId: overrides.cityId || 1,
    status: overrides.status || 'ACTIVE',
    ownerUserId,
    connectionStringEncrypted: overrides.connectionStringEncrypted || encrypt(defaultConn),
    ...overrides,
  });

  return tenant;
}

/**
 * Creates a GymListing in platform DB
 */
async function createGymListing(tenantId, overrides = {}) {
  const id = overrides.id || uuidv4();
  const suffix = id.slice(0, 6);

  return GymListing.create({
    id,
    tenantId,
    cityId: overrides.cityId || 1,
    branchId: overrides.branchId || uuidv4(),
    title: overrides.title || `Organization ${suffix}`,
    tagline: overrides.tagline || 'Excellence in fitness',
    slug: overrides.slug || `org-${suffix}`,
    status: overrides.status || 'ACTIVE',
    reservedSlots: overrides.reservedSlots !== undefined ? overrides.reservedSlots : 0,
    contactPhone: overrides.contactPhone || '+923001112233',
    contactEmail: overrides.contactEmail || `org_${suffix}@gymseratest.com`,
    ...overrides,
  });
}

/**
 * Creates a Branch in tenant DB
 */
async function createBranch(tenantDb, gymListingId, overrides = {}) {
  const id = overrides.id || uuidv4();
  const suffix = id.slice(0, 6);
  const BranchModel = tenantDb.models ? tenantDb.models.Branch : tenantDb.Branch;
  const GymModel = tenantDb.models ? tenantDb.models.Gym : tenantDb.Gym;

  let gymId = overrides.gymId;
  if (!gymId && GymModel) {
    let gym = await GymModel.findOne();
    if (!gym) {
      gym = await GymModel.create({
        id: uuidv4(),
        name: overrides.gymName || `Gym ${suffix}`,
        gymListingId,
      });
    }
    gymId = gym.id;
  }

  const branchName = overrides.branchName || overrides.name || `Branch ${suffix}`;

  return BranchModel.create({
    id,
    gymId,
    gymListingId,
    branchName,
    status: overrides.status || 'ACTIVE',
    timezone: overrides.timezone || 'Asia/Karachi',
    address: overrides.address || 'Plot 123, Sector B',
    isPrimary: overrides.isPrimary !== undefined ? overrides.isPrimary : false,
    ...overrides,
  });
}

/**
 * Creates a TenantSubscription in platform DB
 */
async function createTenantSubscription(tenantId, overrides = {}) {
  const id = overrides.id || uuidv4();
  const now = new Date();
  const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  return TenantSubscription.create({
    id,
    tenantId,
    branchCount: overrides.branchCount || 5,
    status: overrides.status || 'ACTIVE',
    platform: overrides.platform || 'MANUAL',
    billingCycle: overrides.billingCycle || 'MONTHLY',
    startDate: overrides.startDate || now,
    endDate: overrides.endDate || thirtyDaysLater,
    autoRenew: overrides.autoRenew !== undefined ? overrides.autoRenew : true,
    billingPlanId: overrides.billingPlanId || null,
    amount: overrides.amount || 4999.00,
    currency: overrides.currency || 'PKR',
    ...overrides,
  });
}

/**
 * Creates a RoleAssignment in tenant DB (+ optional branch links)
 */
async function createRoleAssignment(tenantDb, { userId, roleKey = 'MANAGER', scopeType, scopeId, branchIds = [], overrides = {} }) {
  const id = overrides.id || uuidv4();
  const { RoleAssignment, RoleAssignmentBranch } = tenantDb.models || tenantDb;

  const roleLevels = {
    OWNER: 100,
    ORG_ADMIN: 80,
    ORGANIZATION_ADMIN: 80,
    MANAGER: 60,
    BRANCH_MANAGER: 60,
    BR_ADMIN: 40,
    DESK: 20,
    FRONT_DESK: 20,
    TRAINER: 20,
    SUPPORT: 5,
    CLEANER: 5,
  };

  const normalizedRole = roleKey === 'ORGANIZATION_ADMIN' ? 'ORG_ADMIN' :
    roleKey === 'BRANCH_MANAGER' ? 'MANAGER' :
    roleKey === 'FRONT_DESK' ? 'DESK' :
    roleKey === 'CLEANER' ? 'SUPPORT' : roleKey;

  const roleLevel = overrides.roleLevel !== undefined ? overrides.roleLevel : (roleLevels[roleKey] || roleLevels[normalizedRole] || 20);
  const normalizedScope = (scopeType === 'ORGANIZATION' || scopeType === 'ORG') ? 'ORG' : 'BRANCH';

  const assignment = await RoleAssignment.create({
    id,
    userId,
    roleKey: normalizedRole,
    roleLevel,
    scopeType: normalizedScope,
    scopeId: scopeId || null,
    status: overrides.status || 'ACTIVE',
    ...overrides,
  });

  if (branchIds && branchIds.length > 0 && RoleAssignmentBranch) {
    const links = branchIds.map((bId) => ({
      assignmentId: assignment.id,
      branchId: bId,
    }));
    await RoleAssignmentBranch.bulkCreate(links);
  }

  // Also sync to UserOrgIndex if platform model is available
  try {
    const tenantId = overrides.tenantId || (tenantDb.tenantId);
    if (tenantId && userId) {
      await UserOrgIndex.findOrCreate({
        where: { userId, tenantId },
        defaults: {
          id: uuidv4(),
          userId,
          tenantId,
          roleKey,
          status: 'ACTIVE',
        },
      });
    }
  } catch (_) {
    // Non-fatal
  }

  return assignment;
}

/**
 * Creates a Payment in tenant DB
 */
async function createPayment(tenantDb, branchId, overrides = {}) {
  const id = overrides.id || uuidv4();
  const PaymentModel = tenantDb.models ? tenantDb.models.Payment : tenantDb.Payment;

  return PaymentModel.create({
    id,
    userId: overrides.userId || uuidv4(),
    branchId,
    amount: overrides.amount !== undefined ? overrides.amount : 5000.00,
    currency: overrides.currency || 'PKR',
    method: overrides.method || overrides.paymentMethod || 'CASH',
    paymentFor: overrides.paymentFor || 'MEMBERSHIP',
    status: overrides.status || 'COMPLETED',
    businessDate: overrides.businessDate || new Date().toISOString().slice(0, 10),
    idempotencyKey: overrides.idempotencyKey || uuidv4(),
    paidAt: overrides.paidAt || new Date(),
    ...overrides,
  });
}

module.exports = {
  createUser,
  createBillingPlan,
  createTenant,
  createGymListing,
  createBranch,
  createTenantSubscription,
  createRoleAssignment,
  createPayment,
};
