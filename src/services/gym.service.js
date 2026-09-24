const crypto = require('crypto');
const { GymListing, Tenant, User, UserGymMembership, sequelize } = require('../models/platform');
const { Op } = require('sequelize');
const { createError, buildPagination } = require('../utils/response.utils');
const { SubscriptionStatus } = require('../constants/subscription-status');
const { PaymentStatus, InvoiceStatus } = require('../constants/payment-status');
const subscriptionQuotaService = require('./subscription-quota.service');

const _invoiceNo = () => {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `INV-${date}-${rand}`;
};

const _calcEndDate = (startDate, durationType, durationValue) => {
  const d = new Date(startDate);
  switch (durationType) {
    case 'DAILY': d.setDate(d.getDate() + durationValue); break;
    case 'WEEKLY': d.setDate(d.getDate() + durationValue * 7); break;
    case 'MONTHLY': d.setMonth(d.getMonth() + durationValue); break;
    case 'QUARTERLY': d.setMonth(d.getMonth() + durationValue * 3); break;
    case 'YEARLY': d.setFullYear(d.getFullYear() + durationValue); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().split('T')[0];
};

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Runs a platform-DB capacity mutation (its own transaction, separate from
 * whatever tenant-DB transaction already committed) with a few retries on
 * transient failure — replaces the bare fire-and-forget try/catch this used
 * to be, which silently dropped a returned slot if the platform DB hiccuped
 * right after the tenant-DB commit succeeded. `fn` must be idempotent (via
 * subscriptionQuotaService.recordCapacityEvent) so a retry after a partial
 * failure can never double-apply. Only logs (never throws) on final
 * failure — the branch/org action itself already succeeded and committed;
 * losing the slot bookkeeping here is a data-integrity issue for the daily
 * reconciliation job to catch, not a reason to tell the host their delete
 * failed.
 */
const _applyPlatformCapacityStep = async (fn, failureLogPrefix, attempts = 3) => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (attempt === attempts) {
        console.error(`${failureLogPrefix}:`, err.message);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
};

/**
 * Get the single Gym record from the tenant DB.
 * On first access (just after provisioning) there may be no Gym row yet —
 * we auto-create one from the Platform Tenant snapshot.
 */
const _getOrCreateGym = async (tenantDb, tenantId) => {
  const { Gym } = tenantDb.models;
  let gym = await Gym.findOne();

  if (!gym) {
    // Seed initial data from the Platform Tenant record
    const tenant = await Tenant.findByPk(tenantId, {
      attributes: ['businessName', 'gymName', 'gymDescription', 'genderType', 'logoUrl', 'coverImageUrl', 'phone', 'email'],
    });

    gym = await Gym.create({
      name: (tenant && (tenant.gymName || tenant.businessName)) || 'My Gym',
      description: (tenant && tenant.gymDescription) || null,
      contactPhone: (tenant && tenant.phone) || null,
      contactEmail: (tenant && tenant.email) || null,
      genderType: (tenant && tenant.genderType) || 'MIXED',
      logoUrl: (tenant && tenant.logoUrl) || null,
      coverImageUrl: (tenant && tenant.coverImageUrl) || null,
    });
  }

  return gym;
};

/**
 * Sync key public fields back to the platform GymListing record.
 * Called whenever the gym profile is updated.
 */
const _syncGymListing = async (tenantId, patch) => {
  const syncFields = {};
  if (patch.name !== undefined) syncFields.title = patch.name;
  if (patch.description !== undefined) syncFields.shortDescription = patch.description;
  if (patch.logoUrl !== undefined) syncFields.logoUrl = patch.logoUrl;
  if (patch.coverImageUrl !== undefined) syncFields.coverImageUrl = patch.coverImageUrl;
  if (patch.genderType !== undefined) syncFields.genderType = patch.genderType;
  if (patch.contactPhone !== undefined) syncFields.contactPhone = patch.contactPhone;
  // phone is the alias the CMS profile form sends
  if (patch.phone !== undefined) syncFields.contactPhone = patch.phone;
  if (patch.website !== undefined) syncFields.website = patch.website;
  if (patch.imagesJson !== undefined) syncFields.imagesJson = patch.imagesJson;
  if (patch.latitude != null) syncFields.latitude = patch.latitude;
  if (patch.longitude != null) syncFields.longitude = patch.longitude;

  if (Object.keys(syncFields).length > 0) {
    await GymListing.update(syncFields, { where: { tenantId } });
  }
};

// ── Gym profile ───────────────────────────────────────────────────────────────

const getProfile = async (tenantDb, tenantId) => {
  const gym = await _getOrCreateGym(tenantDb, tenantId);
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['paymentDetailsJson'] });
  return {
    gym: {
      ...gym.toJSON(),
      paymentDetailsJson: tenant ? tenant.paymentDetailsJson : null,
    }
  };
};

const updateProfile = async (tenantDb, tenantId, data) => {
  const gym = await _getOrCreateGym(tenantDb, tenantId);

  const fields = ['name', 'description', 'contactPhone', 'contactEmail', 'website', 'genderType', 'logoUrl', 'coverImageUrl', 'socialLinksJson', 'imagesJson', 'tagline', 'category', 'establishedYear'];
  fields.forEach((f) => {
    if (data[f] !== undefined) gym[f] = data[f];
  });
  await gym.save();

  // If paymentDetailsJson is provided, update the platform Tenant model
  if (data.paymentDetailsJson !== undefined) {
    await Tenant.update(
      { paymentDetailsJson: data.paymentDetailsJson },
      { where: { id: tenantId } }
    );
  }

  // Keep the public gym_listings record in sync
  await _syncGymListing(tenantId, data);

  const tenant = await Tenant.findByPk(tenantId, { attributes: ['paymentDetailsJson'] });
  return {
    gym: {
      ...gym.toJSON(),
      paymentDetailsJson: tenant ? tenant.paymentDetailsJson : null,
    }
  };
};

// ── Branches ──────────────────────────────────────────────────────────────────

const listBranches = async (tenantDb, tenantId, organizationId, { includeInactive = false } = {}) => {
  const { Gym, Branch } = tenantDb.models;
  let gym = await Gym.findOne();

  let whereClause = {};

  if (organizationId) {
    whereClause = {
      [Op.or]: [
        { gymListingId: organizationId },
        { gymId: organizationId },
        { gymListingId: null },
      ]
    };
  }

  const branches = await Branch.findAll({
    where: {
      ...whereClause,
      // includeInactive surfaces deleted branches too (status ordering puts
      // ACTIVE ones first) — used only by the "restore a deleted branch" UI,
      // never by any default listing.
      ...(includeInactive ? {} : { status: { [Op.ne]: 'INACTIVE' } }),
    },
    order: [['status', 'ASC'], ['createdAt', 'ASC']],
  });

  // Find default listing for this tenant to ensure every branch has gymListingId populated for frontend mapping
  const defaultListing = await GymListing.findOne({ where: { tenantId } });
  const mappedBranches = branches.map(b => {
    const json = b.toJSON();
    if (!json.gymListingId && defaultListing) {
      json.gymListingId = defaultListing.id;
    }
    return json;
  });

  return { gym, branches: mappedBranches };
};

/**
 * The tenant's total ACTIVE branch count across every organization it owns —
 * the branch-count subscription is one shared pool for the whole account,
 * not a separate allowance per organization (see the pricing model discussed
 * when the IAP staircase plans were built). Counting scoped to a single
 * gymListingId here would let a host exceed their real total simply by
 * spreading branches across multiple organizations.
 */
const _countActiveBranchesForTenant = async (tenantDb) => {
  return tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } });
};

/**
 * Creates the Branch row and its mandatory membership plan(s). No quota
 * check, no transaction/lock management — callers that already hold the
 * tenant's platformTx lock (createListing, below) call this directly instead
 * of going through createBranch's own lock, which would otherwise try to
 * acquire a second lock on the same already-locked tenant row and risk a
 * deadlock.
 *
 * `transaction` — the caller's own open platform-DB transaction, if any.
 * Forwarded to membershipPlanService.createPlan so its minPrice sync writes
 * through the SAME connection instead of a second one contending for a lock
 * this transaction already holds on the target GymListing — omitting this
 * doesn't error, it just silently costs ~50s per branch (MySQL's
 * innodb_lock_wait_timeout) waiting on itself before giving up. Both current
 * callers (createBranch, createListing) always have one open.
 */
