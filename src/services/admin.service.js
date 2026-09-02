const crypto = require('crypto');
const { Op, fn, col, literal } = require('sequelize');
const { Tenant, User, City, Area, PlatformPackage, GymListing, TenantSubscription, PlatformInvoice, UserGymMembership } = require('../models/platform');
const { createError, parsePagination, buildPagination } = require('../utils/response.utils');
const { TenantStatus, KycStatus } = require('../constants/subscription-status');
const { UserRole } = require('../constants/roles');
const { processTenantProvisioning } = require('./tenant-provisioning.service');
const emailService = require('./email.service');
const TenantDbManager = require('../database/TenantDbManager');
const { safeRedisDel } = require('../config/redis.config');

// ── createTenant (admin) ──────────────────────────────────────────────────────
const createTenant = async ({ ownerEmail, ownerFullName, ownerPhone, businessName, email, phone, cityId, packageId }) => {
  // Find existing user or create one
  let user = await User.findOne({ where: { email: ownerEmail.toLowerCase() } });
  if (!user) {
    const tempPassword = crypto.randomBytes(10).toString('hex');
    const bcrypt = require('bcrypt');
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    user = await User.create({
      fullName: ownerFullName,
      email: ownerEmail.toLowerCase(),
      phone: ownerPhone || null,
      passwordHash,
      role: UserRole.GYM_HOST,
      isVerified: true,
      status: 'ACTIVE',
    });
  } else {
    // Upgrade role if not already a host/admin
    if (user.role === 'MEMBER' || user.role === 'TRAINER') {
      await user.update({ role: UserRole.GYM_HOST });
    }
  }

  const existing = await Tenant.findOne({ where: { ownerUserId: user.id } });
  if (existing) throw createError('This user already owns a gym business', 409);

  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  const tenantCode = `GYM-${suffix}`;

  const tenant = await Tenant.create({
    tenantCode,
    businessName,
    email,
    phone: phone || null,
    cityId: cityId || null,
    ownerUserId: user.id,
    selectedPackageId: packageId || null,
    status: TenantStatus.PENDING_REVIEW,
    kycStatus: KycStatus.NOT_SUBMITTED,
    onboardingStep: 1,
  });

  return { tenant, user };
};

// ── listTenants ───────────────────────────────────────────────────────────────
const listTenants = async ({ status, page, limit, offset }) => {
  const tenantWhere = {};
  if (status) {
    if (!Object.values(TenantStatus).includes(status)) {
      throw createError(`Invalid status. Valid values: ${Object.values(TenantStatus).join(', ')}`, 400);
    }
    tenantWhere.status = status;
  }

  // 1. Fetch Tenants
  const tenants = await Tenant.findAll({
    where: tenantWhere,
    include: [
      { model: User, as: 'owner', attributes: ['id', 'fullName', 'email', 'phone'] },
      { model: City, as: 'city', attributes: ['id', 'name'] },
    ],
    order: [['createdAt', 'DESC']],
  });

  // 2. Fetch all GymListings that match the status filter
  const gymListingWhere = {};
  if (status) {
    if (status === 'PENDING_REVIEW') {
      gymListingWhere.status = 'PENDING';
    } else if (status === 'REJECTED') {
      gymListingWhere.status = 'REJECTED';
    } else if (status === 'ACTIVE') {
      gymListingWhere.status = 'ACTIVE';
    } else {
      // For other statuses (like UNDER_REVIEW, APPROVED, SUSPENDED), additional listings don't apply
      gymListingWhere.status = 'NONE';
    }
  } else {
    // If no status filter (All), fetch all except DRAFT/INACTIVE
    gymListingWhere.status = { [Op.in]: ['PENDING', 'REJECTED', 'ACTIVE'] };
  }

  const gymListings = await GymListing.findAll({
    where: gymListingWhere,
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: Tenant, as: 'tenant', include: [{ model: User, as: 'owner', attributes: ['id', 'fullName', 'email', 'phone'] }] },
    ],
    order: [['createdAt', 'DESC']],
  });

  // 3. Filter out the first (primary) gym listing for each tenant to avoid duplicates
  const additionalListings = [];
  for (const listing of gymListings) {
    if (!listing.tenant) continue;
    // Find all listings for this tenant to check if this one is the first
    const allTenantListings = await GymListing.findAll({
      where: { tenantId: listing.tenantId },
      order: [['createdAt', 'ASC']],
    });
    if (allTenantListings.length > 1 && allTenantListings[0].id !== listing.id) {
      additionalListings.push(listing);
    }
  }

  // 4. Synthesize Tenant-like objects for additional listings
  const synthesized = additionalListings.map((listing) => {
    const tenant = listing.tenant;
    return {
      id: `${tenant.id}:${listing.id}`, // Compound ID
      tenantCode: tenant.tenantCode,
      businessName: `${listing.title} (Additional Listing)`,
      ownerUserId: tenant.ownerUserId,
      email: tenant.email,
      phone: listing.contactPhone || tenant.phone,
      cityId: listing.cityId,
      status: listing.status === 'PENDING' ? 'PENDING_REVIEW' : (listing.status === 'REJECTED' ? 'REJECTED' : 'ACTIVE'),
      gymName: listing.title,
      gymDescription: listing.shortDescription,
      logoUrl: listing.logoUrl,
      coverImageUrl: listing.coverImageUrl,
      genderType: listing.genderType,
      createdAt: listing.createdAt,
      owner: tenant.owner,
      user: tenant.owner,
      city: listing.city,
      gymListing: {
        id: listing.id,
        tenantId: listing.tenantId,
        title: listing.title,
        averageRating: listing.averageRating,
        status: listing.status,
        isFeatured: listing.isFeatured,
      },
    };
  });

  // 5. Combine and sort by createdAt DESC
  const combined = [...tenants.map(t => t.toJSON()), ...synthesized];
  combined.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // 6. Paginate
  const count = combined.length;
  const paginated = combined.slice(offset, offset + limit);

  return { tenants: paginated, pagination: buildPagination(count, page, limit) };
};

