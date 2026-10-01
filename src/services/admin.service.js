const crypto = require('crypto');
const { Op, fn, col, literal } = require('sequelize');
const {
  Tenant,
  User,
  City,
  Area,
  PlatformPackage,
  GymListing,
  TenantSubscription,
  PlatformInvoice,
  UserGymMembership,
  TenantInvitation,
  PlatformAuditLog,
} = require('../models/platform');
const { createError, parsePagination, buildPagination } = require('../utils/response.utils');
const { TenantStatus, KycStatus } = require('../constants/subscription-status');
const { UserRole } = require('../constants/roles');
const { processTenantProvisioning, provisioningSummary, PROVISIONING_REQUESTED } = require('./tenant-provisioning.service');
const emailService = require('./email.service');
const TenantDbManager = require('../database/TenantDbManager');
const { safeRedisDel } = require('../config/redis.config');
const notificationsService = require('./notifications.service');

// ── createTenant (admin invitation flow - AUTH-09) ───────────────────────────
const createTenant = async ({ ownerEmail, ownerFullName, ownerPhone, businessName, email, phone, cityId, packageId }, adminActorId = null) => {
  const emailClean = ownerEmail.trim().toLowerCase();

  // If user already exists, verify they don't already own a gym business
  const existingUser = await User.findOne({ where: { email: emailClean } });
  if (existingUser) {
    const existingTenant = await Tenant.findOne({ where: { ownerUserId: existingUser.id } });
    if (existingTenant) {
      throw createError('This user already owns a gym business', 409);
    }
  }

  // Revoke any previous pending invitation for this owner email
  await TenantInvitation.update(
    { status: 'REVOKED' },
    { where: { ownerEmail: emailClean, status: 'PENDING' } }
  );

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7-day expiry

  const invitation = await TenantInvitation.create({
    tokenHash,
    ownerEmail: emailClean,
    ownerFullName: ownerFullName.trim(),
    ownerPhone: ownerPhone ? ownerPhone.trim() : null,
    businessName: businessName.trim(),
    email: email.trim().toLowerCase(),
    phone: phone ? phone.trim() : null,
    cityId: cityId || null,
    packageId: packageId || null,
    invitedBy: adminActorId || '00000000-0000-0000-0000-000000000000',
    status: 'PENDING',
    expiresAt,
  });

  // Audit the invitation
  try {
    await PlatformAuditLog.create({
      actorUserId: adminActorId || null,
      action: 'admin.tenant_invited',
      targetType: 'tenant_invitation',
      targetId: invitation.id,
      details: {
        ownerEmail: emailClean,
        ownerFullName: ownerFullName.trim(),
        businessName: businessName.trim(),
      },
      createdAt: new Date(),
    });
  } catch (auditErr) {
    console.warn('[Admin:Audit] Failed to record tenant invitation audit:', auditErr.message);
  }

  // Send invitation email with link
  const appUrl = process.env.APP_URL || process.env.FRONTEND_URL || 'https://gymsera.com';
  const inviteUrl = `${appUrl}/accept-tenant-invite?token=${rawToken}`;
  try {
    await emailService.sendTenantInvitationEmail(
      emailClean,
      ownerFullName.trim(),
      businessName.trim(),
      inviteUrl
    );
  } catch (emailErr) {
    console.warn('[Admin] Failed to send tenant invitation email:', emailErr.message);
  }

  const result = {
    invitation: {
      id: invitation.id,
      ownerEmail: invitation.ownerEmail,
      ownerFullName: invitation.ownerFullName,
      businessName: invitation.businessName,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    },
    message: 'Tenant invitation sent successfully',
  };

  if (process.env.NODE_ENV !== 'production') {
    result.debugToken = rawToken;
  }

  return result;
};

