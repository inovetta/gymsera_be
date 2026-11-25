const { Tenant, User, PlatformPackage, City, TenantSubscription, PlatformAuditLog } = require('../models/platform');
const kycStorageService = require('./kyc-storage.service');
const { createError } = require('../utils/response.utils');
const { assertAreaInCity } = require('./places.service');
const branchHours = require('./branch-hours.service');
const areaRequests = require('./area-requests.service');
const { validateBrandName } = require('./brand-name.service');
const { TenantStatus, KycStatus } = require('../constants/subscription-status');
const { UserRole } = require('../constants/roles');

/** The organization code (one generator, R-120 NEW-307): `ORG-` + 8 uppercase hex characters. */
const _generateTenantCode = () => require('../utils/organization-code.utils').generateOrganizationCode();

/**
 * Ensure the generated tenant code is actually unique in the DB.
 */
const _uniqueTenantCode = async () => {
  let code;
  let attempts = 0;
  do {
    code = _generateTenantCode();
     
    const existing = await Tenant.findOne({ where: { organizationCode: code } });
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
const registerTenant = async ({ userId, organizationName, email, phone, cityId, areaId, areaRequestId }) => {
  // Each user may own only one tenant (prevent duplicates)
  const existing = await Tenant.findOne({ where: { ownerUserId: userId } });
  if (existing) throw createError('You have already registered a gym business', 409);
  // NEW-259: a real area belongs to the city. NEW-265 (A4): or a pending area request of this person.
  const choice = await areaRequests.resolveAreaChoice(areaRequests.parseAreaChoice({ areaId, areaRequestId }), {
    cityId, userId, organizationId: null,
  });
  const area = areaRequests.rowValues(choice) || { areaId: null, areaStatus: null, areaRequestId: null };

  const organizationCode = await _uniqueTenantCode();

  const tenant = await Tenant.create({
    organizationCode,
    // R-112 (C2): build 26 sends no name here (the column is NOT NULL); Step 2 saves the brand.
    organizationName: organizationName || '',
    email,
    phone: phone || null,
    cityId: cityId || null,
    ...area,
    ownerUserId: userId,
    status: TenantStatus.DRAFT,
    kycStatus: KycStatus.NOT_SUBMITTED,
    onboardingStep: 1,
  });
  await areaRequests.applyChoiceToLink(choice, { organizationId: tenant.id, target: 'organization', targetId: tenant.id });

  // Upgrade user role to GYM_HOST and set isHost to true. This is an account flag
  // (the host area, onboarding routes). It grants nothing inside any tenant:
  // tenantContext honours it only in the tenant this user owns (NEW-108).
  await User.update({ role: UserRole.GYM_HOST, isHost: true }, { where: { id: userId } });

  return { tenant };
};

// ── submitGymProfile ──────────────────────────────────────────────────────────
/**
 * Host submits gym profile details and KYC documents.
 * Moves the tenant to step 2 and sets kycStatus to PENDING.
 */
const submitGymProfile = async (organizationId, userId, profileData) => {
  const tenant = await Tenant.findOne({ where: { id: organizationId, ownerUserId: userId } });
  if (!tenant) throw createError('Tenant not found or access denied', 404);

  if (![TenantStatus.DRAFT, TenantStatus.PENDING_REVIEW, TenantStatus.UNDER_REVIEW].includes(tenant.status)) {
    throw createError('Gym profile cannot be updated at this stage', 400);
  }

  const { firstBusinessName, firstBusinessDescription, firstBranch } = profileData;
  const { address, latitude, longitude } = firstBranch;
  const firstBranchDraft = {
    ...firstBranch,
    name: firstBranch.branchName,
    plans: firstBranch.packages,
    ...(firstBranch.googlePlaceId && { placeId: firstBranch.googlePlaceId }),
    ...(firstBranch.hours && { hoursJson: firstBranch.hours }),
    facilitiesJson: firstBranch.facilitiesJson || firstBranch.facilities || null,
  };
  // R-112 (C1, C3): the brand the host typed on Step 2, checked before anything is saved.
  const organizationName = profileData.organizationName !== undefined ? await validateBrandName(profileData.organizationName) : undefined;

  let existingMainBranch = tenant.firstBranchDraft;
  if (typeof existingMainBranch === 'string') {
    try { existingMainBranch = JSON.parse(existingMainBranch); } catch (e) { existingMainBranch = {}; }
  }
  const mergedMainBranchData = firstBranchDraft !== undefined ? {
    ...(existingMainBranch || {}),
    ...firstBranchDraft,
  } : tenant.firstBranchDraft;

  // R-113 H4 / H5: the draft first branch's week (`firstBranchDraft.hoursJson`, Become a Host), checked and
  // stored with its summary pair; an older build's pair follows the same old-client rules as a branch.
  if (firstBranchDraft && typeof firstBranchDraft === 'object' && mergedMainBranchData && typeof mergedMainBranchData === 'object') {
    const has = (k) => Object.prototype.hasOwnProperty.call(firstBranchDraft, k);
    if (has('hoursJson') || has('openingTime') || has('closingTime')) {
      const stored = existingMainBranch || {};
      const hm = (t) => (typeof t === 'string' && t ? t.slice(0, 5) : null);
      const body = has('hoursJson')
        ? { hours: firstBranchDraft.hoursJson, ...(has('openingTime') && { openingTime: firstBranchDraft.openingTime }), ...(has('closingTime') && { closingTime: firstBranchDraft.closingTime }) }
        : { ...(has('openingTime') && { openingTime: firstBranchDraft.openingTime }), ...(has('closingTime') && { closingTime: firstBranchDraft.closingTime }) };
      const values = branchHours.resolveWrite(body, { hoursJson: stored.hoursJson || null, openingTime: hm(stored.openingTime), closingTime: hm(stored.closingTime) });
      const next = values || { hoursJson: stored.hoursJson || null, openingTime: stored.openingTime || null, closingTime: stored.closingTime || null };
      mergedMainBranchData.hoursJson = next.hoursJson;
      mergedMainBranchData.openingTime = next.openingTime;
      mergedMainBranchData.closingTime = next.closingTime;
    }
  }

  // NEW-265 (A4, R-109 F1): the draft first branch's area. A key not sent keeps the stored area or
  // request; `areaId: null` / `areaRequestId: null` or a new real area clears the request.
  const branchChoice = firstBranchDraft && typeof firstBranchDraft === 'object'
    ? areaRequests.parseAreaChoice(firstBranchDraft)
    : { kind: 'keep' };
  const branchCityId = mergedMainBranchData && mergedMainBranchData.cityId ? mergedMainBranchData.cityId : tenant.cityId;
  let resolvedBranchChoice = { kind: 'keep' };
  if (branchChoice.kind !== 'keep') {
    resolvedBranchChoice = await areaRequests.resolveAreaChoice(branchChoice, { cityId: branchCityId, userId, organizationId: tenant.id });
    const values = areaRequests.rowValues(resolvedBranchChoice);
    mergedMainBranchData.areaId = values.areaId;
    if (values.areaRequestId) {
      mergedMainBranchData.areaRequestId = values.areaRequestId;
      mergedMainBranchData.areaStatus = values.areaStatus;
    } else {
      delete mergedMainBranchData.areaRequestId;
      delete mergedMainBranchData.areaStatus;
    }
  } else if (firstBranchDraft && firstBranchDraft.cityId !== undefined) {
    // NEW-259: the main branch's area belongs to its city (the branch's, else the business's).
    await assertAreaInCity({ cityId: branchCityId, areaId: mergedMainBranchData.areaId });
    await areaRequests.assertKeptLinkInCity({ organizationId: tenant.id, target: 'first_branch_draft', targetId: tenant.id, cityId: branchCityId });
  }
  if (mergedMainBranchData && typeof mergedMainBranchData === 'object') delete mergedMainBranchData.pendingArea; // a read-only view

  // R-112 (C3): the draft first branch is named after the gym; a new gym name carries over unless the host
  // gave the branch a name of its own.
  let mainBranchDataToSave = mergedMainBranchData;
  if (firstBusinessName && firstBusinessName !== tenant.firstBusinessName && mergedMainBranchData && typeof mergedMainBranchData === 'object') {
    const branchName = typeof mergedMainBranchData.name === 'string' ? mergedMainBranchData.name.trim() : '';
    if (!branchName || branchName === tenant.firstBusinessName) mainBranchDataToSave = { ...mergedMainBranchData, name: firstBusinessName };
  }

  await tenant.update({
    ...(organizationName !== undefined && { organizationName }),
    firstBusinessName: firstBusinessName || tenant.firstBusinessName,
    firstBusinessDescription: firstBusinessDescription !== undefined ? firstBusinessDescription : tenant.firstBusinessDescription,
    genderType: tenant.genderType,
    address: address !== undefined ? address : tenant.address,
    latitude: latitude !== undefined ? latitude : tenant.latitude,
    longitude: longitude !== undefined ? longitude : tenant.longitude,
    firstBranchDraft: mainBranchDataToSave,
    firstBranchCurrency: firstBranch.currency || tenant.firstBranchCurrency,
    kycStatus: KycStatus.PENDING,
    onboardingStep: Math.max(tenant.onboardingStep, (address !== undefined || firstBranchDraft !== undefined) ? 3 : 2),
  });
  await areaRequests.applyChoiceToLink(resolvedBranchChoice, { organizationId: tenant.id, target: 'first_branch_draft', targetId: tenant.id });

  return { tenant };
};

// ── selectPackage ─────────────────────────────────────────────────────────────
/**
 * Host selects or changes their SaaS package.
 * Allowed during onboarding and for active tenants wanting to upgrade/downgrade.
 */
const selectPackage = async (organizationId, userId, packageId) => {
  const tenant = await Tenant.findOne({ where: { id: organizationId, ownerUserId: userId } });
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
 * Host updates their business contact info (organizationName, email, phone, cityId).
 */
const updateMyTenant = async (userId, updates) => {
  const tenant = await Tenant.findOne({
    where: { ownerUserId: userId },
    include: [{ model: City, as: 'city', attributes: ['id', 'name'] }],
  });
  if (!tenant) throw createError('No gym business registered for this account', 404);

  // NEW-265 (A4, R-109 F3, R-111): the first-branch default area while the application is a draft or in review
  // ("Choose your area again"). After approval it only matters as a fallback (A9 rule 3): refused.
  const sendsArea = updates.areaId !== undefined || updates.areaRequestId !== undefined;
  if (sendsArea && tenant.status === TenantStatus.ACTIVE) {
    throw createError('The organisation\'s area cannot be changed after approval. Change each branch\'s area instead.', 422, 'area_change_not_allowed');
  }
  if (sendsArea && [TenantStatus.DRAFT, TenantStatus.PENDING_REVIEW].includes(tenant.status)) {
    const choice = await areaRequests.resolveAreaChoice(areaRequests.parseAreaChoice(updates), {
      cityId: tenant.cityId, userId, organizationId: tenant.id,
    });
    const values = areaRequests.rowValues(choice);
    if (values) await tenant.update(values); // the other fields stay ACTIVE-only, as before
    await areaRequests.applyChoiceToLink(choice, { organizationId: tenant.id, target: 'organization', targetId: tenant.id });
    await tenant.reload({ include: [{ model: City, as: 'city', attributes: ['id', 'name'] }] });
    return { tenant };
  }

  if (tenant.status !== TenantStatus.ACTIVE) {
    throw createError('Tenant not found or not active', 404);
  }

  const { email, phone, cityId } = updates;
  // R-112 (C4): the brand follows the Step 2 rules (C1); a change is audited. The stored name sent back
  // unchanged is not re-checked (C7: an older name must not block editing the other fields).
  const unchangedBrand = typeof updates.organizationName === 'string'
    && areaRequests.cleanAreaName(updates.organizationName) === (tenant.organizationName || '').trim();
  const organizationName = updates.organizationName !== undefined && !unchangedBrand
    ? await validateBrandName(updates.organizationName)
    : undefined;
  const previousBusinessName = tenant.organizationName;
  await tenant.update({
    ...(organizationName !== undefined && { organizationName }),
    ...(email !== undefined && { email }),
    ...(phone !== undefined && { phone }),
    ...(cityId !== undefined && { cityId }),
  });
  if (organizationName !== undefined && organizationName !== previousBusinessName) {
    await PlatformAuditLog.create({
      actorUserId: userId,
      action: 'tenant.brand_renamed',
      targetType: 'tenant',
      targetId: tenant.id,
      details: { from: previousBusinessName, to: organizationName },
      createdAt: new Date(),
    });
  }

  await tenant.reload({ include: [{ model: City, as: 'city', attributes: ['id', 'name'] }] });
  return { tenant };
};

// ── reapplyTenant (FLOW-04) ───────────────────────────────────────────────────
/**
 * A rejected host opens the SAME application again to fix it and resubmit (no second tenant: registerTenant refuses
 * one per owner). REJECTED → DRAFT; every field the host entered stays. The rejection reason and date stay on the
 * record so the screens can keep showing what to fix until the next review replaces them. KYC files are kept unless
 * the 90-day retention sweep (R-16) already removed them, in which case the host uploads them again.
 * Only the owner, only from REJECTED; the next step is the ordinary gym-profile → finalize path.
 */
const reapplyTenant = async (organizationId, userId) => {
  const tenant = await Tenant.findOne({ where: { id: organizationId, ownerUserId: userId } });
  if (!tenant) throw createError('Tenant not found or access denied', 404);
  if (tenant.status !== TenantStatus.REJECTED) {
    const err = createError('Only a rejected application can be reopened.', 409);
    err.code = 'not_rejected';
    throw err;
  }

  const hasDocuments = kycStorageService.normalizeKycDocuments(tenant.kycDocumentsJson).length > 0;

  await tenant.update({
    status: TenantStatus.DRAFT,
    // PENDING (not REJECTED) so the retention sweep, which looks for REJECTED, leaves a reopened application alone.
    kycStatus: hasDocuments ? KycStatus.PENDING : KycStatus.NOT_SUBMITTED,
    onboardingStep: Math.min(Math.max(tenant.onboardingStep || 1, 2), 4),
  });

  try {
    await PlatformAuditLog.create({
      actorUserId: userId,
      action: 'tenant.reapplied',
      targetType: 'tenant',
      targetId: tenant.id,
      details: { previousRejectedAt: tenant.rejectedAt, kycDocumentsKept: hasDocuments },
      createdAt: new Date(),
    });
  } catch (auditErr) {
    console.warn('[Tenant:Audit] Failed to record re-application:', auditErr.message);
  }

  return { tenant };
};

/**
 * The membership plans the host entered for the main branch during onboarding
 * (`firstBranchDraft.plans`, older drafts `.packages`), or null. Submitting needs at
 * least one; host-status.service.js uses the same rule for "listing complete".
 */
const mainBranchPlans = (tenant) => {
  let mainBranch = tenant.firstBranchDraft;
  if (typeof mainBranch === 'string') {
    try { mainBranch = JSON.parse(mainBranch); } catch (e) { mainBranch = {}; }
  }
  if (mainBranch && Array.isArray(mainBranch.plans)) return mainBranch.plans;
  if (mainBranch && Array.isArray(mainBranch.packages)) return mainBranch.packages;
  return null;
};

// ── finalizeApplication ───────────────────────────────────────────────────────
/**
 * Called when the gym owner completes the payment step during onboarding.
 * Saves payment method + bank reference and creates a pending TenantSubscription.
 */
const finalizeApplication = async (organizationId, userId, { paymentMethod, bankTransferRef }) => {
  const tenant = await Tenant.findOne({ where: { id: organizationId, ownerUserId: userId } });
  if (!tenant) throw createError('Tenant not found or access denied', 404);

  // Validate that the main branch has at least 1 membership plan configured
  const plans = mainBranchPlans(tenant);

  if (!plans || plans.length === 0) {
    throw createError('At least 1 membership plan is required before completing listing and submitting for review.', 400);
  }
  // BUG-05: the approved branch would be hidden from travellers. Provisioning treats a plan
  // without isPublic as visible (tenant-provisioning.service.js), so the same rule applies here.
  if (!plans.some((p) => p && p.isPublic !== false)) {
    throw createError('Show at least one plan to travellers before you submit.', 422, 'visible_plan_required');
  }

  await tenant.update({
    paymentMethod: paymentMethod || 'BANK_TRANSFER',
    bankTransferRef: bankTransferRef || null,
    status: TenantStatus.PENDING_REVIEW,
    onboardingStep: 5,
  });

  // Create unified Admin notification
  try {
    const { User } = require('../models/platform');
    const notificationsService = require('./notifications.service');
    const hostUser = await User.findByPk(userId);
    const hostName = hostUser ? hostUser.fullName : 'Host';

    const admins = await User.findAll({ where: { role: 'PLATFORM_ADMIN' } });
    for (const admin of admins) {
      await notificationsService.createNotification({
        userId: admin.id,
        role: 'admin',
        type: 'tenant_submitted_review',
        title: 'New Organization Submitted',
        message: `New organization pending review: ${tenant.firstBusinessName || tenant.organizationName} (Host: ${hostName}).`,
        deepLink: `/admin/organizations/${tenant.id}`,
        metadataJson: { organizationId: tenant.id },
      });
    }
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create tenant review notification:', notifErr.message);
  }

  // "Pay later" gets no plan at submission: approval gives it a time-limited
  // GRACE plan instead (BILL-13, subscription-migration.service.js#startPayLaterGrace).
  // It used to get an ACTIVE plan for the whole package cycle here, unpaid.
  if (tenant.selectedPackageId && tenant.paymentMethod !== 'PAY_LATER') {
    const existingSub = await TenantSubscription.findOne({ where: { organizationId: tenant.id } });
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
          organizationId: tenant.id,
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
    where: { organizationId: tenant.id },
    order: [['created_at', 'DESC']],
    include: [{ model: PlatformPackage, as: 'package', required: false }],
  });

  return { tenant, subscription };
};

/**
 * Uploads KYC documents to private storage and updates tenant record (SEC-10).
 */
const uploadKycDocuments = async ({ organizationId, userId, userRole, files, documentType }) => {
  const tenant = await Tenant.findByPk(organizationId);
  if (!tenant) throw createError('Tenant not found', 404);

  // Authorization: must be the tenant owner or PLATFORM_ADMIN
  if (tenant.ownerUserId !== userId && userRole !== UserRole.PLATFORM_ADMIN) {
    throw createError('Access denied: only tenant owner or platform admin can upload KYC documents', 403);
  }

  if (!files || files.length === 0) {
    throw createError('At least one document file is required', 422);
  }

  const newDocs = [];
  for (const file of files) {
    const docDescriptor = await kycStorageService.uploadKycDocument({
      buffer: file.buffer,
      mimetype: file.mimetype,
      organizationId,
      originalName: file.originalname,
      documentType,
    });
    newDocs.push(docDescriptor);
  }

  const existingDocs = kycStorageService.normalizeKycDocuments(tenant.kycDocumentsJson);
  const updatedDocs = [...existingDocs, ...newDocs];

  const updateFields = {
    kycDocumentsJson: updatedDocs,
  };

  if (tenant.kycStatus === KycStatus.NOT_SUBMITTED) {
    updateFields.kycStatus = KycStatus.PENDING;
  }

  await tenant.update(updateFields);

  // Audit log
  await PlatformAuditLog.create({
    actorUserId: userId,
    action: 'KYC_DOCUMENT_UPLOADED',
    targetType: 'Tenant',
    targetId: tenant.id,
    details: {
      uploadedCount: newDocs.length,
      documentIds: newDocs.map((d) => d.documentId),
      filenames: newDocs.map((d) => d.originalName),
    },
    createdAt: new Date(),
  });

  return newDocs;
};

/**
 * Lists KYC documents for a tenant with secure stream URLs.
 */
const getKycDocuments = async ({ organizationId, userId, userRole }) => {
  const tenant = await Tenant.findByPk(organizationId);
  if (!tenant) throw createError('Tenant not found', 404);

  // Authorization: must be the tenant owner or PLATFORM_ADMIN
  if (tenant.ownerUserId !== userId && userRole !== UserRole.PLATFORM_ADMIN) {
    throw createError('Access denied: only tenant owner or platform admin can view KYC documents', 403);
  }

  const docs = kycStorageService.normalizeKycDocuments(tenant.kycDocumentsJson);

  return docs.map((doc) => ({
    documentId: doc.documentId,
    originalName: doc.originalName,
    mimetype: doc.mimetype,
    size: doc.size,
    documentType: doc.documentType,
    uploadedAt: doc.uploadedAt,
    streamUrl: `/api/v1/organizations/${tenant.id}/kyc-documents/${doc.documentId}/stream`,
  }));
};

/**
 * Streams a private KYC document with access audit logging (SEC-10).
 */
const getKycDocumentStream = async ({ organizationId, documentId, userId, userRole, reqInfo }) => {
  const tenant = await Tenant.findByPk(organizationId);
  if (!tenant) throw createError('Tenant not found', 404);

  // Authorization: must be the tenant owner or PLATFORM_ADMIN
  if (tenant.ownerUserId !== userId && userRole !== UserRole.PLATFORM_ADMIN) {
    throw createError('Access denied: only tenant owner or platform admin can access KYC documents', 403);
  }

  const docs = kycStorageService.normalizeKycDocuments(tenant.kycDocumentsJson);
  const doc = docs.find((d) => d.documentId === documentId);
  if (!doc) throw createError('KYC document not found', 404);

  // Audit access in PlatformAuditLog
  await PlatformAuditLog.create({
    actorUserId: userId,
    action: 'KYC_DOCUMENT_ACCESSED',
    targetType: 'Tenant',
    targetId: tenant.id,
    details: {
      documentId: doc.documentId,
      originalName: doc.originalName,
      mimetype: doc.mimetype,
      size: doc.size,
      ip: reqInfo?.ip,
      userAgent: reqInfo?.userAgent,
      isPlatformAdmin: userRole === UserRole.PLATFORM_ADMIN,
    },
    createdAt: new Date(),
  });

  const { stream, contentType, contentLength } = await kycStorageService.getKycStream(doc.key);
  return { stream, doc, contentType: doc.mimetype || contentType || 'application/octet-stream', contentLength };
};

/**
 * Deletes a KYC document from storage and tenant record.
 */
const deleteKycDocument = async ({ organizationId, documentId, userId, userRole }) => {
  const tenant = await Tenant.findByPk(organizationId);
  if (!tenant) throw createError('Tenant not found', 404);

  if (tenant.ownerUserId !== userId && userRole !== UserRole.PLATFORM_ADMIN) {
    throw createError('Access denied: only tenant owner or platform admin can delete KYC documents', 403);
  }

  const docs = kycStorageService.normalizeKycDocuments(tenant.kycDocumentsJson);
  const doc = docs.find((d) => d.documentId === documentId);
  if (!doc) throw createError('KYC document not found', 404);

  await kycStorageService.deleteKycFile(doc.key);

  const updatedDocs = docs.filter((d) => d.documentId !== documentId);
  await tenant.update({
    kycDocumentsJson: updatedDocs.length > 0 ? updatedDocs : null,
  });

  await PlatformAuditLog.create({
    actorUserId: userId,
    action: 'KYC_DOCUMENT_DELETED',
    targetType: 'Tenant',
    targetId: tenant.id,
    details: {
      documentId: doc.documentId,
      originalName: doc.originalName,
    },
    createdAt: new Date(),
  });

  return { remainingCount: updatedDocs.length };
};

module.exports = {
  reapplyTenant,
  registerTenant,
  submitGymProfile,
  selectPackage,
  finalizeApplication,
  mainBranchPlans,
  getMyTenant,
  updateMyTenant,
  uploadKycDocuments,
  getKycDocuments,
  getKycDocumentStream,
  deleteKycDocument,
};

