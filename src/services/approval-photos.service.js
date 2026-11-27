const { Tenant, PlatformAuditLog } = require('../models/platform');
const { createError } = require('../utils/response.utils');

/**
 * Phase 7 P9, NEW-158 / R-84: the photos an approval would publish, so the admin can look at them,
 * remove any that is not a real photo of the gym, and confirm before approving.
 *
 * A first application (`organizationId`): the organization's logo and cover and the first branch photos it sent
 * (`firstBranchDraft.imagesJson`, which the first business holds until its own approval, NEW-303 M2d). There is no
 * compound `organizationId:businessId` id any more (audit F7); a business's photos are part of its own approval.
 */

const parseJson = (v) => {
  if (typeof v !== 'string') return v || {};
  try { return JSON.parse(v) || {}; } catch (e) { return {}; }
};

const urls = (list) => (Array.isArray(list) ? list.filter((u) => typeof u === 'string' && u) : []);

/** @returns {Promise<Array<{ url: string, kind: 'logo'|'cover'|'gallery', branchId?: string }>>} */
const listApprovalPhotos = async (organizationId) => {
  const tenant = await Tenant.findByPk(organizationId);
  if (!tenant) throw createError('Tenant not found', 404);
  return [
    ...(tenant.logoUrl ? [{ url: tenant.logoUrl, kind: 'logo' }] : []),
    ...(tenant.coverImageUrl ? [{ url: tenant.coverImageUrl, kind: 'cover' }] : []),
    ...urls(parseJson(tenant.firstBranchDraft).imagesJson).map((url) => ({ url, kind: 'gallery' })),
  ];
};

/** Takes one photo off the application. Audited. */
const removeApprovalPhoto = async (organizationId, imageUrl, adminUserId) => {
  const tenant = await Tenant.findByPk(organizationId);
  if (!tenant) throw createError('Tenant not found', 404);

  let removedFrom = null;
  const data = parseJson(tenant.firstBranchDraft);
  if (tenant.logoUrl === imageUrl) {
    await tenant.update({ logoUrl: null });
    removedFrom = 'logo';
  } else if (tenant.coverImageUrl === imageUrl) {
    await tenant.update({ coverImageUrl: null });
    removedFrom = 'cover';
  } else if (urls(data.imagesJson).includes(imageUrl)) {
    await tenant.update({ firstBranchDraft: { ...data, imagesJson: urls(data.imagesJson).filter((u) => u !== imageUrl) } });
    removedFrom = 'gallery';
  }
  if (!removedFrom) throw createError('This photo is not on this application.', 404, 'photo_not_found');

  await require('./storage.service').deleteImage(imageUrl).catch(() => {});
  await PlatformAuditLog.create({
    actorUserId: adminUserId,
    action: 'admin.approval_photo_removed',
    targetType: 'Tenant',
    targetId: tenant.id,
    details: { removedFrom, imageUrl },
    createdAt: new Date(),
  });
  return { removedFrom };
};

/**
 * Records that the admin looked at the photos (R-84). Written before the approval changes anything;
 * if it cannot be written, the approval does not go ahead.
 */
const recordPhotosChecked = async (organizationId, adminUserId) => {
  const photos = await listApprovalPhotos(organizationId);
  try {
    await PlatformAuditLog.create({
      actorUserId: adminUserId,
      action: 'admin.approval_photos_checked',
      targetType: 'Tenant',
      targetId: organizationId,
      details: { photoCount: photos.length },
      createdAt: new Date(),
    });
  } catch (err) {
    throw createError('Could not record the photo check, so the gym was not approved. Please try again.', 500);
  }
};

module.exports = { listApprovalPhotos, removeApprovalPhoto, recordPhotosChecked };