const _createBranchRecord = async (tenantDb, gym, targetListingId, data, { transaction } = {}) => {
  const { Branch } = tenantDb.models;

  if (!Array.isArray(data.packages) || data.packages.length === 0) {
    throw createError('At least 1 membership package/plan is required to create a branch', 400);
  }

  const branch = await Branch.create({
    gymId: gym.id,
    gymListingId: targetListingId || null,
    branchName: data.branchName,
    address: data.address || data.addressLine1 || null,
    cityId: data.cityId || null,
    areaId: data.areaId || null,
    latitude: data.latitude || null,
    longitude: data.longitude || null,
    openingTime: data.openingTime || null,
    closingTime: data.closingTime || null,
    phone: data.phone || null,
    facilitiesJson: Array.isArray(data.facilities) ? data.facilities : (data.facilitiesJson || null),
    imagesJson: Array.isArray(data.images) ? data.images : (data.imagesJson || null),
    tagline: data.tagline || null,
    category: data.category || null,
    description: data.description || null,
    establishedYear: data.establishedYear ? parseInt(data.establishedYear) : null,
    floorArea: data.floorArea ? parseInt(data.floorArea) : null,
    addressLine1: data.addressLine1 || data.address || null,
    addressLine2: data.addressLine2 || null,
    postalCode: data.postalCode || null,
    country: data.country || null,
    status: 'ACTIVE',
    travelerVisibilityStatus: 'active',
  });

  // Create initial membership packages (mandatory: at least 1)
  const membershipPlanService = require('./membership-plan.service');
  let createdPlansCount = 0;
  for (const pkg of data.packages) {
    if (!pkg.name || pkg.price === undefined || pkg.price === null) continue;
    try {
      await membershipPlanService.createPlan(tenantDb, {
        branchId: branch.id,
        name: pkg.name,
        price: pkg.price,
        durationType: pkg.durationType || 'MONTHLY',
        durationValue: pkg.durationValue || 1,
        description: pkg.description || null,
        isPublic: true,
      }, { transaction });
      createdPlansCount++;
    } catch (pkgErr) {
      console.warn('[Branch Creation] Package creation error:', pkgErr.message);
      throw pkgErr;
    }
  }

  if (createdPlansCount === 0) {
    throw createError('Failed to create initial membership plan for branch. At least 1 valid plan is required.', 400);
  }

  return branch;
};

const _notifyBranchLimitReached = async (tenantId, tenant) => {
  try {
    const notificationsService = require('./notifications.service');
    if (tenant && tenant.ownerUserId) {
      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'branch_quota_reached',
        title: 'Branch Limit Reached',
        message: 'You have reached your branch listing quota! Upgrade your package to add more branch listings.',
        deepLink: '/host/listings',
        metadataJson: { tenantId }
      });
    }
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create branch quota reached notification:', notifErr.message);
  }
};

/**
 * How many ACTIVE branches an organization still has. Used both for the
 * advisory "this is the last one" warning before a destructive action, and
 * for the cascade decision after it.
 */
const _countActiveBranchesInListing = async (tenantDb, listingId) => {
  if (!listingId) return 0;
  return tenantDb.models.Branch.count({ where: { gymListingId: listingId, status: 'ACTIVE' } });
};

/**
 * Business rule: an organization must never exist without at least one
 * branch. Called after the last branch leaves one (deleted or moved away)
 * to take the now-empty organization down with it.
 *
 * Deliberately re-counts rather than trusting the caller's earlier check:
 * branches live in the tenant DB and organizations in the platform DB, so
 * the two can't share a transaction (the same reason deleteBranch's capacity
 * step is already split out and made idempotent). Re-counting here, after
 * the branch change has committed, means two concurrent deletions of the
 * last two branches both arrive at the correct answer instead of each
 * seeing the other's branch as still alive — and the ORG_DELETED event's
 * idempotency key makes the duplicate attempt a no-op.
 *
 * Any reservedSlots left on the organization are intentionally left in
 * place and simply go inert: getUsedCapacity only sums reservedSlots for
 * organizations that aren't INACTIVE, so the capacity returns to the
 * tenant's shared pool — exactly the behaviour deleteOrganization already
 * documents and relies on. Nothing the host paid for is lost: what they can
 * still build is maxBranches - activeBranches, which this doesn't touch.
 */
const _deactivateOrganizationIfEmpty = async (tenantDb, listingId, actorUserId, reason) => {
  if (!listingId) return false;
  const remaining = await _countActiveBranchesInListing(tenantDb, listingId);
  if (remaining > 0) return false;

  // Looked up by id alone and the tenant read off the row itself — the
  // callers below are already operating on this organization's own branch,
  // so re-deriving the tenant here is both simpler and one less thing a
  // caller can get wrong.
  const listing = await GymListing.findByPk(listingId);
  if (!listing || listing.status === 'INACTIVE') return false;

  await listing.update({ status: 'INACTIVE', branchId: null });
  await subscriptionQuotaService.recordCapacityEvent(
    {
      tenantId: listing.tenantId,
      listingId,
      action: 'ORG_DELETED',
      delta: 0,
      reservedSlotsBefore: listing.reservedSlots,
      reservedSlotsAfter: listing.reservedSlots,
      actorUserId: actorUserId || null,
      actorType: actorUserId ? 'HOST' : 'SYSTEM',
      reason,
      idempotencyKey: `org_deleted:${listingId}`,
    },
    { transaction: null }
  );
  return true;
};

/**
 * Advisory guard for the two destructive paths below (delete a branch, move
 * a branch out). Throws a 409 the client can recognise and turn into an
 * "are you sure?" dialog, unless the caller has already confirmed. Purely a
 * warning mechanism — the actual cascade is decided by
 * _deactivateOrganizationIfEmpty after the fact, so losing this race just
 * means the host wasn't prompted, never that the data ends up wrong.
 */
const _guardLastBranchInOrganization = async (tenantDb, branch, confirmed) => {
  if (confirmed || !branch.gymListingId) return;
  const activeInListing = await _countActiveBranchesInListing(tenantDb, branch.gymListingId);
  if (activeInListing > 1) return;

  const listing = await GymListing.findByPk(branch.gymListingId);
  const err = createError(
    `This is the last branch in "${listing?.title || 'this organization'}". ` +
      'Continuing will also remove the organization.',
    409
  );
  err.code = 'last_branch_in_organization';
  // `data` (not `details`) — that's the key errorHandler.js actually
  // forwards to the client alongside `code`.
  err.data = { listingId: branch.gymListingId, organizationName: listing?.title || null };
  throw err;
};

