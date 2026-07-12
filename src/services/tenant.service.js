const crypto = require('crypto');
const { Tenant, User, PlatformPackage, City, TenantSubscription } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const { TenantStatus, KycStatus } = require('../constants/subscription-status');
const { UserRole } = require('../constants/roles');

/**
 * Generate a unique tenant code in the format GYM-XXXXXX (uppercase alphanumeric).
 */
const _generateTenantCode = () => {
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `GYM-${suffix}`;
};

/**
 * Ensure the generated tenant code is actually unique in the DB.
 */
const _uniqueTenantCode = async () => {
  let code;
  let attempts = 0;
  do {
    code = _generateTenantCode();
    // eslint-disable-next-line no-await-in-loop
    const existing = await Tenant.findOne({ where: { tenantCode: code } });
    if (!existing) return code;
    attempts++;
  } while (attempts < 10);
  throw new Error('Failed to generate unique tenant code after 10 attempts');
};

// ── registerTenant ────────────────────────────────────────────────────────────
/**
 * A verified user registers as a GYM_HOST.
 * Creates a Tenant record (PENDING_REVIEW) and upgrades the user's role.
 */
const registerTenant = async ({ userId, businessName, email, phone, cityId, areaId }) => {
  // Each user may own only one tenant (prevent duplicates)
  const existing = await Tenant.findOne({ where: { ownerUserId: userId } });
  if (existing) throw createError('You have already registered a gym business', 409);

  const tenantCode = await _uniqueTenantCode();

  const tenant = await Tenant.create({
    tenantCode,
    businessName,
    email,
    phone: phone || null,
    cityId: cityId || null,
    areaId: areaId || null,
    ownerUserId: userId,
    status: TenantStatus.DRAFT,
    kycStatus: KycStatus.NOT_SUBMITTED,
    onboardingStep: 1,
  });

  // Upgrade user role to GYM_HOST and set isHost to true
  await User.update({ role: UserRole.GYM_HOST, isHost: true }, { where: { id: userId } });

  return { tenant };
};

// ── submitGymProfile ──────────────────────────────────────────────────────────
/**
 * Host submits gym profile details and KYC documents.
 * Moves the tenant to step 2 and sets kycStatus to PENDING.
 */
const submitGymProfile = async (tenantId, userId, profileData) => {
  const tenant = await Tenant.findOne({ where: { id: tenantId, ownerUserId: userId } });
  if (!tenant) throw createError('Tenant not found or access denied', 404);

  if (![TenantStatus.DRAFT, TenantStatus.PENDING_REVIEW, TenantStatus.UNDER_REVIEW].includes(tenant.status)) {
    throw createError('Gym profile cannot be updated at this stage', 400);
  }

  const { gymName, gymDescription, genderType, address, latitude, longitude, mainBranchData, kycDocumentsJson, logoUrl, coverImageUrl } = profileData;

  await tenant.update({
    gymName: gymName || tenant.gymName,
    gymDescription: gymDescription !== undefined ? gymDescription : tenant.gymDescription,
    genderType: genderType || tenant.genderType,
    address: address !== undefined ? address : tenant.address,
    latitude: latitude !== undefined ? latitude : tenant.latitude,
    longitude: longitude !== undefined ? longitude : tenant.longitude,
    mainBranchDataJson: mainBranchData !== undefined ? mainBranchData : tenant.mainBranchDataJson,
    kycDocumentsJson: kycDocumentsJson || tenant.kycDocumentsJson,
    logoUrl: logoUrl || tenant.logoUrl,
    coverImageUrl: coverImageUrl || tenant.coverImageUrl,
    kycStatus: KycStatus.PENDING,
    onboardingStep: Math.max(tenant.onboardingStep, (address !== undefined || mainBranchData !== undefined) ? 3 : 2),
  });

  return { tenant };
};

// ── selectPackage ─────────────────────────────────────────────────────────────
/**
 * Host selects or changes their SaaS package.
 * Allowed during onboarding and for active tenants wanting to upgrade/downgrade.
 */
const selectPackage = async (tenantId, userId, packageId) => {
  const tenant = await Tenant.findOne({ where: { id: tenantId, ownerUserId: userId } });
  if (!tenant) throw createError('Tenant not found or access denied', 404);

  const allowedStatuses = [
    TenantStatus.DRAFT,
    TenantStatus.PENDING_REVIEW,
    TenantStatus.UNDER_REVIEW,
    TenantStatus.ACTIVE,
  ];
  if (!allowedStatuses.includes(tenant.status)) {
    throw createError('Package cannot be changed at this stage', 400);
  }

  const pkg = await PlatformPackage.findOne({ where: { id: packageId, status: 'ACTIVE' } });
  if (!pkg) throw createError('Package not found or is not available', 404);

  await tenant.update({
    selectedPackageId: packageId,
    onboardingStep: Math.max(tenant.onboardingStep, 4),
  });

  return { tenant, package: pkg };
};

// ── updateMyTenant ────────────────────────────────────────────────────────────
/**
 * Host updates their business contact info (businessName, email, phone, cityId).
 */
const updateMyTenant = async (userId, updates) => {
  const tenant = await Tenant.findOne({
    where: { ownerUserId: userId },
    include: [{ model: City, as: 'city', attributes: ['id', 'name'] }],
  });
  if (!tenant) throw createError('No gym business registered for this account', 404);

  const { businessName, email, phone, cityId } = updates;
  await tenant.update({
    ...(businessName !== undefined && { businessName }),
    ...(email !== undefined && { email }),
    ...(phone !== undefined && { phone }),
    ...(cityId !== undefined && { cityId }),
  });

  await tenant.reload({ include: [{ model: City, as: 'city', attributes: ['id', 'name'] }] });
  return { tenant };
};

// ── finalizeApplication ───────────────────────────────────────────────────────
/**
 * Called when the gym owner completes the payment step during onboarding.
 * Saves payment method + bank reference and creates a pending TenantSubscription.
 */
const finalizeApplication = async (tenantId, userId, { paymentMethod, bankTransferRef }) => {
  const tenant = await Tenant.findOne({ where: { id: tenantId, ownerUserId: userId } });
  if (!tenant) throw createError('Tenant not found or access denied', 404);

  await tenant.update({
    paymentMethod: paymentMethod || 'BANK_TRANSFER',
    bankTransferRef: bankTransferRef || null,
    status: TenantStatus.PENDING_REVIEW,
    onboardingStep: 5,
  });

  if (tenant.selectedPackageId) {
    const existingSub = await TenantSubscription.findOne({ where: { tenantId: tenant.id } });
    if (!existingSub) {
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
          bankTransferRef: bankTransferRef || null,
        });
      }
    }
  }

  await tenant.reload();
  return { tenant };
};

// ── getMyTenant ───────────────────────────────────────────────────────────────
/**
 * Returns the tenant owned by the authenticated GYM_HOST, including subscription.
 */
const getMyTenant = async (userId) => {
  const tenant = await Tenant.findOne({
    where: { ownerUserId: userId },
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: PlatformPackage, as: 'selectedPackage', required: false },
    ],
  });
  if (!tenant) throw createError('No gym business registered for this account', 404);

  const subscription = await TenantSubscription.findOne({
    where: { tenantId: tenant.id },
    order: [['created_at', 'DESC']],
    include: [{ model: PlatformPackage, as: 'package', required: false }],
  });

  return { tenant, subscription };
};

module.exports = { registerTenant, submitGymProfile, selectPackage, finalizeApplication, getMyTenant, updateMyTenant };
