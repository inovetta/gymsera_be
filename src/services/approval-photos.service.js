const { Tenant, GymListing, PlatformAuditLog } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const TenantDbManager = require('../database/TenantDbManager');

/**
 * Phase 7 P9, NEW-158 / R-84: the photos an approval would publish, so the admin can look at them,
 * remove any that is not a real photo of the gym, and confirm before approving.
 *
 * - A first application (`tenantId`): the tenant's logo and cover and the main branch photos it sent
 *   (`mainBranchDataJson.imagesJson`, which provisioning copies onto the first branch).
 * - An additional organization (`tenantId:listingId`): the listing's cover and photos and the photos
 *   of its branches in the tenant database.
 */

const parseJson = (v) => {
  if (typeof v !== 'string') return v || {};
  try { return JSON.parse(v) || {}; } catch (e) { return {}; }
};

const urls = (list) => (Array.isArray(list) ? list.filter((u) => typeof u === 'string' && u) : []);

const splitId = (tenantId) => (tenantId.includes(':') ? tenantId.split(':') : [tenantId, undefined]);

const listingBranches = async (tenant, listingId) => {
  if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') return [];
  const { models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  return models.Branch.findAll({ where: { gymListingId: listingId }, order: [['createdAt', 'ASC']] });
};

/** @returns {Promise<Array<{ url: string, kind: 'logo'|'cover'|'gallery', branchId?: string }>>} */
const listApprovalPhotos = async (tenantId) => {
  const [actualTenantId, listingId] = splitId(tenantId);
  const tenant = await Tenant.findByPk(actualTenantId);
  if (!tenant) throw createError('Tenant not found', 404);

  if (!listingId) {
    return [
      ...(tenant.logoUrl ? [{ url: tenant.logoUrl, kind: 'logo' }] : []),
      ...(tenant.coverImageUrl ? [{ url: tenant.coverImageUrl, kind: 'cover' }] : []),
      ...urls(parseJson(tenant.mainBranchDataJson).imagesJson).map((url) => ({ url, kind: 'gallery' })),
    ];
  }

  const listing = await GymListing.findByPk(listingId);
  if (!listing || listing.tenantId !== tenant.id) throw createError('Gym listing not found', 404);
  const branches = await listingBranches(tenant, listingId);
  return [
    ...(listing.coverImageUrl ? [{ url: listing.coverImageUrl, kind: 'cover' }] : []),
    ...urls(listing.imagesJson).map((url) => ({ url, kind: 'gallery' })),
    ...branches.flatMap((b) => urls(b.imagesJson).map((url) => ({ url, kind: 'gallery', branchId: b.id }))),
  ];
};

/** Takes one photo off the application (or the listing / its branch). Audited. */
const removeApprovalPhoto = async (tenantId, imageUrl, adminUserId) => {
  const [actualTenantId, listingId] = splitId(tenantId);
  const tenant = await Tenant.findByPk(actualTenantId);
  if (!tenant) throw createError('Tenant not found', 404);

  let removedFrom = null;
  if (!listingId) {
    const data = parseJson(tenant.mainBranchDataJson);
    if (tenant.logoUrl === imageUrl) {
      await tenant.update({ logoUrl: null });
      removedFrom = 'logo';
    } else if (tenant.coverImageUrl === imageUrl) {
      await tenant.update({ coverImageUrl: null });
      removedFrom = 'cover';
    } else if (urls(data.imagesJson).includes(imageUrl)) {
      await tenant.update({ mainBranchDataJson: { ...data, imagesJson: urls(data.imagesJson).filter((u) => u !== imageUrl) } });
      removedFrom = 'gallery';
    }
  } else {
    const listing = await GymListing.findByPk(listingId);
    if (!listing || listing.tenantId !== tenant.id) throw createError('Gym listing not found', 404);
    if (listing.coverImageUrl === imageUrl) {
      await listing.update({ coverImageUrl: null });
      removedFrom = 'cover';
    } else if (urls(listing.imagesJson).includes(imageUrl)) {
      await listing.update({ imagesJson: urls(listing.imagesJson).filter((u) => u !== imageUrl) });
      removedFrom = 'gallery';
    } else {
      const branch = (await listingBranches(tenant, listingId)).find((b) => urls(b.imagesJson).includes(imageUrl));
      if (branch) {
        await branch.update({ imagesJson: urls(branch.imagesJson).filter((u) => u !== imageUrl) });
        removedFrom = `branch:${branch.id}`;
      }
    }
  }
  if (!removedFrom) throw createError('This photo is not on this application.', 404, 'photo_not_found');

  await require('./storage.service').deleteImage(imageUrl).catch(() => {});
  await PlatformAuditLog.create({
    actorUserId: adminUserId,
    action: 'admin.approval_photo_removed',
    targetType: 'Tenant',
    targetId: tenant.id,
    details: { listingId: listingId || null, removedFrom, imageUrl },
    createdAt: new Date(),
  });
  return { removedFrom };
};

/**
 * Records that the admin looked at the photos (R-84). Written before the approval changes anything;
 * if it cannot be written, the approval does not go ahead.
 */
const recordPhotosChecked = async (tenantId, adminUserId) => {
  const [actualTenantId, listingId] = splitId(tenantId);
  const photos = await listApprovalPhotos(tenantId);
  try {
    await PlatformAuditLog.create({
      actorUserId: adminUserId,
      action: 'admin.approval_photos_checked',
      targetType: 'Tenant',
      targetId: actualTenantId,
      details: { listingId: listingId || null, photoCount: photos.length },
      createdAt: new Date(),
    });
  } catch (err) {
    throw createError('Could not record the photo check, so the gym was not approved. Please try again.', 500);
  }
};

module.exports = { listApprovalPhotos, removeApprovalPhoto, recordPhotosChecked };