const createBranch = async (tenantDb, tenantId, data, createdByUserId = null) => {
  const platformTx = await sequelize.transaction();
  try {
    // Acquire exclusive write lock on Tenant record in platform DB to serialize branch creations for this tenant.
    const tenant = await Tenant.findByPk(tenantId, {
      lock: true,
      transaction: platformTx,
    });
    if (!tenant) {
      throw createError('Tenant not found', 404);
    }

    let targetListingId = data.gymListingId;
    if (!targetListingId) {
      const firstListing = await GymListing.findOne({
        where: { tenantId },
        transaction: platformTx,
      });
      if (firstListing) targetListingId = firstListing.id;
    }

    // Building into an organization that already has a reserved (paid,
    // unbuilt) slot converts that reservation into a real branch — it
    // doesn't consume any NEW capacity, since that unit was already counted
    // as used the moment it was reserved (see subscription-quota.service.js
    // #getUsedCapacity). Only check fresh capacity when there's no
    // reservation to draw on.
    let targetListing = null;
    if (targetListingId) {
      targetListing = await GymListing.findByPk(targetListingId, { lock: true, transaction: platformTx });
    }
    const consumingReservedSlot = !!(targetListing && targetListing.reservedSlots > 0);

    if (!consumingReservedSlot) {
      const activeSub = await subscriptionQuotaService.getActiveSubscription(tenantId, { transaction: platformTx });

      // A recent downgrade can leave real ACTIVE branches alone exceeding
      // the new plan (see subscription-quota.service.js#reconcileCapacity)
      // — never resolved by touching those branches, only by blocking
      // further NEW consumption until the host upgrades or closes some
      // themselves. Filling an already-reserved slot above is still allowed
      // even in this state since it doesn't add to the overage.
      if (activeSub && activeSub.overQuotaCount > 0) {
        const err = createError(
          'Your account is over its current plan\'s branch capacity following a recent downgrade. Upgrade your plan or close another branch before adding a new one.',
          403
        );
        err.code = 'account_over_quota';
        throw err;
      }

      const maxBranches = await subscriptionQuotaService.resolveMaxBranches(tenant, activeSub, { transaction: platformTx });
      const usedCapacity = await subscriptionQuotaService.getUsedCapacity(tenantId, tenantDb, { transaction: platformTx });

      if (usedCapacity >= maxBranches) {
        await _notifyBranchLimitReached(tenantId, tenant);
        const err = createError('Branch limit reached', 403);
        err.code = 'branch_limit_reached';
        throw err;
      }
    }

    let gym = null;
    if (targetListingId) {
      gym = await tenantDb.models.Gym.findOne({
        where: { gymListingId: targetListingId }
      });
    }
    if (!gym) {
      gym = await _getOrCreateGym(tenantDb, tenantId);
    }

    const branch = await _createBranchRecord(tenantDb, gym, targetListingId, data, { transaction: platformTx });

    if (consumingReservedSlot) {
      // Completes the audit trail for the reverse of BRANCH_DELETED: this
      // reserved slot — paid for, previously unbuilt — has now become a
      // real branch. Doesn't change usedCapacity (reservedSlots-1,
      // activeBranches+1, net zero) but every OTHER capacity-changing
      // action gets a capacity_events row, so this one should too.
      await subscriptionQuotaService.recordCapacityEvent(
        {
          tenantId,
          listingId: targetListing.id,
          branchId: branch.id,
          action: 'SLOT_CONSUMED_BUILD',
          delta: -1,
          reservedSlotsBefore: targetListing.reservedSlots,
          reservedSlotsAfter: targetListing.reservedSlots - 1,
          actorUserId: createdByUserId,
          actorType: createdByUserId ? 'HOST' : 'SYSTEM',
          reason: `Branch "${branch.branchName}" built into a reserved slot`,
          idempotencyKey: `slot_consumed_build:${branch.id}`,
        },
        { transaction: platformTx }
      );
      await targetListing.decrement('reservedSlots', { by: 1, transaction: platformTx });
    }

    await platformTx.commit();
    return { branch };
  } catch (err) {
    await platformTx.rollback();
    throw err;
  }
};

const getBranch = async (tenantDb, branchId) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findOne({
    where: { id: branchId, status: 'ACTIVE' },
  });
  if (!branch) throw createError('Branch not found or has been deleted', 404);
  return { branch };
};

/**
 * Reassigns an existing branch to a different organization (GymListing)
 * owned by the same tenant. Doesn't touch the branch-count subscription at
 * all — the branch already counted against it wherever it was, and moving
 * it doesn't change the tenant's total usage. Also reassigns gymId to the
 * target organization's own Gym row: Branch.gymId must always match the
 * organization it's actually in, the same reason every organization gets
 * its own Gym row immediately at creation (host.controller.js#createListing).
 *
 * Also keeps GymListing.branchId (the "primary branch" pointer discovery,
 * inbox, and membership-plan defaults all read) in sync on both ends —
 * this was the actual bug behind a moved branch appearing to show up under
 * both its old and new organization at once: the branch's own gymListingId
 * was correctly updated, but the OLD listing's branchId kept pointing at
 * it, a second, unsynchronized "which branch is this" reference that never
 * agreed with the first once branches could move between organizations.
 */
const moveBranch = async (
  tenantDb,
  tenantId,
  branchId,
  targetListingId,
  { confirmOrganizationDeletion = false, movedByUserId = null } = {}
) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findByPk(branchId);
  if (!branch || branch.status !== 'ACTIVE') {
    throw createError('Branch not found', 404);
  }
  const sourceListingId = branch.gymListingId;
  if (sourceListingId === targetListingId) {
    return { branch };
  }

  const targetListing = await GymListing.findOne({ where: { id: targetListingId, tenantId } });
  if (!targetListing) {
    throw createError('Target organization not found', 404);
  }

  // Moving the last branch out empties the source organization just as
  // surely as deleting it does — same rule, same warning, same cascade.
  await _guardLastBranchInOrganization(tenantDb, branch, confirmOrganizationDeletion);

  let targetGym = await tenantDb.models.Gym.findOne({ where: { gymListingId: targetListingId } });
  if (!targetGym) {
    targetGym = await _getOrCreateGym(tenantDb, tenantId);
  }

  await branch.update({ gymListingId: targetListingId, gymId: targetGym.id });

  // The source listing's branchId pointer, if it was pointing at this
  // branch, is now stale — reassign it to another branch still left there,
  // or clear it if this was the last one.
  if (sourceListingId) {
    const sourceListing = await GymListing.findOne({ where: { id: sourceListingId, tenantId } });
    if (sourceListing && sourceListing.branchId === branchId) {
      const remainingBranch = await Branch.findOne({ where: { gymListingId: sourceListingId, status: 'ACTIVE' } });
      await sourceListing.update({ branchId: remainingBranch ? remainingBranch.id : null });
    }
  }

  // The target listing may never have had a primary branch (e.g. it was
  // created bare and had a branch moved into it) — give it one now rather
  // than leaving branchId null while it visibly has a real branch.
  if (!targetListing.branchId) {
    await targetListing.update({ branchId: branch.id });
  }

  // If that emptied the source organization, it goes too.
  try {
    await _deactivateOrganizationIfEmpty(
      tenantDb,
      sourceListingId,
      movedByUserId,
      `Organization emptied by moving its last branch "${branch.branchName}" to another organization`
    );
  } catch (orgErr) {
    console.warn('[Branch Move] Failed to deactivate the now-empty source organization:', orgErr.message);
  }

  return { branch };
};

/**
 * Moves `count` units of unbuilt (paid, reserved but not yet a real branch)
 * capacity from one organization to another. Also doesn't change total
 * usage — see moveBranch above.
 */
const transferReservedSlots = async (tenantId, fromListingId, toListingId, count = 1, actorUserId = null) => {
  if (fromListingId === toListingId) {
    throw createError('Source and target organization must be different', 400);
  }
  const t = await sequelize.transaction();
  try {
    const from = await GymListing.findOne({ where: { id: fromListingId, tenantId }, lock: true, transaction: t });
    const to = await GymListing.findOne({ where: { id: toListingId, tenantId }, lock: true, transaction: t });
    if (!from || !to) throw createError('Organization not found', 404);
    if (from.reservedSlots < count) throw createError('Not enough unbuilt slots on the source organization to move', 400);

    const { applied } = await subscriptionQuotaService.recordCapacityEvent(
      {
        tenantId,
        listingId: fromListingId,
        action: 'SLOT_TRANSFERRED',
        delta: -count,
        reservedSlotsBefore: from.reservedSlots,
        reservedSlotsAfter: from.reservedSlots - count,
        actorUserId,
        actorType: actorUserId ? 'HOST' : 'SYSTEM',
        reason: `${count} slot(s) moved to organization ${toListingId}`,
        // Single-transaction, platform-DB-only action (unlike deleteBranch's
        // cross-DB step) — a failure here rolls back everything atomically,
        // so there's no partial-failure state to dedupe against. The key
        // only needs to be unique, not tied to a retryable external event.
        idempotencyKey: `slot_transfer:${crypto.randomUUID()}`,
      },
      { transaction: t }
    );
    if (applied) {
      await from.decrement('reservedSlots', { by: count, transaction: t });
      await to.increment('reservedSlots', { by: count, transaction: t });
    }
    await t.commit();

    await Promise.all([from.reload(), to.reload()]);
    return { from, to };
  } catch (err) {
    await t.rollback();
    throw err;
  }
};