// ── getTenant ─────────────────────────────────────────────────────────────────
const getTenant = async (tenantId) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];

  const tenant = await Tenant.findByPk(actualTenantId, {
    include: [
      { model: User, as: 'owner', attributes: ['id', 'fullName', 'email', 'phone', 'status', 'isVerified', 'createdAt'] },
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: PlatformPackage, as: 'selectedPackage', attributes: ['id', 'name', 'price', 'billingCycle', 'maxBranches', 'maxTrainers', 'maxMembers'] },
    ],
  });
  if (!tenant) throw createError('Tenant not found', 404);

  const tenantJson = tenant.toJSON();

  let gymListing;
  if (listingId) {
    gymListing = await GymListing.findByPk(listingId, {
      include: _getListingIncludes(),
    });
  } else {
    gymListing = await GymListing.findOne({
      where: { tenantId: actualTenantId },
      order: [['createdAt', 'ASC']],
      include: _getListingIncludes(),
    });
  }

  tenantJson.gymListing = gymListing ? gymListing.toJSON() : null;

  if (listingId && gymListing) {
    tenantJson.status = gymListing.status === 'PENDING' ? 'PENDING_REVIEW' : (gymListing.status === 'REJECTED' ? 'REJECTED' : 'ACTIVE');
    tenantJson.businessName = `${gymListing.title} (Additional Listing)`;
  }

  return { tenant: tenantJson };
};

// ── approveTenant ─────────────────────────────────────────────────────────────
/**
 * Admin approves a tenant — updates status to APPROVED, then provisions the
 * tenant database inline (synchronously). Running provisioning as part of the
 * request — rather than a queued job for a background worker — means this
 * works the same whether the API runs on Vercel serverless or a traditional
 * always-on server, with no dependency on a separate worker process.
 *
 * If provisioning fails partway, the tenant stays in APPROVED (not ACTIVE)
 * and re-calling approve safely retries it (CREATE DATABASE IF NOT EXISTS /
 * sync are idempotent).
 */
const approveTenant = async (tenantId, adminUserId) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];

  if (listingId) {
    const listing = await GymListing.findByPk(listingId);
    if (!listing) throw createError('Gym listing not found', 404);

    await listing.update({
      status: 'ACTIVE',
      rejectionReason: null,
      rejectedAt: null,
      rejectedBy: null,
    });

    return { tenant: { id: tenantId, status: 'ACTIVE' } };
  }

  const tenant = await Tenant.findByPk(actualTenantId, {
    include: [{ model: User, as: 'owner', attributes: ['id', 'fullName', 'email'] }],
  });
  if (!tenant) throw createError('Tenant not found', 404);

  const approvableStatuses = [TenantStatus.PENDING_REVIEW, TenantStatus.UNDER_REVIEW, TenantStatus.REJECTED, TenantStatus.APPROVED];
  if (!approvableStatuses.includes(tenant.status)) {
    throw createError('Tenant is not in a reviewable state', 400);
  }

  await tenant.update({
    status: TenantStatus.APPROVED,
    approvedAt: new Date(),
    approvedBy: adminUserId,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    kycStatus: KycStatus.APPROVED,
  });

  try {
    await processTenantProvisioning(tenant.id);
  } catch (err) {
    console.error(`[approveTenant] Provisioning failed for tenant ${tenant.id}:`, err.message);
    throw createError(`Tenant approved, but database provisioning failed: ${err.message}. Re-approve to retry.`, 502);
  }

  await tenant.reload();
  return { tenant };
};