// ── listTenants ───────────────────────────────────────────────────────────────
/**
 * A tenant is one host account with one subscription — genuinely one row.
 * Their organizations (GymListings) are not separate tenants and must never
 * be presented as one, which this list used to do for every ADDITIONAL
 * organization regardless of its own status: an active host with 3
 * organizations produced 3 duplicate rows, each with a fabricated business
 * name and the SAME owner/email repeated on every one — indistinguishable
 * from 3 different people applying, and with no row anywhere showing the
 * one real fact ("this tenant has one subscription and 3 organizations").
 *
 * The one thing that synthesis was legitimately doing: a new organization
 * still starts life at GymListing.status 'PENDING' (see
 * host.controller.js#createListing) and genuinely needs admin
 * approve/reject — the same review a first-time tenant application gets,
 * just for an additional org under an already-active tenant. That's a real,
 * current workflow (approveTenant/rejectTenant below still operate on it via
 * the tenantId:listingId compound id), so a row for it can't just disappear.
 *
 * So the rule is narrower than "never synthesize": only a PENDING or
 * REJECTED additional organization gets its own row, because that's the one
 * case where it's a genuine action item distinct from anything the tenant
 * row itself shows. An ACTIVE additional organization is not — it belongs
 * inside its tenant's own detail page (see getTenant's `organizations`),
 * never as a look-alike top-level tenant.
 */
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

  // 2. Additional organizations awaiting a decision — PENDING/REJECTED only.
  // Never ACTIVE; see the function doc above for why.
  let gymListingWhere = null;
  if (!status) {
    gymListingWhere = { status: { [Op.in]: ['PENDING', 'REJECTED'] } };
  } else if (status === 'PENDING_REVIEW') {
    gymListingWhere = { status: 'PENDING' };
  } else if (status === 'REJECTED') {
    gymListingWhere = { status: 'REJECTED' };
  }
  // Every other tenant-status filter (UNDER_REVIEW, APPROVED, ACTIVE,
  // SUSPENDED) has no additional-organization equivalent — gymListingWhere
  // stays null and none are fetched.

  let synthesized = [];
  if (gymListingWhere) {
    const gymListings = await GymListing.findAll({
      where: gymListingWhere,
      include: [
        { model: City, as: 'city', attributes: ['id', 'name'] },
        { model: Tenant, as: 'tenant', include: [{ model: User, as: 'owner', attributes: ['id', 'fullName', 'email', 'phone'] }] },
      ],
      order: [['createdAt', 'DESC']],
    });

    // Exclude a tenant's own first/primary listing — that one already is
    // the tenant row, approved or rejected through the tenant itself.
    const additionalListings = [];
    for (const listing of gymListings) {
      if (!listing.tenant) continue;
      const firstListing = await GymListing.findOne({
        where: { tenantId: listing.tenantId },
        order: [['createdAt', 'ASC']],
        attributes: ['id'],
      });
      if (firstListing && firstListing.id !== listing.id) {
        additionalListings.push(listing);
      }
    }

    synthesized = additionalListings.map((listing) => {
      const tenant = listing.tenant;
      return {
        id: `${tenant.id}:${listing.id}`, // Compound ID — approveTenant/rejectTenant act on the listing.
        tenantCode: tenant.tenantCode,
        // Named as what it actually is: a pending organization under an
        // existing tenant, not a standalone business applying fresh.
        businessName: `${tenant.businessName} — new organization "${listing.title}"`,
        isAdditionalOrganization: true,
        ownerUserId: tenant.ownerUserId,
        email: tenant.email,
        phone: listing.contactPhone || tenant.phone,
        cityId: listing.cityId,
        status: listing.status === 'PENDING' ? 'PENDING_REVIEW' : 'REJECTED',
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
  }

  // 3. Combine and sort by createdAt DESC
  const combined = [...tenants.map((t) => t.toJSON()), ...synthesized];
  combined.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // 4. Paginate
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
  // "Provisioning… (step n/6)" / Resume in the admin console (FLOW-02).
  tenantJson.provisioning = provisioningSummary(tenant);

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
    // Reached only via the compound id a PENDING/REJECTED additional-
    // organization row in listTenants links to — this is that one listing's
    // own review status, not a second tenant's.
    tenantJson.status = gymListing.status === 'PENDING' ? 'PENDING_REVIEW' : (gymListing.status === 'REJECTED' ? 'REJECTED' : 'ACTIVE');
    tenantJson.businessName = `${tenant.businessName} — new organization "${gymListing.title}"`;
  } else {
    // The real tenant view: every organization it owns, not just the
    // oldest. This is what replaces the old "one row per organization"
    // list — one tenant, its real subscription (see the subscription tab's
    // own fetch), and here, its actual set of organizations with real
    // branch counts, so "how many organizations does this host have and
    // how built-out is each one" has an actual answer instead of requiring
    // N separate page visits that each pretended to be a different tenant.
    const allListings = await GymListing.findAll({
      where: { tenantId: actualTenantId, status: { [Op.ne]: 'INACTIVE' } },
      attributes: ['id', 'title', 'status', 'reservedSlots', 'createdAt'],
      order: [['createdAt', 'ASC']],
    });

    let branchCountsByListing = {};
    if (tenant.connectionStringEncrypted) {
      try {
        const tenantDb = await TenantDbManager.getConnection(actualTenantId, tenant.connectionStringEncrypted);
        const counts = await tenantDb.models.Branch.findAll({
          where: { status: 'ACTIVE' },
          attributes: ['gymListingId', [fn('COUNT', col('id')), 'count']],
          group: ['gymListingId'],
          raw: true,
        });
        branchCountsByListing = Object.fromEntries(counts.map((c) => [c.gymListingId, parseInt(c.count, 10)]));
      } catch (err) {
        // Tenant DB unreachable — organizations still render, just without
        // branch counts, rather than failing the whole tenant page.
      }
    }

    tenantJson.organizations = allListings.map((l) => ({
      id: l.id,
      title: l.title,
      status: l.status,
      activeBranches: branchCountsByListing[l.id] || 0,
      reservedSlots: l.reservedSlots,
      createdAt: l.createdAt,
    }));
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
 * Provisioning is a resumable step machine (FLOW-02,
 * tenant-provisioning.service.js): if it fails partway, the tenant stays
 * APPROVED at the last finished step and re-calling approve (the admin's
 * Resume) continues from there. While another run holds the tenant's
 * provisioning lease, approve changes nothing and returns
 * `provisioning.inProgress` (the controller answers 202). The route also takes
 * an optional Idempotency-Key (REL-01 middleware).
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

    if (listing.hostId) {
      notificationsService.createNotification({
        userId: listing.hostId,
        role: 'host',
        type: 'listing_approved',
        title: 'Gym Listing Approved! 🎉',
        message: `Your listing "${listing.title}" has been approved.`,
        priority: 'high',
        deepLink: '/host/branches',
        metadataJson: { event: 'branch_updated', listingId: listing.id, status: 'ACTIVE' },
      }).catch(err => console.error('[approveTenant listing] Notification error:', err.message));
    }

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

  // Re-approving an APPROVED tenant is Resume (FLOW-02): the first approval's
  // record is kept.
  if (tenant.status !== TenantStatus.APPROVED) {
    await tenant.update({
      status: TenantStatus.APPROVED,
      approvedAt: new Date(),
      approvedBy: adminUserId,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      kycStatus: KycStatus.APPROVED,
    });
  }
  // Record the intent to provision (only if nothing is recorded yet, so a
  // concurrent approve never rewinds a running provisioning's step).
  await Tenant.update(
    { provisioningState: PROVISIONING_REQUESTED },
    { where: { id: tenant.id, provisioningState: null } }
  );

  let run;
  try {
    run = await processTenantProvisioning(tenant.id);
  } catch (err) {
    console.error(`[approveTenant] Provisioning failed for tenant ${tenant.id}:`, err.message);
    throw createError(`Tenant approved, but database provisioning failed: ${err.message}. Re-approve to retry.`, 502);
  }

  await tenant.reload();
  const provisioning = provisioningSummary(tenant);

  // Another run is provisioning this tenant: report where it is, change nothing.
  if (run.inProgress || run.alreadyActive) return { tenant, provisioning };

  // Real-time notification to Gym Host that their tenant account is active
  if (tenant.ownerUserId) {
    notificationsService.createNotification({
      userId: tenant.ownerUserId,
      role: 'host',
      type: 'tenant_approved',
      title: 'Your Gym has been Approved! 🎉',
      message: `Congratulations! ${tenant.businessName} has been approved and is now active.`,
      priority: 'high',
      deepLink: '/host/today',
      metadataJson: { event: 'tenant_status_updated', tenantId: tenant.id, status: tenant.status },
    }).catch(err => console.error('[approveTenant] Notification error:', err.message));
  }

  return { tenant, provisioning };
};

// ── rejectTenant ──────────────────────────────────────────────────────────────
const rejectTenant = async (tenantId, adminUserId, reason) => {
  let [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];

  if (!reason || !reason.trim()) {
    throw createError('A rejection reason is required', 400);
  }

  if (!listingId) {
    const maybeListing = await GymListing.findByPk(actualTenantId);
    if (maybeListing) {
      listingId = maybeListing.id;
      actualTenantId = maybeListing.tenantId;
    }
  }

  if (listingId) {
    const listing = await GymListing.findByPk(listingId);
    if (!listing) throw createError('Gym listing not found', 404);

    const tenant = await Tenant.findByPk(listing.tenantId);
    if (tenant && tenant.connectionStringEncrypted && tenant.connectionStringEncrypted !== 'PENDING_PROVISIONING') {
      const TenantDbManager = require('../database/TenantDbManager');
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { Branch } = tenantDb.models;
      const branches = await Branch.findAll({
        where: { gymListingId: listing.id, status: 'ACTIVE' },
      });
      const gymService = require('./gym.service');
      for (const branch of branches) {
        await gymService.deleteBranch(tenantDb, branch.id, adminUserId, {
          confirmOrganizationDeletion: true,
        });
      }
    }

    await listing.update({
      status: 'REJECTED',
      rejectionReason: reason.trim(),
      rejectedAt: new Date(),
      rejectedBy: adminUserId,
    });

    const hostUserId = listing.hostId || tenant?.ownerUserId;
    if (hostUserId) {
      notificationsService.createNotification({
        userId: hostUserId,
        role: 'host',
        type: 'listing_rejected',
        title: 'Gym Listing Rejected — Capacity Returned',
        message: `Your listing "${listing.title}" was not approved: ${reason.trim()}. Your branch capacity has been returned to your account.`,
        priority: 'high',
        deepLink: '/host/branches',
        metadataJson: { event: 'branch_updated', listingId: listing.id, status: 'REJECTED', capacityReturned: true },
      }).catch(err => console.error('[rejectTenant listing] Notification error:', err.message));
    }

    return { tenant: { id: tenantId, status: 'REJECTED' }, capacityReturned: true };
  }

  const tenant = await Tenant.findByPk(actualTenantId, {
    include: [{ model: User, as: 'owner', attributes: ['id', 'fullName', 'email'] }],
  });
  if (!tenant) throw createError('Tenant not found', 404);

  const rejectableStatuses = [TenantStatus.PENDING_REVIEW, TenantStatus.UNDER_REVIEW, TenantStatus.APPROVED, TenantStatus.ACTIVE];
  if (!rejectableStatuses.includes(tenant.status)) {
    throw createError('Tenant cannot be rejected from its current status', 400);
  }

  // NEW-34: a provisioning run that holds a live lease keeps creating the database, listing and
  // branch; rejecting now would orphan them. The run stops by itself or its lease expires — reject then.
  if (provisioningSummary(tenant).inProgress) {
    const err = createError('Provisioning is still running for this tenant. Wait for it to stop, then reject.', 409);
    err.code = 'provisioning_in_progress';
    throw err;
  }

  await tenant.update({
    status: TenantStatus.REJECTED,
    rejectedAt: new Date(),
    rejectedBy: adminUserId,
    rejectionReason: reason.trim(),
    kycStatus: KycStatus.REJECTED,
  });
  // NEW-34: a rejected tenant's live listing must not stay ACTIVE (PENDING / REJECTED ones are left as they are).
  await GymListing.update({ status: 'INACTIVE' }, { where: { tenantId: tenant.id, status: 'ACTIVE' } });

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

  if (tenant.ownerUserId) {
    notificationsService.createNotification({
      userId: tenant.ownerUserId,
      role: 'host',
      type: 'tenant_rejected',
      title: 'Host Application Rejected',
      message: `Your organization ${tenant.gymName || tenant.businessName} requires changes: ${reason.trim()}.`,
      priority: 'high',
      deepLink: '/host/profile',
      metadataJson: { event: 'tenant_status_updated', tenantId: tenant.id, status: 'REJECTED' },
    }).catch(err => console.error('[rejectTenant] Notification error:', err.message));
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

  if (tenant.ownerUserId) {
    notificationsService.createNotification({
      userId: tenant.ownerUserId,
      role: 'host',
      type: 'tenant_suspended',
      title: 'Gym Account Suspended',
      message: `Your gym organization has been suspended: ${reason.trim()}`,
      priority: 'high',
      deepLink: '/host/profile',
      metadataJson: { event: 'tenant_status_updated', tenantId: tenant.id, status: 'SUSPENDED' },
    }).catch(err => console.error('[suspendTenant] Notification error:', err.message));
  }

  return { tenant };
};

// ── reactivateTenant ──────────────────────────────────────────────────────────
const reactivateTenant = async (tenantId, adminUserId) => {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw createError('Tenant not found', 404);

  if (tenant.status !== TenantStatus.SUSPENDED) {
    throw createError('Only suspended tenants can be reactivated', 400);
  }

  // Ensure tenant database schema is at latest version before reactivating (spec §6.5, Step 2.10)
  if (tenant.connectionStringEncrypted && tenant.connectionStringEncrypted !== 'PENDING_PROVISIONING') {
    const { decrypt } = require('../utils/crypto.utils');
    const { Sequelize } = require('sequelize');
    const connUrl = decrypt(tenant.connectionStringEncrypted);
    const tenantSeq = new Sequelize(connUrl, {
      dialect: 'mysql',
      logging: false,
      pool: { max: 2, min: 0, acquire: 20000, idle: 10000 },
      dialectOptions: { connectTimeout: 15000 },
    });
    try {
      await tenantSeq.authenticate();
      const { runTenantMigrations } = require('../database/tenant-migration-runner');
      await runTenantMigrations(tenantSeq, {
        tenantId: tenant.id,
        tenantCode: tenant.tenantCode,
        gymName: tenant.gymName,
      });
      console.log(`[reactivateTenant] Tenant migrations applied to latest version for '${tenant.gymName}' (${tenant.id})`);
    } finally {
      await tenantSeq.close().catch(() => {});
    }
  }

  await tenant.update({ status: TenantStatus.ACTIVE });
  await safeRedisDel(`tenant:${tenantId}:connStr`);

  if (tenant.ownerUserId) {
    notificationsService.createNotification({
      userId: tenant.ownerUserId,
      role: 'host',
      type: 'tenant_reactivated',
      title: 'Gym Account Reactivated! 🎉',
      message: `Your gym organization has been reactivated.`,
      priority: 'high',
      deepLink: '/host/today',
      metadataJson: { event: 'tenant_status_updated', tenantId: tenant.id, status: 'ACTIVE' },
    }).catch(err => console.error('[reactivateTenant] Notification error:', err.message));
  }

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

// ── getTenantCapacityAudit (admin) ───────────────────────────────────────────
/**
 * Read-only capacity integrity report for one tenant — "are this host's
 * branch numbers actually correct, and does the audit trail agree?"
 *
 * Always resolves against the REAL tenant, even when called with one of the
 * synthesized `tenantId:listingId` compound ids the tenant list still hands
 * out for additional organizations. Capacity is a property of the
 * subscription, which is tenant-wide — there is no such thing as one
 * organization's own plan, and reporting per-listing here would invent one.
 */
const getTenantCapacityAudit = async (tenantId) => {
  const [actualTenantId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId];
  const subscriptionQuotaService = require('./subscription-quota.service');

  let tenantDb = null;
  try {
    tenantDb = await _getTenantDb(actualTenantId);
  } catch (err) {
    // An unprovisioned tenant has no branches to count — the ledger half of
    // the audit is still meaningful, so report what we can rather than 500.
    tenantDb = null;
  }

  const audit = await subscriptionQuotaService.auditCapacity(actualTenantId, tenantDb);
  return { audit };
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
// Was a raw `branch.update({ status })` — found during a final capacity-path
// audit to be a live, callable bypass of every rule the rest of the branch
// lifecycle now enforces: no capacity check on reactivation (could push a
// tenant over maxBranches), no reservedSlots credit on deactivation (the
// capacity silently vanishes instead of coming back as a buildable slot),
// none of deleteBranch's cascade (member subscriptions, staff, plans left
// untouched), and no capacity_events row. Delegates to the same
// gymService.deleteBranch/restoreBranch every other deactivate/reactivate
// path already goes through, so this admin action gets the exact same
// guarantees instead of a second, ungoverned copy of the logic.
// ── suspendTenantBranch (admin disable for policy reasons) ───────────────────
// CAP-04: Admin disabling for policy reasons is a distinct concept from
// host/admin deletion. It flags adminSuspended: true, hides the branch from
// public discovery, and logs an audit trail, while leaving the tenant's capacity
// completely unchanged (does NOT decrement usage or credit reservedSlots).
const suspendTenantBranch = async (tenantId, branchId, reason, adminUserId) => {
  const tenantDb = await _getTenantDb(tenantId);
  const branch = await tenantDb.models.Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  const beforeState = {
    adminSuspended: !!branch.adminSuspended,
    adminSuspendedReason: branch.adminSuspendedReason || null,
    travelerVisibilityStatus: branch.travelerVisibilityStatus,
    status: branch.status,
  };

  const trimReason = reason ? String(reason).trim() : 'Suspended by administrator for policy reasons';

  await branch.update({
    adminSuspended: true,
    adminSuspendedReason: trimReason,
    adminSuspendedAt: new Date(),
    adminSuspendedBy: adminUserId || null,
    travelerVisibilityStatus: 'deactivated',
  });

  // 1. Audit trail in tenant DB AuditLog
  const { AuditLog, BranchVisibilityHistory } = tenantDb.models;
  if (AuditLog) {
    await AuditLog.create({
      branchId: branch.id,
      actorUserId: adminUserId,
      actorRoleKey: 'PLATFORM_ADMIN',
      action: 'branch.admin_suspend',
      targetType: 'branch',
      targetId: branch.id,
      beforeState,
      afterState: {
        adminSuspended: true,
        adminSuspendedReason: trimReason,
        travelerVisibilityStatus: 'deactivated',
        status: branch.status,
      },
    }).catch(() => {});
  }

  // 2. Audit trail in BranchVisibilityHistory
  if (BranchVisibilityHistory) {
    await BranchVisibilityHistory.create({
      branchId: branch.id,
      status: 'deactivated',
      reason: trimReason,
      changedBy: adminUserId,
      changedAt: new Date(),
    }).catch(() => {});
  }

  // 3. Notify the host
  try {
    const [actualTenantId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId];
    const tenant = await Tenant.findByPk(actualTenantId);
    if (tenant && tenant.ownerUserId) {
      const notificationsService = require('./notifications.service');
      notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'branch_suspended',
        title: 'Branch Suspended by Administrator',
        message: `Your branch "${branch.branchName}" has been suspended for policy reasons: ${trimReason}`,
        priority: 'high',
        deepLink: '/host/branches',
        metadataJson: { event: 'branch_suspended', branchId: branch.id, reason: trimReason },
      }).catch(() => {});
    }
  } catch (_) {}

  return { branch };
};

// ── unsuspendTenantBranch (admin enable) ───────────────────────────────────────
const unsuspendTenantBranch = async (tenantId, branchId, adminUserId) => {
  const tenantDb = await _getTenantDb(tenantId);
  const branch = await tenantDb.models.Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  const beforeState = {
    adminSuspended: !!branch.adminSuspended,
    adminSuspendedReason: branch.adminSuspendedReason || null,
    travelerVisibilityStatus: branch.travelerVisibilityStatus,
    status: branch.status,
  };

  await branch.update({
    adminSuspended: false,
    adminSuspendedReason: null,
    adminSuspendedAt: null,
    adminSuspendedBy: null,
  });

  const { AuditLog } = tenantDb.models;
  if (AuditLog) {
    await AuditLog.create({
      branchId: branch.id,
      actorUserId: adminUserId,
      actorRoleKey: 'PLATFORM_ADMIN',
      action: 'branch.admin_unsuspend',
      targetType: 'branch',
      targetId: branch.id,
      beforeState,
      afterState: {
        adminSuspended: false,
        status: branch.status,
      },
    }).catch(() => {});
  }

  return { branch };
};

// ── deleteTenantBranch (admin delete calling deleteBranch) ───────────────────
const deleteTenantBranch = async (tenantId, branchId, adminUserId, { confirmOrganizationDeletion = false } = {}) => {
  const tenantDb = await _getTenantDb(tenantId);
  const gymService = require('./gym.service');
  await gymService.deleteBranch(tenantDb, branchId, adminUserId, { confirmOrganizationDeletion });
  const branch = await tenantDb.models.Branch.findByPk(branchId);
  return { branch };
};

// ── updateTenantBranchStatus (admin) ─────────────────────────────────────────
// Delegates to deleteTenantBranch (for INACTIVE), restoreBranch / unsuspend (for ACTIVE),
// or suspendTenantBranch (for SUSPENDED). Never writes status directly.
const updateTenantBranchStatus = async (tenantId, branchId, status, adminUserId, reason = null) => {
  const [actualTenantId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId];
  const tenantDb = await _getTenantDb(tenantId);
  const gymService = require('./gym.service');

  if (status === 'SUSPENDED') {
    return await suspendTenantBranch(tenantId, branchId, reason, adminUserId);
  } else if (status === 'INACTIVE') {
    return await deleteTenantBranch(tenantId, branchId, adminUserId, { confirmOrganizationDeletion: true });
  } else if (status === 'ACTIVE') {
    const branch = await tenantDb.models.Branch.findByPk(branchId);
    if (!branch) throw createError('Branch not found', 404);

    if (branch.adminSuspended) {
      await unsuspendTenantBranch(tenantId, branchId, adminUserId);
    }
    if (branch.status === 'INACTIVE') {
      await gymService.restoreBranch(tenantDb, actualTenantId, branchId, adminUserId);
    }
    await branch.reload();
    return { branch };
  } else {
    throw createError('status must be ACTIVE, INACTIVE, or SUSPENDED', 400);
  }
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

  // INTENTIONAL PRODUCT RULE — same as host.controller.js#upgradeSubscription's
  // guard: this legacy manual/PlatformPackage path has no concept of
  // reservedSlots or overQuotaCount and is NOT unified with the IAP
  // reconciliation workflow, only kept from colliding with it. Unlike that
  // endpoint, this one doesn't even cancel the tenant's existing ACTIVE
  // subscription first, so assigning one to a tenant already on a
  // store-verified plan would leave two simultaneously "ACTIVE" rows and
  // silently strand their reservedSlots. Blocked outright; a genuine
  // IAP-to-manual transition needs its own deliberate, explicitly-reconciled
  // admin operation, not a side effect of this form.
  const subscriptionQuotaService = require('./subscription-quota.service');
  const existingActiveSub = await subscriptionQuotaService.getActiveSubscription(tenantId);
  if (existingActiveSub && existingActiveSub.branchCount != null) {
    const err = createError(
      'This tenant has an active store-verified (IAP) subscription — assigning a manual package would conflict with it. Resolve that first.',
      409
    );
    err.code = 'iap_subscription_active';
    throw err;
  }

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
// INTENTIONAL PRODUCT RULE, not an oversight: revoking never touches
// reservedSlots or any real Branch. The tenant's branch-count entitlement
// simply drops to the legacy default (1) going forward — resolveMaxBranches
// falls through once no ACTIVE subscription remains — so new consumption
// (createBranch, restoreBranch) is naturally blocked without this function
// having to compute or trim anything itself. Real branches are NEVER
// auto-deleted or deactivated by a revoke, and reservedSlots are NEVER
// stripped, even though this is a punitive admin action: capacity the host
// already paid for is not destroyed by revocation, matching the same "never
// touch what already exists" rule reconcileCapacity enforces for a plain
// downgrade (see subscription-quota.service.js#reconcileCapacity). If a
// genuine "claw back paid capacity" admin action is ever needed, it should
// be its own explicit, deliberate operation — not a side effect of revoke.
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

// CAP-03: Every branch creator must use createBranch. Admin branch
// creation delegates directly to gymService.createBranch, ensuring uniform
// capacity enforcement, reservedSlots consumption, and CapacityEvent audit logging.
const createAdminTenantBranch = async (tenantId, data, adminUserId) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const tenant = await Tenant.findByPk(actualTenantId, { attributes: ['id', 'connectionStringEncrypted', 'status'] });
  if (!tenant) throw createError('Tenant not found', 404);
  if (tenant.status !== 'ACTIVE') throw createError('Tenant must be active to manage branches', 400);

  const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  const gymService = require('./gym.service');

  const { branch } = await gymService.createBranch(
    tenantDb,
    actualTenantId,
    {
      ...data,
      gymListingId: listingId || data.gymListingId,
    },
    adminUserId,
    {
      actorType: 'ADMIN',
      allowDefaultPackage: true,
      reason: `Branch "${data.branchName}" created by admin`,
    }
  );

  return { branch };
};

const updateAdminTenantBranch = async (tenantId, branchId, data, adminUserId) => {
  const [actualTenantId, listingId] = tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined];
  const tenant = await Tenant.findByPk(actualTenantId, { attributes: ['id', 'connectionStringEncrypted', 'status'] });
  if (!tenant) throw createError('Tenant not found', 404);

  const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  const branch = await tenantDb.models.Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  // `status` deliberately excluded from the generic mass-assignment below —
  // found during a final capacity-path audit to be a second, independent
  // route to the exact same bypass fixed in updateTenantBranchStatus (no
  // capacity check, no reservedSlots credit/consumption, no cascade, no
  // audit row). Routed through the same gymService functions instead.
  const fields = ['branchName', 'address', 'cityId', 'areaId', 'phone', 'openingTime', 'closingTime', 'facilitiesJson'];
  fields.forEach((f) => { if (data[f] !== undefined) branch[f] = data[f]; });
  await branch.save();

  if (data.status !== undefined && data.status !== branch.status) {
    const gymService = require('./gym.service');
    if (data.status === 'INACTIVE') {
      await gymService.deleteBranch(tenantDb, branchId, adminUserId);
    } else if (data.status === 'ACTIVE') {
      await gymService.restoreBranch(tenantDb, actualTenantId, branchId, adminUserId);
    } else {
      throw createError('status must be ACTIVE or INACTIVE', 400);
    }
    await branch.reload();
  }

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
  reactivateTenant, deleteTenant, getTenantBranches, getTenantCapacityAudit, updateTenantBranchStatus,
  suspendTenantBranch, unsuspendTenantBranch, deleteTenantBranch,
  getTenantMembers, getTenantMembershipPlans,
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