const updateBranch = async (tenantDb, branchId, data) => {
  const { Branch, MembershipPlan } = tenantDb.models;
  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  // If activating or setting traveler visibility active, enforce at least 1 active public plan
  if (data.status === 'ACTIVE' || data.travelerVisibilityStatus === 'active') {
    const activePublicPlansCount = await MembershipPlan.count({
      where: {
        branchId,
        status: 'ACTIVE',
        isPublic: true,
        isDeactivated: false,
      }
    });
    if (activePublicPlansCount === 0) {
      throw createError('Cannot publish or activate a branch without at least 1 active public membership plan', 400);
    }
  }

  const fields = ['branchName', 'address', 'cityId', 'areaId', 'latitude', 'longitude', 'openingTime', 'closingTime', 'phone', 'facilitiesJson', 'imagesJson', 'status', 'travelerVisibilityStatus', 'tagline', 'category', 'tagsJson', 'description', 'establishedYear', 'floorArea', 'addressLine1', 'addressLine2', 'postalCode', 'country'];
  fields.forEach((f) => {
    if (data[f] !== undefined) branch[f] = data[f];
  });
  // Support sending facilities as plain array (CMS form sends it as 'facilities')
  if (Array.isArray(data.facilities)) branch.facilitiesJson = data.facilities;
  if (Array.isArray(data.images)) branch.imagesJson = data.images;
  if (Array.isArray(data.tags)) branch.tagsJson = data.tags;
  await branch.save();

  return { branch };
};