// ── rejectTenant ──────────────────────────────────────────────────────────────
const rejectTenant = async (tenantId, adminUserId, reason) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];

  if (!reason || !reason.trim()) {
    throw createError('A rejection reason is required', 400);
  }

  if (listingId) {
    const listing = await GymListing.findByPk(listingId);
    if (!listing) throw createError('Gym listing not found', 404);

    await listing.update({
      status: 'REJECTED',
      rejectionReason: reason.trim(),
      rejectedAt: new Date(),
      rejectedBy: adminUserId,
    });

    return { tenant: { id: tenantId, status: 'REJECTED' } };
  }

  const tenant = await Tenant.findByPk(actualTenantId, {
    include: [{ model: User, as: 'owner', attributes: ['id', 'fullName', 'email'] }],
  });
  if (!tenant) throw createError('Tenant not found', 404);

  const rejectableStatuses = [TenantStatus.PENDING_REVIEW, TenantStatus.UNDER_REVIEW, TenantStatus.APPROVED, TenantStatus.ACTIVE];
  if (!rejectableStatuses.includes(tenant.status)) {
    throw createError('Tenant cannot be rejected from its current status', 400);
  }

  await tenant.update({
    status: TenantStatus.REJECTED,
    rejectedAt: new Date(),
    rejectedBy: adminUserId,
    rejectionReason: reason.trim(),
    kycStatus: KycStatus.REJECTED,
  });

  await safeRedisDel(`tenant:${actualTenantId}:connStr`);
  await TenantDbManager.release(actualTenantId).catch(() => {});

  // Notify the gym host — the rejection itself is already persisted above, so
  // a broken SMTP config must not surface as a failed request.
  if (tenant.owner) {
    try {
      await emailService.sendTenantRejectedEmail(
        tenant.owner.email,
        tenant.owner.fullName,
        tenant.businessName,
        reason.trim()
      );
    } catch (err) {
      console.error(`[rejectTenant] Failed to send rejection email for tenant ${tenant.id}:`, err.message);
    }
  }

  try {
    const notificationsService = require('./notifications.service');
    if (tenant.ownerUserId) {
      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'host_update',
        title: 'Host Application Rejected',
        message: `Your organization ${tenant.gymName || tenant.businessName} requires changes: ${reason.trim()}.`,
        deepLink: '/host/profile',
        metadataJson: { tenantId: tenant.id },
      });
    }
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create rejection notification:', notifErr.message);
  }

  return { tenant };
};

// ── suspendTenant ─────────────────────────────────────────────────────────────
const suspendTenant = async (tenantId, adminUserId, reason) => {
  const tenant = await Tenant.findByPk(tenantId, {
    include: [{ model: User, as: 'owner', attributes: ['id', 'fullName', 'email'] }],
  });
  if (!tenant) throw createError('Tenant not found', 404);

  if (tenant.status !== TenantStatus.ACTIVE) {
    throw createError('Only active tenants can be suspended', 400);
  }

  if (!reason || !reason.trim()) {
    throw createError('A suspension reason is required', 400);
  }

  await tenant.update({ status: TenantStatus.SUSPENDED });
  await safeRedisDel(`tenant:${tenantId}:connStr`);
  await TenantDbManager.release(tenantId).catch(() => {});

  return { tenant };
};

// ── reactivateTenant ──────────────────────────────────────────────────────────
const reactivateTenant = async (tenantId, adminUserId) => {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw createError('Tenant not found', 404);

  if (tenant.status !== TenantStatus.SUSPENDED) {
    throw createError('Only suspended tenants can be reactivated', 400);
  }

  await tenant.update({ status: TenantStatus.ACTIVE });
  await safeRedisDel(`tenant:${tenantId}:connStr`);
  return { tenant };
};

// ── helpers ───────────────────────────────────────────────────────────────────
const _getTenantDb = async (tenantId) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const tenant = await Tenant.findByPk(actualTenantId, {
    attributes: ['id', 'connectionStringEncrypted', 'status'],
  });
  if (!tenant) throw createError('Tenant not found', 404);
  if (!tenant.connectionStringEncrypted) throw createError('Tenant database is not provisioned yet', 422);
  return TenantDbManager.getConnection(actualTenantId, tenant.connectionStringEncrypted);
};

// ── getTenantBranches (admin) ─────────────────────────────────────────────────
const getTenantBranches = async (tenantId) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const { models } = await _getTenantDb(tenantId);
  
  const where = {};
  if (listingId) {
    where.gymListingId = listingId;
  }

  const branches = await models.Branch.findAll({
    where,
    include: [{ model: models.Gym, as: 'gym', attributes: ['id', 'name'] }],
    order: [['createdAt', 'DESC']],
  });
  return { branches };
};

// ── updateTenantBranchStatus (admin) ─────────────────────────────────────────
const updateTenantBranchStatus = async (tenantId, branchId, status) => {
  const { models } = await _getTenantDb(tenantId);
  const branch = await models.Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);
  await branch.update({ status });
  return { branch };
};

