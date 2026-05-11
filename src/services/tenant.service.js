const crypto = require('crypto');
const { Tenant, User, PlatformPackage, City } = require('../models/platform');
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
const registerTenant = async ({ userId, businessName, email, phone, cityId }) => {
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
    ownerUserId: userId,
    status: TenantStatus.PENDING_REVIEW,
    kycStatus: KycStatus.NOT_SUBMITTED,
    onboardingStep: 1,
  });

  // Upgrade user role to GYM_HOST
  await User.update({ role: UserRole.GYM_HOST }, { where: { id: userId } });

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

  if (![TenantStatus.PENDING_REVIEW, TenantStatus.UNDER_REVIEW].includes(tenant.status)) {
    throw createError('Gym profile cannot be updated at this stage', 400);
  }

  const { gymName, gymDescription, genderType, address, kycDocumentsJson, logoUrl, coverImageUrl } = profileData;

  await tenant.update({
    gymName: gymName || tenant.gymName,
    gymDescription: gymDescription !== undefined ? gymDescription : tenant.gymDescription,
    genderType: genderType || tenant.genderType,
    address: address !== undefined ? address : tenant.address,
    kycDocumentsJson: kycDocumentsJson || tenant.kycDocumentsJson,
    logoUrl: logoUrl || tenant.logoUrl,
    coverImageUrl: coverImageUrl || tenant.coverImageUrl,
    kycStatus: KycStatus.PENDING,
    onboardingStep: Math.max(tenant.onboardingStep, 2),
  });

  return { tenant };
};

// ── selectPackage ─────────────────────────────────────────────────────────────
/**
 * Host selects a SaaS package (step 3 of onboarding).
 * The package will be activated when the tenant is approved and provisioned.
 */
const selectPackage = async (tenantId, userId, packageId) => {
  const tenant = await Tenant.findOne({ where: { id: tenantId, ownerUserId: userId } });
  if (!tenant) throw createError('Tenant not found or access denied', 404);

  if (![TenantStatus.PENDING_REVIEW, TenantStatus.UNDER_REVIEW].includes(tenant.status)) {
    throw createError('Package cannot be changed at this stage', 400);
  }

  const pkg = await PlatformPackage.findOne({ where: { id: packageId, status: 'ACTIVE' } });
  if (!pkg) throw createError('Package not found or is not available', 404);

  await tenant.update({
    selectedPackageId: packageId,
    onboardingStep: Math.max(tenant.onboardingStep, 3),
  });

  return { tenant, package: pkg };
};

// ── getMyTenant ───────────────────────────────────────────────────────────────
/**
 * Returns the tenant owned by the authenticated GYM_HOST.
 */
const getMyTenant = async (userId) => {
  const tenant = await Tenant.findOne({
    where: { ownerUserId: userId },
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
    ],
  });
  if (!tenant) throw createError('No gym business registered for this account', 404);
  return { tenant };
};

module.exports = { registerTenant, submitGymProfile, selectPackage, getMyTenant };