const deleteBranch = async (tenantDb, branchId, deletedByUserId, { confirmOrganizationDeletion = false } = {}) => {
  const {
    Branch,
    MembershipPlan,
    MemberSubscription,
    GymStaff,
    Trainer,
    Announcement,
    ClassSchedule,
    StaffActionRequest,
  } = tenantDb.models;

  const t = await tenantDb.sequelize.transaction();
  let branch;
  try {
    // Row-locked fetch + guard, both inside the transaction — found via
    // concurrency testing that two near-simultaneous deletes of the same
    // branch (a duplicate client request, a retried tap) could BOTH pass an
    // unlocked "already deleted?" check before either committed, each then
    // independently crediting a reservedSlot for the same branch — a real
    // double-credit path, not just a display glitch. Locking here forces the
    // second call to wait for the first to commit, so it then correctly
    // sees INACTIVE and is rejected before ever reaching the capacity step.
    branch = await Branch.findByPk(branchId, { lock: true, transaction: t });
    if (!branch || branch.status === 'INACTIVE') {
      throw createError('Branch not found or already deleted', 404);
    }

    // An organization must never be left without a branch — warn before
    // taking its last one, unless the host has already confirmed they
    // understand the organization goes with it. Runs before any mutation so
    // a declined confirmation changes nothing.
    await _guardLastBranchInOrganization(tenantDb, branch, confirmOrganizationDeletion);

    // 1. Mark branch INACTIVE and traveler visibility deactivated
    await branch.update({
      status: 'INACTIVE',
      travelerVisibilityStatus: 'deactivated',
      deactivatedAt: new Date(),
      deactivatedBy: deletedByUserId || null,
      deactivationReason: 'Branch deleted by host/admin',
    }, { transaction: t });

    // 2. Cascade deactivation to all membership plans for this branch
    if (MembershipPlan) {
      await MembershipPlan.update(
        { status: 'INACTIVE', isPublic: false },
        { where: { branchId }, transaction: t }
      );
    }

    // 3. Cascade cancellation to all active/pending/frozen subscriptions on this branch
    if (MemberSubscription) {
      await MemberSubscription.update(
        { status: 'CANCELLED' },
        {
          where: {
            branchId,
            status: { [Op.in]: ['ACTIVE', 'PENDING', 'FROZEN', 'PAST_DUE'] },
          },
          transaction: t,
        }
      );
    }

    // 4. Terminate active staff assignments on this branch
    if (GymStaff) {
      await GymStaff.update(
        { employmentStatus: 'TERMINATED' },
        { where: { branchId, employmentStatus: 'ACTIVE' }, transaction: t }
      );
    }

    // 5. Cancel any pending staff action requests for this branch
    if (StaffActionRequest) {
      await StaffActionRequest.update(
        { status: 'CANCELLED' },
        { where: { branchId, status: 'PENDING' }, transaction: t }
      );
    }

    // 6. Deactivate/delete announcements, schedules, trainers for this branch
    if (Announcement) {
      await Announcement.destroy({ where: { branchId }, transaction: t });
    }
    if (ClassSchedule) {
      await ClassSchedule.destroy({ where: { branchId }, transaction: t });
    }
    if (Trainer) {
      await Trainer.update(
        { status: 'INACTIVE' },
        { where: { branchId }, transaction: t }
      );
    }

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  // 7. Give the organization back the capacity this branch was using, as an
  // unbuilt slot — the host already paid for it, deleting the branch
  // shouldn't make it disappear from their account, just from being built
  // out right now. This is a SEPARATE database (platform, not tenant), so it
  // can't share the transaction above — instead it's made idempotent
  // (keyed on this exact delete, via the deactivatedAt just committed) and
  // retried on transient failure, so a retry can never double-credit the
  // slot and a failure here never silently loses it the way a bare
  // try/catch would. See CapacityEvent.model.js.
  await _applyPlatformCapacityStep(async () => {
    const platformTx = await sequelize.transaction();
    try {
      await GymListing.update({ branchId: null }, { where: { branchId }, transaction: platformTx });
      if (branch.gymListingId) {
        const listing = await GymListing.findByPk(branch.gymListingId, { lock: true, transaction: platformTx });
        if (listing) {
          const { applied } = await subscriptionQuotaService.recordCapacityEvent(
            {
              tenantId: listing.tenantId,
              listingId: listing.id,
              branchId: branch.id,
              action: 'BRANCH_DELETED',
              delta: 1,
              reservedSlotsBefore: listing.reservedSlots,
              reservedSlotsAfter: listing.reservedSlots + 1,
              actorUserId: deletedByUserId || null,
              actorType: deletedByUserId ? 'HOST' : 'SYSTEM',
              reason: `Branch "${branch.branchName}" deleted`,
              idempotencyKey: `branch_delete:${branch.id}:${branch.deactivatedAt.getTime()}`,
            },
            { transaction: platformTx }
          );
          if (applied) {
            await listing.increment('reservedSlots', { by: 1, transaction: platformTx });
          }
        }
      }
      await platformTx.commit();
    } catch (err) {
      await platformTx.rollback();
      throw err;
    }
  }, '[Branch Deletion] Failed to return capacity to the organization after 3 attempts — reservedSlots may be understated until the reconciliation job corrects it');

  // 7b. If that was the organization's last branch, the organization goes
  // with it — see _deactivateOrganizationIfEmpty for why the capacity the
  // host paid for survives this untouched.
  try {
    await _deactivateOrganizationIfEmpty(
      tenantDb,
      branch.gymListingId,
      deletedByUserId,
      `Organization emptied by deletion of its last branch "${branch.branchName}"`
    );
  } catch (orgErr) {
    console.warn('[Branch Deletion] Failed to deactivate the now-empty organization:', orgErr.message);
  }

  // 8. Re-sync minPrice for the gym profile — this deleted branch's plans
  // are now INACTIVE and shouldn't factor into the gym's displayed minPrice.
  // Found broken during live end-to-end testing: this called a function
  // that was never in scope here (only ever defined, unexported, in
  // membership-plan.service.js), so it had silently no-op'd via the
  // catch below on every branch deletion — minPrice was never actually
  // updated after a delete.
  try {
    const membershipPlanService = require('./membership-plan.service');
    await membershipPlanService.syncMinPrice(tenantDb, branch.gymId);
  } catch (syncErr) {
    console.warn('[Branch Deletion] Warning re-syncing minPrice:', syncErr.message);
  }

  return { message: 'Branch deleted successfully' };
};

/**
 * Restores a branch previously closed via deleteBranch, flipping it back to
 * ACTIVE. Re-consumes exactly one unit of capacity, through the identical
 * check createBranch uses (this organization's own reserved slot first, else
 * fresh tenant-wide capacity) — restoring is "build again", not a free
 * undo. Deliberately does NOT restore member subscriptions, staff
 * employment, or republish membership plans/schedules: those all carry real
 * consent/legal/pricing weight and must be deliberate follow-up actions, not
 * a side effect of un-archiving the branch shell. No time limit on how long
 * after deletion this can happen — the branch's data is never purged — the
 * only gate is whether the capacity it used to hold is still available.
 */
const restoreBranch = async (tenantDb, tenantId, branchId, restoredByUserId) => {
  const { Branch } = tenantDb.models;

  // Row-locked for the branch's entire duration (held across the platform-DB
  // work below too) — same reasoning as deleteBranch's lock: an unlocked
  // "is this still INACTIVE?" check let two concurrent restores of the same
  // branch both pass, each independently consuming a capacity unit for what
  // is logically a single restore.
  const tt = await tenantDb.sequelize.transaction();
  let branch;
  try {
    branch = await Branch.findByPk(branchId, { lock: true, transaction: tt });
    if (!branch || branch.status !== 'INACTIVE') {
      throw createError('Branch not found or not currently deleted', 404);
    }
    if (!branch.gymListingId) {
      throw createError('This branch has no organization to restore into', 400);
    }
  } catch (err) {
    await tt.rollback();
    throw err;
  }

  const platformTx = await sequelize.transaction();
  try {
    const tenant = await Tenant.findByPk(tenantId, { lock: true, transaction: platformTx });
    if (!tenant) throw createError('Tenant not found', 404);

    const listing = await GymListing.findByPk(branch.gymListingId, { lock: true, transaction: platformTx });
    if (!listing || listing.status === 'INACTIVE') {
      throw createError('This branch\'s organization no longer exists — move it to another organization instead', 409);
    }

    const activeSub = await subscriptionQuotaService.getActiveSubscription(tenantId, { transaction: platformTx });
    if (activeSub && activeSub.overQuotaCount > 0) {
      const err = createError(
        'Your account is over its current plan\'s branch capacity following a recent downgrade. Upgrade your plan or close another branch before restoring this one.',
        403
      );
      err.code = 'account_over_quota';
      throw err;
    }

    const consumingReservedSlot = listing.reservedSlots > 0;
    if (!consumingReservedSlot) {
      const maxBranches = await subscriptionQuotaService.resolveMaxBranches(tenant, activeSub, { transaction: platformTx });
      const usedCapacity = await subscriptionQuotaService.getUsedCapacity(tenantId, tenantDb, { transaction: platformTx });
      if (usedCapacity >= maxBranches) {
        const err = createError('No free capacity to restore this branch — move an unused slot here or add capacity first', 403);
        err.code = 'branch_limit_reached';
        throw err;
      }
    }

    const { applied } = await subscriptionQuotaService.recordCapacityEvent(
      {
        tenantId,
        listingId: listing.id,
        branchId: branch.id,
        action: 'BRANCH_RESTORED',
        delta: consumingReservedSlot ? -1 : 0,
        reservedSlotsBefore: listing.reservedSlots,
        reservedSlotsAfter: consumingReservedSlot ? listing.reservedSlots - 1 : listing.reservedSlots,
        actorUserId: restoredByUserId || null,
        actorType: restoredByUserId ? 'HOST' : 'SYSTEM',
        reason: `Branch "${branch.branchName}" restored`,
        // Not timestamp-based (found broken: tenant DBs store deactivatedAt
        // as plain DATETIME with no fractional seconds, so two delete-then-
        // restore cycles on the same branch within the same wall-clock
        // second produced the SAME key — the second restore silently read
        // as "already applied" and skipped its own reservedSlots decrement,
        // leaving a phantom slot stuck forever). A random key is safe here
        // — unlike deleteBranch's capacity step, this one is a single
        // all-or-nothing platform-DB transaction (`platformTx` + the tenant-
        // DB `tt` both roll back together on any failure), so there's no
        // cross-transaction retry that needs a stable key to deduplicate
        // against; the row lock on `branch` acquired above already prevents
        // two concurrent restores of the same branch from both proceeding.
        idempotencyKey: `branch_restore:${branch.id}:${crypto.randomUUID()}`,
      },
      { transaction: platformTx }
    );
    if (applied && consumingReservedSlot) {
      await listing.decrement('reservedSlots', { by: 1, transaction: platformTx });
    }

    await platformTx.commit();
  } catch (err) {
    await platformTx.rollback();
    await tt.rollback();
    throw err;
  }

  // Still inside `tt` — the branch row lock acquired above has been held
  // this whole time, so no concurrent restore of this same branch could
  // have gotten this far in the meantime.
  await branch.update({
    status: 'ACTIVE',
    travelerVisibilityStatus: 'deactivated', // host re-publishes visibility explicitly, same as a brand-new branch
    deactivatedAt: null,
    deactivatedBy: null,
    deactivationReason: null,
  }, { transaction: tt });
  await tt.commit();

  return { branch };
};

/**
 * Deletes an organization (GymListing). Never silently drops branches: if it
 * has any real branches or unbuilt reserved slots, the caller must say what
 * happens to them first — 'moveBranches' reassigns everything (branches and
 * reservedSlots) to targetListingId, 'deleteBranches' soft-deletes each
 * branch the same way deleteBranch already does above (handling active
 * members/subscriptions properly, never a hard delete). Either way the
 * organization itself is soft-deleted (status INACTIVE), same as a branch.
 */
const deleteOrganization = async (tenantDb, tenantId, listingId, { strategy, targetListingId, deletedByUserId }) => {
  const listing = await GymListing.findOne({ where: { id: listingId, tenantId } });
  if (!listing || listing.status === 'INACTIVE') {
    throw createError('Organization not found or already deleted', 404);
  }

  const { Branch } = tenantDb.models;
  const branches = await Branch.findAll({ where: { gymListingId: listingId, status: 'ACTIVE' } });

  if (branches.length > 0 || listing.reservedSlots > 0) {
    if (strategy === 'moveBranches') {
      if (!targetListingId) throw createError('targetListingId is required to move branches', 400);
      if (targetListingId === listing.id) throw createError('Target organization must be different', 400);
      const target = await GymListing.findOne({ where: { id: targetListingId, tenantId } });
      if (!target) throw createError('Target organization not found', 404);

      let targetGym = await tenantDb.models.Gym.findOne({ where: { gymListingId: targetListingId } });
      if (!targetGym) targetGym = await _getOrCreateGym(tenantDb, tenantId);

      for (const branch of branches) {
        // eslint-disable-next-line no-await-in-loop
        await branch.update({ gymListingId: targetListingId, gymId: targetGym.id });
      }
      // Give the target a primary-branch pointer if it never had one — same
      // reasoning as moveBranch above. The source is about to be marked
      // INACTIVE below, so its own (now-stale) branchId doesn't need
      // reassigning here the way moveBranch does for a live organization.
      if (!target.branchId && branches.length > 0) {
        await target.update({ branchId: branches[0].id });
      }

      const reservedToMove = listing.reservedSlots;
      const platformTx = await sequelize.transaction();
      try {
        const lockedTarget = await GymListing.findByPk(targetListingId, { lock: true, transaction: platformTx });
        const lockedListing = await GymListing.findByPk(listingId, { lock: true, transaction: platformTx });
        const { applied } = await subscriptionQuotaService.recordCapacityEvent(
          {
            tenantId,
            listingId,
            action: 'ORG_BRANCHES_MOVED',
            delta: -(reservedToMove),
            reservedSlotsBefore: lockedListing.reservedSlots,
            reservedSlotsAfter: 0,
            actorUserId: deletedByUserId || null,
            actorType: deletedByUserId ? 'HOST' : 'SYSTEM',
            reason: `Organization deleted: ${branches.length} branch(es) and ${reservedToMove} slot(s) moved to ${targetListingId}`,
            idempotencyKey: `org_branches_moved:${listingId}:${crypto.randomUUID()}`,
          },
          { transaction: platformTx }
        );
        if (applied && reservedToMove > 0) {
          await lockedTarget.increment('reservedSlots', { by: reservedToMove, transaction: platformTx });
          await lockedListing.update({ reservedSlots: 0 }, { transaction: platformTx });
        }
        await platformTx.commit();
      } catch (err) {
        await platformTx.rollback();
        throw err;
      }
      await listing.reload();
    } else if (strategy === 'deleteBranches') {
      for (const branch of branches) {
        // Already an explicit "delete this whole organization" instruction —
        // the last-branch confirmation has effectively been given, so skip
        // the guard that would otherwise 409 on the final branch.
        // eslint-disable-next-line no-await-in-loop
        await deleteBranch(tenantDb, branch.id, deletedByUserId, { confirmOrganizationDeletion: true });
      }
      // reservedSlots are simply released back to the shared pool by
      // deleting the organization itself below — getUsedCapacity only sums
      // reservedSlots for organizations that still exist.
    } else {
      const err = createError(
        `This organization has ${branches.length} branch(es)` +
          `${listing.reservedSlots > 0 ? ` and ${listing.reservedSlots} unbuilt slot(s)` : ''}. ` +
          'Choose whether to move them to another organization or delete them.',
        409
      );
      err.code = 'organization_has_branches';
      throw err;
    }
  }

  await listing.update({ status: 'INACTIVE' });
  await subscriptionQuotaService.recordCapacityEvent(
    {
      tenantId,
      listingId,
      action: 'ORG_DELETED',
      delta: 0,
      reservedSlotsBefore: listing.reservedSlots,
      reservedSlotsAfter: listing.reservedSlots,
      actorUserId: deletedByUserId || null,
      actorType: deletedByUserId ? 'HOST' : 'SYSTEM',
      reason: `Organization "${listing.title}" deleted`,
      idempotencyKey: `org_deleted:${listingId}`,
    },
    { transaction: null }
  );
  return { message: 'Organization deleted successfully' };
};

// ── Staff ─────────────────────────────────────────────────────────────────────

const listStaff = async (tenantDb, branchId) => {
  const { Branch, GymStaff } = tenantDb.models;
  const branch = await Branch.findOne({
    where: { id: branchId, status: 'ACTIVE' },
  });
  if (!branch) throw createError('Branch not found or has been deleted', 404);

  const staff = await GymStaff.findAll({
    where: { branchId, employmentStatus: 'ACTIVE' },
    order: [['createdAt', 'ASC']],
  });

  return { branch, staff };
};

const assignStaff = async (tenantDb, branchId, userId, designation) => {
  const { Branch, GymStaff } = tenantDb.models;

  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  // Prevent duplicate active assignment
  const existing = await GymStaff.findOne({
    where: { branchId, userId, employmentStatus: 'ACTIVE' },
  });
  if (existing) throw createError('This user is already assigned to this branch', 409);

  const staffMember = await GymStaff.create({
    branchId,
    userId,
    designation: designation || null,
    employmentStatus: 'ACTIVE',
    status: 'active',
  });

  try {
    const { Tenant } = require('../models/platform');
    const notificationsService = require('./notifications.service');
    const tenant = await Tenant.findByPk(tenantDb.tenantId);
    const gymName = tenant ? tenant.gymName : 'your gym';
    await notificationsService.createNotification({
      userId,
      role: 'staff',
      type: 'staff_invite',
      title: 'New Staff Assignment',
      message: `You have been assigned as staff for ${branch.branchName} at ${gymName}.`,
      priority: 'high',
      deepLink: '/staff/dashboard',
      metadataJson: { branchId }
    });
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create staff assignment notification:', notifErr.message);
  }

  return { staffMember };
};

const removeStaff = async (tenantDb, branchId, staffId) => {
  const { GymStaff } = tenantDb.models;

  const staffMember = await GymStaff.findOne({ where: { id: staffId, branchId } });
  if (!staffMember) throw createError('Staff assignment not found', 404);

  await staffMember.update({ employmentStatus: 'TERMINATED' });
  return { message: 'Staff member removed from branch' };
};

// ── Gym profile images ────────────────────────────────────────────────────────

const addGymImages = async (tenantDb, tenantId, newUrls) => {
  const gym = await _getOrCreateGym(tenantDb, tenantId);
  const existing = Array.isArray(gym.imagesJson) ? gym.imagesJson : [];
  const combined = [...existing, ...newUrls];
  await gym.update({ imagesJson: combined });
  await _syncGymListing(tenantId, { imagesJson: combined });
  return { gym };
};

const removeGymImage = async (tenantDb, tenantId, imageUrl) => {
  const gym = await _getOrCreateGym(tenantDb, tenantId);
  const existing = Array.isArray(gym.imagesJson) ? gym.imagesJson : [];
  const updated = existing.filter((url) => url !== imageUrl);
  await gym.update({ imagesJson: updated });
  await _syncGymListing(tenantId, { imagesJson: updated });
  return { gym };
};

// ── Branch images ─────────────────────────────────────────────────────────────

const addBranchImages = async (tenantDb, branchId, newUrls) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  const existing = Array.isArray(branch.imagesJson) ? branch.imagesJson : [];
  const combined = [...existing, ...newUrls];
  await branch.update({ imagesJson: combined });
  return { branch };
};