// ── getTenantMembers (admin) ──────────────────────────────────────────────────
const getTenantMembers = async (tenantId, { page = 1, limit = 20 } = {}) => {
  const offset = (page - 1) * limit;
  const { models } = await _getTenantDb(tenantId);

  const { count, rows: subscriptions } = await models.MemberSubscription.findAndCountAll({
    include: [
      { model: models.MembershipPlan, as: 'plan', attributes: ['id', 'name', 'durationType', 'durationValue'] },
      { model: models.Branch, as: 'branch', attributes: ['id', 'branchName'] },
    ],
    order: [['subscribedAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  // Resolve platform user details for all unique userIds
  const userIds = [...new Set(subscriptions.map((s) => s.userId))];
  const users = userIds.length
    ? await User.findAll({ where: { id: userIds }, attributes: ['id', 'fullName', 'email', 'phone', 'status', 'profileImageUrl'] })
    : [];
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  const members = subscriptions.map((s) => ({
    ...s.toJSON(),
    user: userMap[s.userId] || null,
  }));

  return { members, pagination: buildPagination(count, page, limit) };
};

// ── getTenantMembershipPlans (admin) ──────────────────────────────────────────
const getTenantMembershipPlans = async (tenantId) => {
  const { models } = await _getTenantDb(tenantId);
  const plans = await models.MembershipPlan.findAll({
    include: [{ model: models.Branch, as: 'branch', attributes: ['id', 'branchName'] }],
    order: [['createdAt', 'DESC']],
  });
  return { plans };
};

// ── uploadTenantLogo ──────────────────────────────────────────────────────────
const uploadTenantLogo = async (tenantId, fileBuffer, mimetype) => {
  const storageService = require('./storage.service');
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw createError('Tenant not found', 404);
  if (tenant.logoUrl) await storageService.deleteImage(tenant.logoUrl).catch(() => {});
  const logoUrl = await storageService.uploadImage(fileBuffer, mimetype, 'tenants/logos', `tenant-${tenantId}`);
  await tenant.update({ logoUrl });
  // Sync to gym listing if it exists
  const { GymListing: GL } = require('../models/platform');
  await GL.update({ logoUrl }, { where: { tenantId } });
  return { logoUrl };
};

// ── uploadTenantCover ─────────────────────────────────────────────────────────
const uploadTenantCover = async (tenantId, fileBuffer, mimetype) => {
  const storageService = require('./storage.service');
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw createError('Tenant not found', 404);
  if (tenant.coverImageUrl) await storageService.deleteImage(tenant.coverImageUrl).catch(() => {});
  const coverImageUrl = await storageService.uploadImage(fileBuffer, mimetype, 'tenants/covers', `tenant-${tenantId}`);
  await tenant.update({ coverImageUrl });
  const { GymListing: GL } = require('../models/platform');
  await GL.update({ coverImageUrl }, { where: { tenantId } });
  return { coverImageUrl };
};

// ── getTenantSubscriptions ────────────────────────────────────────────────────
const getTenantSubscriptions = async (tenantId) => {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw createError('Tenant not found', 404);

  const subscriptions = await TenantSubscription.findAll({
    where: { tenantId },
    include: [{ model: PlatformPackage, as: 'package', attributes: ['id', 'name', 'price', 'billingCycle', 'maxBranches', 'maxTrainers', 'maxMembers'] }],
    order: [['createdAt', 'DESC']],
  });
  return { subscriptions };
};

// ── assignTenantSubscription ──────────────────────────────────────────────────
const assignTenantSubscription = async (tenantId, { packageId, startDate, billingCycle, amount, autoRenew, createInvoice }, adminUserId) => {
  const tenant = await Tenant.findByPk(tenantId, {
    include: [{ model: User, as: 'owner', attributes: ['id', 'fullName', 'email'] }],
  });
  if (!tenant) throw createError('Tenant not found', 404);

  const pkg = await PlatformPackage.findByPk(packageId);
  if (!pkg) throw createError('Package not found', 404);

  const cycle = billingCycle || pkg.billingCycle || 'MONTHLY';
  const start = startDate ? new Date(startDate) : new Date();
  let end = new Date(start);
  if (cycle === 'MONTHLY') end.setMonth(end.getMonth() + 1);
  else if (cycle === 'QUARTERLY') end.setMonth(end.getMonth() + 3);
  else if (cycle === 'YEARLY') end.setFullYear(end.getFullYear() + 1);

  const subscriptionAmount = amount ?? pkg.price;

  const subscription = await TenantSubscription.create({
    tenantId,
    platformPackageId: packageId,
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
    amount: subscriptionAmount,
    billingCycle: cycle,
    status: 'ACTIVE',
    autoRenew: autoRenew !== false,
    paymentStatus: 'PENDING',
  });

  // Update tenant's selected package; reactivate if auto-suspended due to subscription expiry
  const wasAutoSuspended = tenant.status === 'SUSPENDED';
  await tenant.update({
    selectedPackageId: packageId,
    ...(wasAutoSuspended ? { status: 'ACTIVE' } : {}),
  });

  if (wasAutoSuspended) {
    // Restore the gym listing visibility
    await GymListing.update(
      { status: 'ACTIVE' },
      { where: { tenantId, status: 'INACTIVE' } }
    );
    // Send reactivation email
    const owner = tenant.owner;
    if (owner) {
      emailService.sendTenantAccountReactivatedEmail(owner.email, owner.fullName, {
        businessName: tenant.businessName,
        packageName: pkg.name,
        endDate: end.toISOString().split('T')[0],
      }).catch((err) => console.error('[assignTenantSubscription] reactivation email failed:', err.message));
    }
  }

  let invoice = null;
  if (createInvoice) {
    const invoiceNo = `INV-${Date.now().toString(36).toUpperCase()}`;
    invoice = await PlatformInvoice.create({
      tenantId,
      tenantSubscriptionId: subscription.id,
      invoiceNo,
      description: `${pkg.name} — ${cycle.toLowerCase()} subscription`,
      subtotal: subscriptionAmount,
      taxAmount: 0,
      totalAmount: subscriptionAmount,
      status: 'ISSUED',
      dueDate: start.toISOString().split('T')[0],
      createdBy: adminUserId,
    });
  }

  return { subscription, invoice };
};

// ── revokeTenantSubscription ──────────────────────────────────────────────────
const revokeTenantSubscription = async (tenantId, subscriptionId) => {
  const sub = await TenantSubscription.findOne({ where: { id: subscriptionId, tenantId } });
  if (!sub) throw createError('Subscription not found', 404);
  if (sub.status === 'CANCELLED') throw createError('Subscription is already cancelled', 400);

  await sub.update({ status: 'CANCELLED', autoRenew: false });

  // Cancel any open invoices linked to this subscription
  await PlatformInvoice.update(
    { status: 'CANCELLED' },
    { where: { tenantSubscriptionId: subscriptionId, status: ['DRAFT', 'ISSUED'] } }
  );

  return { subscription: sub };
};

// ── getTenantInvoices ─────────────────────────────────────────────────────────
const getTenantInvoices = async (tenantId, { page = 1, limit = 20 } = {}) => {
  const offset = (page - 1) * limit;
  const { count, rows } = await PlatformInvoice.findAndCountAll({
    where: { tenantId },
    include: [
      { model: TenantSubscription, as: 'subscription', attributes: ['id', 'billingCycle', 'startDate', 'endDate'], include: [{ model: PlatformPackage, as: 'package', attributes: ['id', 'name'] }] },
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });
  return { invoices: rows, pagination: buildPagination(count, page, limit) };
};

// ── createTenantInvoice ───────────────────────────────────────────────────────
const createTenantInvoice = async (tenantId, { tenantSubscriptionId, description, subtotal, taxAmount, dueDate, notes, status }, adminUserId) => {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw createError('Tenant not found', 404);

  const tax = taxAmount ?? 0;
  const total = Number(subtotal) + Number(tax);
  const invoiceNo = `INV-${Date.now().toString(36).toUpperCase()}`;

  const invoice = await PlatformInvoice.create({
    tenantId,
    tenantSubscriptionId: tenantSubscriptionId || null,
    invoiceNo,
    description: description || null,
    subtotal,
    taxAmount: tax,
    totalAmount: total,
    status: status || 'ISSUED',
    dueDate: dueDate || null,
    notes: notes || null,
    createdBy: adminUserId,
  });

  return { invoice };
};

// ── updateTenantInvoice ───────────────────────────────────────────────────────
const updateTenantInvoice = async (tenantId, invoiceId, { status, paidAt, notes, dueDate }) => {
  const invoice = await PlatformInvoice.findOne({ where: { id: invoiceId, tenantId } });
  if (!invoice) throw createError('Invoice not found', 404);

  const patch = {};
  if (status) patch.status = status;
  if (status === 'PAID' && !invoice.paidAt) patch.paidAt = paidAt || new Date();
  if (notes !== undefined) patch.notes = notes;
  if (dueDate !== undefined) patch.dueDate = dueDate;

  await invoice.update(patch);
  return { invoice };
};

// ── deleteTenant ──────────────────────────────────────────────────────────────
const deleteTenant = async (tenantId) => {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw createError('Tenant not found', 404);

  const deletableStatuses = ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'];
  if (!deletableStatuses.includes(tenant.status)) {
    throw createError('Only pending, under-review, approved (not yet active), or rejected tenants can be deleted. Suspend the tenant first.', 409);
  }

  // Clean up logo/cover images from R2
  const storageService = require('./storage.service');
  if (tenant.logoUrl) await storageService.deleteImage(tenant.logoUrl).catch(() => {});
  if (tenant.coverImageUrl) await storageService.deleteImage(tenant.coverImageUrl).catch(() => {});

  // Remove linked GymListing if any
  await GymListing.destroy({ where: { tenantId } });

  // Cascade delete subscriptions and invoices
  await TenantSubscription.destroy({ where: { tenantId } });
  await PlatformInvoice.destroy({ where: { tenantId } });

  await tenant.destroy();
};

// ── getPlatformStats ──────────────────────────────────────────────────────────
const getPlatformStats = async () => {
  const today = new Date();
  const twoDaysFromNow = new Date(today);
  twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);

  const [
    totalTenants,
    activeTenants,
    pendingApprovals,
    suspendedTenants,
    totalMembers,
    activeSubscriptions,
    expiredSubscriptions,
    expiringInTwoDays,
    totalRevenue,
  ] = await Promise.all([
    Tenant.count(),
    Tenant.count({ where: { status: 'ACTIVE' } }),
    Tenant.count({ where: { status: { [Op.in]: ['PENDING_REVIEW', 'UNDER_REVIEW'] } } }),
    Tenant.count({ where: { status: 'SUSPENDED' } }),
    UserGymMembership.count({ where: { status: 'ACTIVE' } }),
    TenantSubscription.count({ where: { status: 'ACTIVE' } }),
    TenantSubscription.count({ where: { status: 'EXPIRED' } }),
    TenantSubscription.count({
      where: {
        status: 'ACTIVE',
        endDate: { [Op.between]: [today.toISOString().split('T')[0], twoDaysFromNow.toISOString().split('T')[0]] },
      },
    }),
    PlatformInvoice.sum('totalAmount', { where: { status: 'PAID' } }),
  ]);

  return {
    totalTenants,
    activeTenants,
    pendingApprovals,
    suspendedTenants,
    totalMembers,
    activeSubscriptions,
    expiredSubscriptions,
    expiringInTwoDays,
    totalRevenue: totalRevenue ?? 0,
  };
};

// ── getPlatformAnalytics ──────────────────────────────────────────────────────
const getPlatformAnalytics = async (period = 'year') => {
  const now = new Date();
  const year = now.getFullYear();

  // Monthly tenant registrations for current year
  const tenantGrowthRaw = await Tenant.findAll({
    attributes: [
      [fn('MONTH', col('created_at')), 'month'],
      [fn('COUNT', col('id')), 'count'],
    ],
    where: {
      createdAt: {
        [Op.between]: [new Date(`${year}-01-01`), new Date(`${year}-12-31 23:59:59`)],
      },
    },
    group: [fn('MONTH', col('created_at'))],
    order: [[fn('MONTH', col('created_at')), 'ASC']],
    raw: true,
  });

  // Monthly member registrations for current year
  const memberGrowthRaw = await UserGymMembership.findAll({
    attributes: [
      [fn('MONTH', col('created_at')), 'month'],
      [fn('COUNT', col('id')), 'count'],
    ],
    where: {
      createdAt: {
        [Op.between]: [new Date(`${year}-01-01`), new Date(`${year}-12-31 23:59:59`)],
      },
    },
    group: [fn('MONTH', col('created_at'))],
    order: [[fn('MONTH', col('created_at')), 'ASC']],
    raw: true,
  });

  // City distribution — tenants per city
  const cityDistRaw = await Tenant.findAll({
    attributes: [
      'cityId',
      [fn('COUNT', col('Tenant.id')), 'tenants'],
    ],
    include: [{ model: City, as: 'city', attributes: ['name'] }],
    where: { cityId: { [Op.ne]: null } },
    group: ['cityId', 'city.id'],
    order: [[fn('COUNT', col('Tenant.id')), 'DESC']],
    limit: 8,
    raw: true,
  });

  // Monthly revenue from paid invoices
  const revenueRaw = await PlatformInvoice.findAll({
    attributes: [
      [fn('MONTH', col('paid_at')), 'month'],
      [fn('SUM', col('total_amount')), 'revenue'],
    ],
    where: {
      status: 'PAID',
      paidAt: {
        [Op.between]: [new Date(`${year}-01-01`), new Date(`${year}-12-31 23:59:59`)],
      },
    },
    group: [fn('MONTH', col('paid_at'))],
    order: [[fn('MONTH', col('paid_at')), 'ASC']],
    raw: true,
  });

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Build 12-slot arrays (index = month - 1)
  const tenantsByMonth = new Array(12).fill(0);
  tenantGrowthRaw.forEach((r) => { tenantsByMonth[Number(r.month) - 1] = Number(r.count); });

  const membersByMonth = new Array(12).fill(0);
  memberGrowthRaw.forEach((r) => { membersByMonth[Number(r.month) - 1] = Number(r.count); });

  const revenueByMonth = new Array(12).fill(0);
  revenueRaw.forEach((r) => { revenueByMonth[Number(r.month) - 1] = Number(r.revenue); });

  // Cumulative tenant growth
  let cumTenants = 0;
  const tenantGrowth = MONTHS.map((month, i) => {
    cumTenants += tenantsByMonth[i];
    return { month, tenants: cumTenants };
  });

  // Cumulative member growth
  let cumMembers = 0;
  const memberGrowth = MONTHS.map((month, i) => {
    cumMembers += membersByMonth[i];
    return { month, members: cumMembers };
  });

  const monthlyRevenue = MONTHS.map((month, i) => ({
    month,
    revenue: revenueByMonth[i],
  }));

  // City distribution
  const cityDistribution = cityDistRaw.map((r) => ({
    city: r['city.name'] || 'Unknown',
    tenants: Number(r.tenants),
  }));

  return { tenantGrowth, memberGrowth, monthlyRevenue, cityDistribution, year };
};

// ── GymListing management ─────────────────────────────────────────────────────

const _getListingIncludes = () => [
  { model: City, as: 'city', attributes: ['id', 'name'] },
  { model: Area, as: 'area', attributes: ['id', 'name'] },
];

const getGymListing = async (tenantId) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  let listing;
  if (listingId) {
    listing = await GymListing.findByPk(listingId, { include: _getListingIncludes() });
  } else {
    listing = await GymListing.findOne({ where: { tenantId: actualTenantId }, order: [['createdAt', 'ASC']], include: _getListingIncludes() });
  }
  if (!listing) throw createError('Gym listing not found', 404);
  return { gymListing: listing };
};

const createGymListing = async (tenantId, data) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const existing = await GymListing.findOne({ where: { tenantId: actualTenantId } });
  if (existing) throw createError('Gym listing already exists for this tenant', 409);

  const tenant = await Tenant.findByPk(actualTenantId);
  if (!tenant) throw createError('Tenant not found', 404);

  const listing = await GymListing.create({
    tenantId: actualTenantId,
    title: data.title || tenant.businessName,
    shortDescription: data.shortDescription || null,
    genderType: data.genderType || 'MIXED',
    contactPhone: data.contactPhone || null,
    website: data.website || null,
    cityId: data.cityId || tenant.cityId,
    areaId: data.areaId || null,
    latitude: data.latitude || null,
    longitude: data.longitude || null,
    facilitiesJson: data.facilitiesJson || null,
    isFeatured: false,
    status: 'ACTIVE',
  });

  const full = await GymListing.findByPk(listing.id, { include: _getListingIncludes() });
  return { gymListing: full };
};

const updateGymListing = async (tenantId, data) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  let listing;
  if (listingId) {
    listing = await GymListing.findByPk(listingId);
  } else {
    listing = await GymListing.findOne({ where: { tenantId: actualTenantId }, order: [['createdAt', 'ASC']] });
  }
  if (!listing) throw createError('Gym listing not found', 404);

  const fields = ['title', 'shortDescription', 'genderType', 'contactPhone', 'website', 'cityId', 'areaId', 'latitude', 'longitude', 'facilitiesJson', 'isFeatured', 'status'];
  fields.forEach((f) => { if (data[f] !== undefined) listing[f] = data[f]; });
  await listing.save();

  const full = await GymListing.findByPk(listing.id, { include: _getListingIncludes() });
  return { gymListing: full };
};

const uploadGymListingLogo = async (tenantId, fileBuffer, mimetype) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const storageService = require('./storage.service');
  let listing;
  if (listingId) {
    listing = await GymListing.findByPk(listingId);
  } else {
    listing = await GymListing.findOne({ where: { tenantId: actualTenantId }, order: [['createdAt', 'ASC']] });
  }
  if (!listing) throw createError('Gym listing not found', 404);

  if (listing.logoUrl) await storageService.deleteImage(listing.logoUrl).catch(() => {});
  const logoUrl = await storageService.uploadImage(fileBuffer, mimetype, 'gym-listings/logos', `listing-${listing.id}`);
  await listing.update({ logoUrl });
  return { logoUrl };
};

const uploadGymListingCover = async (tenantId, fileBuffer, mimetype) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const storageService = require('./storage.service');
  let listing;
  if (listingId) {
    listing = await GymListing.findByPk(listingId);
  } else {
    listing = await GymListing.findOne({ where: { tenantId: actualTenantId }, order: [['createdAt', 'ASC']] });
  }
  if (!listing) throw createError('Gym listing not found', 404);

  if (listing.coverImageUrl) await storageService.deleteImage(listing.coverImageUrl).catch(() => {});
  const coverImageUrl = await storageService.uploadImage(fileBuffer, mimetype, 'gym-listings/covers', `listing-${listing.id}`);
  await listing.update({ coverImageUrl });
  return { coverImageUrl };
};

const uploadGymListingImages = async (tenantId, files) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const storageService = require('./storage.service');
  let listing;
  if (listingId) {
    listing = await GymListing.findByPk(listingId);
  } else {
    listing = await GymListing.findOne({ where: { tenantId: actualTenantId }, order: [['createdAt', 'ASC']] });
  }
  if (!listing) throw createError('Gym listing not found', 404);

  const newUrls = await storageService.uploadImages(files, `gym-listings/${listing.id}/images`);
  const existing = Array.isArray(listing.imagesJson) ? listing.imagesJson : [];
  await listing.update({ imagesJson: [...existing, ...newUrls] });
  return { images: listing.imagesJson };
};