const removeBranchImage = async (tenantDb, branchId, imageUrl) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findByPk(branchId);
  if (!branch) throw createError('Branch not found', 404);

  const existing = Array.isArray(branch.imagesJson) ? branch.imagesJson : [];
  const updated = existing.filter((url) => url !== imageUrl);
  await branch.update({ imagesJson: updated });
  return { branch };
};

// ── Members (tenant-scoped) ───────────────────────────────────────────────────
/**
 * Returns platform users who have a subscription record in this gym's tenant DB.
 * Gym hosts only ever see their own gym's members.
 */
const listMembers = async (tenantDb, tenantId, { q, status, branchId, page, limit, offset }) => {
  const { MemberSubscription, Branch } = tenantDb.models;

  const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
  const activeBranchIds = activeBranches.map((b) => b.id);
  if (activeBranchIds.length === 0) {
    return { members: [], pagination: buildPagination(0, page, limit) };
  }

  const subWhere = {
    status: ['ACTIVE', 'PENDING', 'FROZEN'],
  };
  if (branchId) {
    if (!activeBranchIds.includes(branchId)) {
      return { members: [], pagination: buildPagination(0, page, limit) };
    }
    subWhere.branchId = branchId;
  } else {
    subWhere.branchId = { [Op.in]: activeBranchIds };
  }

  // Get distinct userIds from active tenant subscriptions
  const subscriptions = await MemberSubscription.findAll({
    where: subWhere,
    attributes: ['userId'],
    group: ['userId'],
  });
  const userIds = subscriptions.map((s) => s.userId);

  if (userIds.length === 0) {
    return { members: [], pagination: buildPagination(0, page, limit) };
  }

  const where = { id: { [Op.in]: userIds } };
  if (status) where.status = status;
  if (q) {
    where[Op.or] = [
      { fullName: { [Op.like]: `%${q}%` } },
      { email: { [Op.like]: `%${q}%` } },
      { phone: { [Op.like]: `%${q}%` } },
    ];
  }

  const { count, rows } = await User.findAndCountAll({
    where,
    attributes: ['id', 'fullName', 'email', 'phone', 'status', 'profileImageUrl', 'createdAt'],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return { members: rows, pagination: buildPagination(count, page, limit) };
};

// ── Member search (by email) ──────────────────────────────────────────────────
const searchMember = async (email) => {
  const user = await User.findOne({
    where: { email: email.toLowerCase().trim() },
    attributes: ['id', 'fullName', 'email', 'phone', 'status', 'profileImageUrl', 'isVerified'],
  });
  return { user: user || null };
};

// ── Enroll member (walk-in or staff-assigned) ─────────────────────────────────
/**
 * @param {object|null} collection  Set when a REQUEST-tier submission was
 *   already marked collected before approval (see approval.service.js
 *   #markCollected). `{ collectedBy, collectedAt, collectionMethod }`.
 *   When present, the resulting Payment is attributed to the real collector
 *   and starts at STAFF_COLLECTED — awaiting the normal payments.verify step —
 *   instead of fabricating a COMPLETED payment credited to whoever approved
 *   the member. The subscription likewise stays PENDING until that verify,
 *   the same as any other collected-not-yet-verified payment in this app.
 */
const enrollMember = async (tenantDb, tenantId, { email, fullName, phone, planId, branchId, startDate, notes, paymentMethod }, enroller = { role: 'GYM_HOST' }, collection = null) => {
  const { MemberSubscription, MembershipPlan, MemberProfile } = tenantDb.models;
  const enrollerRole = typeof enroller === 'string' ? enroller : (enroller?.role || 'GYM_HOST');
  const enrollerId = typeof enroller === 'object' && enroller !== null
    ? (enroller.id || enroller.sub || enroller.userId || null)
    : null;
  const preCollected = !!(collection && collection.collectedBy);

  // Find or create platform user
  const [user, userCreated] = await User.findOrCreate({
    where: { email: email.toLowerCase().trim() },
    defaults: {
      fullName: fullName || email.split('@')[0],
      phone: phone || null,
      status: 'ACTIVE',
      isVerified: true,
      role: 'MEMBER',
    },
  });

  const plan = await MembershipPlan.findOne({ where: { id: planId, status: 'ACTIVE' } });
  if (!plan) throw createError('Plan not found or inactive', 404);

  const branch = await tenantDb.models.Branch.findOne({ where: { id: branchId } });
  if (!branch) throw createError('Branch not found', 404);
  if (branch.status !== 'ACTIVE') throw createError(`Branch is not active (current status: ${branch.status})`, 404);

  const today = new Date().toISOString().split('T')[0];
  const existing = await MemberSubscription.findOne({
    where: { userId: user.id, branchId, status: [SubscriptionStatus.ACTIVE, SubscriptionStatus.FROZEN, SubscriptionStatus.PENDING] },
    order: [['createdAt', 'DESC']],
  });

  if (existing) {
    if (existing.status === SubscriptionStatus.ACTIVE && existing.endDate && existing.endDate < today) {
      // Prior subscription has passed its end date, mark expired so new subscription can be enrolled
      await existing.update({ status: SubscriptionStatus.EXPIRED });
    } else if (existing.status === SubscriptionStatus.PENDING && enrollerRole === 'GYM_HOST') {
      // Pending subscription being enrolled by host: cancel previous pending record
      await existing.update({ status: SubscriptionStatus.CANCELLED, cancelledAt: new Date() });
    } else {
      throw createError(`Member already has an active subscription at this branch (valid until ${existing.endDate || 'active'}). Please use Renew or Change Plan instead.`, 409);
    }
  }

  const start = startDate || new Date().toISOString().split('T')[0];
  const end = _calcEndDate(start, plan.durationType, plan.durationValue);
  // A pre-collected payment isn't verified yet — the member and its
  // subscription can't be more "active" than the payment behind them, no
  // matter who approved the enrollment itself.
  const autoComplete = enrollerRole === 'GYM_HOST' && !preCollected;
  const qrCode = autoComplete ? `GE-${crypto.randomBytes(20).toString('hex').toUpperCase()}` : null;

  await MemberProfile.findOrCreate({ where: { userId: user.id }, defaults: { userId: user.id } });

  const { resolveCreatorRole } = require('../utils/audit.utils');
  const creatorRole = await resolveCreatorRole(tenantDb, enrollerId, enrollerRole, branchId);
  // On the approval-execute path `enroller` is always the approver (see
  // member.commands.js), never the person who actually collected the cash —
  // resolveCreatorRole has no way to know that and resolves 'HOST' every
  // time. Same fix as the Payment record below: attribute pre-collected
  // enrollments to the real collector, not whoever approved them.
  const recordCreatedBy = preCollected ? collection.collectedBy : (enrollerId || null);
  const recordCreatedByRole = preCollected ? 'STAFF' : creatorRole;

  const subscription = await MemberSubscription.create({
    userId: user.id,
    branchId,
    membershipPlanId: planId,
    startDate: start,
    endDate: end,
    status: autoComplete ? SubscriptionStatus.ACTIVE : SubscriptionStatus.PENDING,
    autoRenew: false,
    qrCode,
    subscribedAt: new Date(),
    remainingVisits: plan.visitLimit ?? null,
    sourceChannel: 'WALK_IN',
    notes: notes || null,
    createdBy: recordCreatedBy,
    createdByRole: recordCreatedByRole,
  });

  // Create unified Host notification for staff action pending approval
  if (!autoComplete) {
    try {
      const { Tenant, User: PlatformUser } = require('../models/platform');
      const notificationsService = require('./notifications.service');
      const tenant = await Tenant.findByPk(tenantId);

      const staffUser = enrollerId ? await PlatformUser.findByPk(enrollerId) : null;
      const staffName = staffUser ? staffUser.fullName : 'Staff';

      if (tenant && tenant.ownerUserId) {
        await notificationsService.createNotification({
          userId: tenant.ownerUserId,
          role: 'host',
          type: 'staff_action_pending',
          title: 'Pending Staff Action',
          message: `${staffName} requested to add member for ${user.fullName} at ${branch.branchName} — needs your approval.`,
          deepLink: '/host/subscriptions',
          metadataJson: { subscriptionId: subscription.id, branchId },
        });
      }
    } catch (notifErr) {
      console.warn('[Notification Error] Failed to create staff enrollment pending notification:', notifErr.message);
    }
  }

  // Cross-tenant platform index
  const gymListing = await GymListing.findOne({ where: { tenantId } });
  if (gymListing) {
    await UserGymMembership.create({
      userId: user.id,
      tenantId,
      gymListingId: gymListing.id,
      subscriptionId: subscription.id,
      gymName: gymListing.title,
      planName: plan.name,
      startDate: start,
      endDate: end,
      status: autoComplete ? SubscriptionStatus.ACTIVE : SubscriptionStatus.PENDING,
    }).catch(() => { }); // ignore duplicate
  }

  // Walk-in enrollment: create payment record.
  // GYM_HOST enrollments auto-complete; staff enrollments go to PENDING (collect box).
  const { Payment, Invoice } = tenantDb.models;
  const subtotal = parseFloat(plan.price);
  const joining = parseFloat(plan.joiningFee || 0);
  const security = parseFloat(plan.securityFee || 0);
  const totalAmount = subtotal + joining + security;

  const ledgerService = require('./ledger.service');
  const businessDate = await ledgerService.stampBusinessDate(tenantDb, branchId);

  const paymentStatus = preCollected
    ? PaymentStatus.STAFF_COLLECTED
    : (autoComplete ? PaymentStatus.COMPLETED : PaymentStatus.PENDING);

  const payment = await Payment.create({
    userId: user.id,
    paymentFor: 'MEMBERSHIP',
    referenceEntityId: subscription.id,
    branchId,
    method: (preCollected && collection.collectionMethod) || paymentMethod || 'CASH',
    amount: totalAmount,
    currency: 'PKR',
    status: paymentStatus,
    paidAt: autoComplete ? new Date() : null,
    // Pre-collected: the real collector, not the approver. Otherwise unchanged.
    createdBy: recordCreatedBy,
    createdByRole: recordCreatedByRole,
    staffCollectedBy: preCollected ? collection.collectedBy : null,
    collectedAt: preCollected ? collection.collectedAt : null,
    notes: preCollected ? 'Collected prior to member approval' : null,
    businessDate,
  });
  if (autoComplete || preCollected) ledgerService.notifyLedgerUpdated(tenantId, branchId, businessDate);

  const invoice = await Invoice.create({
    userId: user.id,
    invoiceNo: _invoiceNo(),
    invoiceType: 'MEMBERSHIP',
    referenceEntityId: subscription.id,
    branchId,
    subtotal,
    discountAmount: 0,
    taxAmount: 0,
    totalAmount,
    dueDate: new Date().toISOString().split('T')[0],
    paidAt: autoComplete ? new Date() : null,
    status: autoComplete ? InvoiceStatus.PAID : InvoiceStatus.ISSUED,
    createdBy: recordCreatedBy,
    createdByRole: recordCreatedByRole,
  });

  return { user, subscription, userCreated, payment, invoice };
};

/**
 * Update a member's own profile fields — the "Edit member" action behind
 * `members.update`. `memberUserId` must already have some subscription at
 * `branchId`; the caller checked that in validate() before this ever runs, so
 * it isn't re-checked here.
 */
const updateMemberProfile = async (tenantDb, memberUserId, { fullName, email, phone, notes }) => {
  const user = await User.findByPk(memberUserId);
  if (!user) throw createError('Member not found', 404);

  const patch = {};
  if (fullName !== undefined && fullName !== null && fullName.trim() !== '') patch.fullName = fullName.trim();
  if (phone !== undefined) patch.phone = phone ? phone.trim() : null;
  if (email !== undefined && email !== null && email.trim() !== '') {
    const normalized = email.trim().toLowerCase();
    if (normalized !== user.email) {
      const taken = await User.findOne({ where: { email: normalized } });
      if (taken && taken.id !== user.id) {
        throw createError('That email address is already in use by another account', 409);
      }
      patch.email = normalized;
    }
  }
  if (Object.keys(patch).length > 0) await user.update(patch);

  if (notes !== undefined) {
    const { MemberProfile } = tenantDb.models;
    const [profile] = await MemberProfile.findOrCreate({
      where: { userId: memberUserId },
      defaults: { userId: memberUserId },
    });
    await profile.update({ medicalNotes: notes || null });
  }

  return user.reload();
};

// ── Gym-wide staff management (GYM_HOST) ─────────────────────────────────────

/**
 * List all active staff across all branches for this gym.
 * Enriches each GymStaff record with platform user data.
 */
const listAllStaff = async (tenantDb) => {
  const { GymStaff, Branch } = tenantDb.models;

  const activeBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id', 'branchName'] });
  const activeBranchIds = activeBranches.map((b) => b.id);
  if (activeBranchIds.length === 0) return { staff: [] };

  const staffRecords = await GymStaff.findAll({
    where: {
      employmentStatus: 'ACTIVE',
      branchId: { [Op.in]: activeBranchIds },
    },
    order: [['createdAt', 'ASC']],
  });

  if (staffRecords.length === 0) return { staff: [] };

  const uniqueUserIds = [...new Set(staffRecords.map((s) => s.userId))];
  const users = await User.findAll({
    where: { id: uniqueUserIds },
    attributes: ['id', 'fullName', 'email', 'phone', 'status', 'role', 'profileImageUrl'],
  });
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  const branchMap = Object.fromEntries(activeBranches.map((b) => [b.id, b]));

  const staff = staffRecords.map((s) => ({
    id: s.id,
    userId: s.userId,
    branchId: s.branchId,
    designation: s.designation,
    employmentStatus: s.employmentStatus,
    createdAt: s.createdAt,
    user: userMap[s.userId] || null,
    branch: branchMap[s.branchId] || null,
  }));

  return { staff };
};

/**
 * Create a new staff user (BRANCH_MANAGER) and assign them to branches.
 * assignToAllBranches: if true, assign to every active branch in the gym.
 * branchIds: specific branch UUIDs to assign to (used when assignToAllBranches is false).
 */
const createStaffUser = async (tenantDb, { fullName, email, phone, password, designation, branchIds, assignToAllBranches }) => {
  const { GymStaff, Branch } = tenantDb.models;
  const { User, Tenant } = require('../models/platform');
  const bcrypt = require('bcrypt');
  const crypto = require('crypto');
  const notificationsService = require('./notifications.service');

  const emailClean = email.toLowerCase().trim();

  // Check if a staff/admin with this email already exists and is active in this gym
  const existingActiveStaff = await GymStaff.findOne({
    where: {
      email: emailClean,
      employmentStatus: 'ACTIVE',
    }
  });

  let existingUser = await User.findOne({ where: { email: emailClean } });
  let userActiveStaff = null;
  if (existingUser) {
    userActiveStaff = await GymStaff.findOne({
      where: {
        userId: existingUser.id,
        employmentStatus: 'ACTIVE',
      }
    });
  }

  const conflictStaff = existingActiveStaff || userActiveStaff;
  if (conflictStaff) {
    const existingRole = conflictStaff.designation || 'Staff/Admin';
    throw createError(
      `User with email "${emailClean}" is already assigned as ${existingRole}. Please remove them from ${existingRole} first before assigning a new role.`,
      409
    );
  }

  let tempPasswordGenerated = null;

  if (!existingUser) {
    tempPasswordGenerated = password || (crypto.randomBytes(4).toString('hex') + '!Aa1');
    const passwordHash = await bcrypt.hash(tempPasswordGenerated, 12);
    existingUser = await User.create({
      fullName: fullName || emailClean.split('@')[0],
      email: emailClean,
      phone: phone || null,
      passwordHash,
      role: 'BRANCH_MANAGER',
      status: 'ACTIVE',
      isVerified: true,
      emailVerified: true,
    });
  } else if (existingUser.role === 'MEMBER') {
    await existingUser.update({ role: 'BRANCH_MANAGER' });
  }

  let targetBranchIds = branchIds || [];
  if (assignToAllBranches) {
    const allBranches = await Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'] });
    targetBranchIds = allBranches.map((b) => b.id);
  }

  const staffRecords = [];
  const tenant = await Tenant.findByPk(tenantDb.tenantId);
  const gymName = tenant ? tenant.gymName : 'your gym';

  for (const branchId of targetBranchIds) {
    // Check if staff assignment already exists
    let staffMember = await GymStaff.findOne({
      where: {
        branchId,
        userId: existingUser.id,
      }
    });

    if (!staffMember) {
      staffMember = await GymStaff.findOne({
        where: {
          branchId,
          email: emailClean,
        }
      });
    }

    if (staffMember) {
      await staffMember.update({
        userId: existingUser.id,
        email: emailClean,
        designation: designation || staffMember.designation || 'Staff',
        employmentStatus: 'ACTIVE',
        status: 'active',
      });
      staffRecords.push(staffMember);
      continue;
    }

    staffMember = await GymStaff.create({
      userId: existingUser.id,
      email: emailClean,
      branchId,
      designation: designation || 'Staff',
      employmentStatus: 'ACTIVE',
      status: 'active',
    });
    staffRecords.push(staffMember);

    // Create notification
    try {
      const br = await Branch.findByPk(branchId);
      const brName = br ? br.branchName : 'branch';
      await notificationsService.createNotification({
        userId: existingUser.id,
        role: 'traveler',
        type: 'staff_invite',
        title: 'Staff / Admin Assignment',
        message: `You've been assigned to ${brName} as ${designation || 'staff'} for ${gymName}.`,
        priority: 'normal',
        metadataJson: { staffId: staffMember.id, branchId, tenantId: tenantDb.tenantId }
      });
    } catch (notifErr) {
      console.warn('[Notification Error] Failed to create staff assignment notification:', notifErr.message);
    }
  }

  return {
    user: {
      id: existingUser.id,
      fullName: existingUser.fullName,
      email: existingUser.email,
      phone: existingUser.phone || null,
      role: existingUser.role,
      status: existingUser.status,
    },
    tempPassword: tempPasswordGenerated,
    assignedBranches: staffRecords.length,
  };
};

/**
 * Remove a staff user from all branches (soft-deactivate all GymStaff records).
 */
const removeStaffUser = async (tenantDb, staffUserId) => {
  const { GymStaff } = tenantDb.models;
  const { Op } = require('sequelize');

  const [updated] = await GymStaff.update(
    { employmentStatus: 'TERMINATED', status: 'declined' },
    {
      where: {
        [Op.or]: [
          { userId: staffUserId },
          { email: String(staffUserId).toLowerCase().trim() }
        ],
        employmentStatus: 'ACTIVE'
      }
    }
  );
  if (updated === 0) throw createError('No active staff assignments found for this user', 404);
  return { message: 'Staff user removed from all branches' };
};

const checkAndTriggerPendingStaffInvites = async (user) => {
  try {
    const { Tenant } = require('../models/platform');
    const TenantDbManager = require('../database/TenantDbManager');
    const notificationsService = require('./notifications.service');

    const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
    for (const tenant of tenants) {
      try {
        const { models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const { GymStaff, Branch } = models;

        const invites = await GymStaff.findAll({
          where: {
            email: user.email.toLowerCase().trim(),
            status: 'pending',
            userId: null
          }
        });

        for (const invite of invites) {
          await invite.update({ userId: user.id });

          const br = await Branch.findByPk(invite.branchId);
          const brName = br ? br.branchName : 'branch';
          const gymName = tenant.gymName || 'your gym';

          await notificationsService.createNotification({
            userId: user.id,
            role: 'traveler',
            type: 'staff_invite',
            title: 'Staff Invitation',
            message: `You've been invited to join ${brName} as staff by ${gymName}. Tap to view details.`,
            priority: 'high',
            deepLink: `/traveler/staff-invite-confirmation?staffId=${invite.id}&tenantId=${tenant.id}`,
            metadataJson: { staffId: invite.id, branchId: invite.branchId, tenantId: tenant.id }
          });
        }
      } catch (err) {
        console.warn(`[Staff Invite Sync] Failed for tenant ${tenant.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Staff Invite Sync Error] Failed to scan pending invites:', err);
  }
};

module.exports = {
  getProfile,
  updateProfile,
  addGymImages,
  removeGymImage,
  listBranches,
  createBranch,
  getBranch,
  updateBranch,
  deleteBranch,
  restoreBranch,
  moveBranch,
  transferReservedSlots,
  deleteOrganization,
  listStaff,
  assignStaff,
  removeStaff,
  addBranchImages,
  removeBranchImage,
  listMembers,
  searchMember,
  enrollMember,
  updateMemberProfile,
  listAllStaff,
  createStaffUser,
  removeStaffUser,
  checkAndTriggerPendingStaffInvites,
  _countActiveBranchesForTenant,
  _createBranchRecord,
  _getOrCreateGym,
};