const deleteGymListingImage = async (tenantId, imageUrl) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const storageService = require('./storage.service');
  let listing;
  if (listingId) {
    listing = await GymListing.findByPk(listingId);
  } else {
    listing = await GymListing.findOne({ where: { tenantId: actualTenantId }, order: [['createdAt', 'ASC']] });
  }
  if (!listing) throw createError('Gym listing not found', 404);

  await storageService.deleteImage(imageUrl).catch(() => {});
  const existing = Array.isArray(listing.imagesJson) ? listing.imagesJson : [];
  await listing.update({ imagesJson: existing.filter((u) => u !== imageUrl) });
  return null;
};

// ── Admin branch management ───────────────────────────────────────────────────

const createAdminTenantBranch = async (tenantId, data) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const tenant = await Tenant.findByPk(actualTenantId, { attributes: ['id', 'connectionStringEncrypted', 'status'] });
  if (!tenant) throw createError('Tenant not found', 404);
  if (tenant.status !== 'ACTIVE') throw createError('Tenant must be active to manage branches', 400);

  const { models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  
  let gym;
  if (listingId) {
    gym = await models.Gym.findOne({ where: { gymListingId: listingId } });
  } else {
    gym = await models.Gym.findOne();
  }
  if (!gym) throw createError('Gym profile not found for this tenant', 404);

  const branch = await models.Branch.create({
    gymId: gym.id,
    gymListingId: listingId || null,
    branchName: data.branchName,
    address: data.address || null,
    cityId: data.cityId || null,
    areaId: data.areaId || null,
    phone: data.phone || null,
    openingTime: data.openingTime || null,
    closingTime: data.closingTime || null,
    facilitiesJson: data.facilitiesJson || null,
    status: 'ACTIVE',
  });

  return { branch };
};

const updateAdminTenantBranch = async (tenantId, branchId, data) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const tenant = await Tenant.findByPk(actualTenantId, { attributes: ['id', 'connectionStringEncrypted', 'status'] });
  if (!tenant) throw createError('Tenant not found', 404);

  const { models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  const branch = await models.Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  const fields = ['branchName', 'address', 'cityId', 'areaId', 'phone', 'openingTime', 'closingTime', 'facilitiesJson', 'status'];
  fields.forEach((f) => { if (data[f] !== undefined) branch[f] = data[f]; });
  await branch.save();

  return { branch };
};

const uploadAdminBranchImages = async (tenantId, branchId, files) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const storageService = require('./storage.service');
  const tenant = await Tenant.findByPk(actualTenantId, { attributes: ['id', 'connectionStringEncrypted'] });
  if (!tenant) throw createError('Tenant not found', 404);

  const { models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  const branch = await models.Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  const newUrls = await storageService.uploadImages(files, `branches/${branchId}/images`);
  const existing = Array.isArray(branch.imagesJson) ? branch.imagesJson : [];
  await branch.update({ imagesJson: [...existing, ...newUrls] });

  return { branch };
};

const deleteAdminBranchImage = async (tenantId, branchId, imageUrl) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const storageService = require('./storage.service');
  const tenant = await Tenant.findByPk(actualTenantId, { attributes: ['id', 'connectionStringEncrypted'] });
  if (!tenant) throw createError('Tenant not found', 404);

  const { models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  const branch = await models.Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  await storageService.deleteImage(imageUrl).catch(() => {});
  const existing = Array.isArray(branch.imagesJson) ? branch.imagesJson : [];
  await branch.update({ imagesJson: existing.filter((u) => u !== imageUrl) });

  return null;
};

const updateBranchTravelerVisibility = async (branchId, status, reason, adminUserId) => {
  const tenants = await Tenant.findAll({
    where: { status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });

  let foundBranch = null;
  let foundDb = null;

  for (const tenant of tenants) {
    if (tenant.connectionStringEncrypted && tenant.connectionStringEncrypted !== 'PENDING_PROVISIONING') {
      try {
        const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const branch = await tenantDb.models.Branch.findByPk(branchId);
        if (branch) {
          foundBranch = branch;
          foundDb = tenantDb;
          break;
        }
      } catch (err) {
        // Ignore unreachable
      }
    }
  }

  if (!foundBranch) {
    throw createError('Branch not found across active tenants', 404);
  }

  await foundBranch.update({
    travelerVisibilityStatus: status,
    deactivationReason: status === 'deactivated' ? reason : null,
    deactivatedAt: status === 'deactivated' ? new Date() : null,
    deactivatedBy: status === 'deactivated' ? adminUserId : null,
  });

  // Log to BranchVisibilityHistory
  const { BranchVisibilityHistory } = foundDb.models;
  if (BranchVisibilityHistory) {
    await BranchVisibilityHistory.create({
      branchId: foundBranch.id,
      status: status,
      reason: status === 'deactivated' ? reason : null,
      changedBy: adminUserId,
      changedAt: new Date(),
    });
  }

  // Notify the gym host
  try {
    const notificationsService = require('./notifications.service');
    const tenant = await Tenant.findByPk(foundBranch.tenantId);
    if (tenant && tenant.ownerUserId) {
      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'branch_visibility',
        title: status === 'deactivated' ? 'Branch Deactivated by Admin' : 'Branch Reactivated by Admin',
        message: status === 'deactivated'
          ? `Your listing ${foundBranch.branchName} is no longer visible to travelers. Reason: ${reason}`
          : `Your listing ${foundBranch.branchName} is now live again.`,
        deepLink: '/host/listings',
        metadataJson: { branchId: foundBranch.id }
      });
    }
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create notification for visibility change:', notifErr.message);
  }

  return { branch: foundBranch };
};

const getBranchVisibilityHistory = async (branchId) => {
  const tenants = await Tenant.findAll({
    where: { status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });

  let foundBranch = null;
  let foundDb = null;

  for (const tenant of tenants) {
    if (tenant.connectionStringEncrypted && tenant.connectionStringEncrypted !== 'PENDING_PROVISIONING') {
      try {
        const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const branch = await tenantDb.models.Branch.findByPk(branchId);
        if (branch) {
          foundBranch = branch;
          foundDb = tenantDb;
          break;
        }
      } catch (err) {
        // Ignore unreachable
      }
    }
  }

  if (!foundBranch) {
    throw createError('Branch not found across active tenants', 404);
  }

  const { BranchVisibilityHistory } = foundDb.models;
  let history = [];
  if (BranchVisibilityHistory) {
    history = await BranchVisibilityHistory.findAll({
      where: { branchId },
      order: [['changedAt', 'DESC']],
    });
  }

  return { history };
};

module.exports = {
  createTenant, listTenants, getTenant, approveTenant, rejectTenant, suspendTenant,
  reactivateTenant, deleteTenant, getTenantBranches, updateTenantBranchStatus, getTenantMembers, getTenantMembershipPlans,
  uploadTenantLogo, uploadTenantCover,
  getGymListing, createGymListing, updateGymListing,
  uploadGymListingLogo, uploadGymListingCover, uploadGymListingImages, deleteGymListingImage,
  createAdminTenantBranch, updateAdminTenantBranch, uploadAdminBranchImages, deleteAdminBranchImage,
  getTenantSubscriptions, assignTenantSubscription, revokeTenantSubscription,
  getTenantInvoices, createTenantInvoice, updateTenantInvoice,
  getPlatformStats, getPlatformAnalytics,
  updateBranchTravelerVisibility,
  getBranchVisibilityHistory,
};
