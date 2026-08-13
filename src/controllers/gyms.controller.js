const gymService = require('../services/gym.service');
const { sendSuccess, createError, parsePagination } = require('../utils/response.utils');
const storageService = require('../services/storage.service');

// ── GET /gyms/profile ─────────────────────────────────────────────────────────
const getProfile = async (req, res, next) => {
  try {
    const result = await gymService.getProfile(req.tenantDb, req.user.tenantId);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── PATCH /gyms/profile ───────────────────────────────────────────────────────
const updateProfile = async (req, res, next) => {
  try {
    const result = await gymService.updateProfile(req.tenantDb, req.user.tenantId, req.body);
    return sendSuccess(res, result, 'Gym profile updated successfully');
  } catch (err) {
    next(err);
  }
};

// ── GET /gyms/branches ────────────────────────────────────────────────────────
const listBranches = async (req, res, next) => {
  try {
    const organizationId = req.params.gymId || req.params.listingId || req.query.organizationId || req.query.gymId;
    const result = await gymService.listBranches(req.tenantDb, req.user.tenantId, organizationId);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── POST /gyms/branches ───────────────────────────────────────────────────────
const createBranch = async (req, res, next) => {
  try {
    const result = await gymService.createBranch(req.tenantDb, req.user.tenantId, req.body);
    return sendSuccess(res, result, 'Branch created successfully', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /gyms/branches/:branchId ──────────────────────────────────────────────
const getBranch = async (req, res, next) => {
  try {
    const result = await gymService.getBranch(req.tenantDb, req.params.branchId);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── PATCH /gyms/branches/:branchId ───────────────────────────────────────────
const updateBranch = async (req, res, next) => {
  try {
    const result = await gymService.updateBranch(req.tenantDb, req.params.branchId, req.body);
    return sendSuccess(res, result, 'Branch updated successfully');
  } catch (err) {
    next(err);
  }
};

// ── DELETE /gyms/branches/:branchId ──────────────────────────────────────────
const deleteBranch = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password) {
      throw createError('Password is required to delete a branch', 400);
    }
    
    const { User: PlatformUser } = require('../models/platform');
    const bcrypt = require('bcrypt');
    
    const user = await PlatformUser.findByPk(req.user.sub);
    if (!user || !user.passwordHash) {
      throw createError('Your account uses social login and cannot verify a password. Please contact support to delete the branch.', 400);
    }
    
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      throw createError('Incorrect password', 401);
    }

    const result = await gymService.deleteBranch(req.tenantDb, req.params.branchId);
    return sendSuccess(res, null, result.message);
  } catch (err) {
    next(err);
  }
};

// ── GET /gyms/branches/:branchId/staff ────────────────────────────────────────
const listStaff = async (req, res, next) => {
  try {
    const result = await gymService.listStaff(req.tenantDb, req.params.branchId);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── POST /gyms/branches/:branchId/staff ──────────────────────────────────────
const assignStaff = async (req, res, next) => {
  try {
    const result = await gymService.assignStaff(
      req.tenantDb,
      req.params.branchId,
      req.body.userId,
      req.body.designation
    );

    // Notify the host
    try {
      const { Tenant } = require('../models/platform');
      const notificationsService = require('../services/notifications.service');
      const tenant = await Tenant.findByPk(req.tenantDb.tenantId);
      if (tenant && tenant.ownerUserId) {
        await notificationsService.createNotification({
          userId: tenant.ownerUserId,
          type: 'staff_update',
          title: 'New Staff Assigned',
          body: `A new staff member has been successfully assigned to your branch.`,
          metadata: {
            route: '/host/staff',
            branchId: req.params.branchId,
          }
        });
      }
    } catch (notifErr) {
      console.warn('[Notification Error] Failed to create staff assignment notification:', notifErr.message);
    }

    return sendSuccess(res, result, 'Staff member assigned to branch', 201);
  } catch (err) {
    next(err);
  }
};

// ── DELETE /gyms/branches/:branchId/staff/:staffId ───────────────────────────
const removeStaff = async (req, res, next) => {
  try {
    const result = await gymService.removeStaff(req.tenantDb, req.params.branchId, req.params.staffId);
    return sendSuccess(res, null, result.message);
  } catch (err) {
    next(err);
  }
};

// ── POST /gyms/profile/logo ───────────────────────────────────────────────────
const uploadLogo = async (req, res, next) => {
  try {
    if (!req.file) throw createError('Image file is required', 422);
    const { gym } = await gymService.getProfile(req.tenantDb, req.user.tenantId);
    if (gym.logoUrl) await storageService.deleteImage(gym.logoUrl).catch(() => {});
    const logoUrl = await storageService.uploadImage(req.file.buffer, req.file.mimetype, 'gyms/logos', `gym-${req.user.tenantId}`);
    await gymService.updateProfile(req.tenantDb, req.user.tenantId, { logoUrl });
    return sendSuccess(res, { logoUrl }, 'Logo uploaded');
  } catch (err) {
    next(err);
  }
};

// ── POST /gyms/profile/cover ──────────────────────────────────────────────────
const uploadCover = async (req, res, next) => {
  try {
    if (!req.file) throw createError('Image file is required', 422);
    const { gym } = await gymService.getProfile(req.tenantDb, req.user.tenantId);
    if (gym.coverImageUrl) await storageService.deleteImage(gym.coverImageUrl).catch(() => {});
    const coverImageUrl = await storageService.uploadImage(req.file.buffer, req.file.mimetype, 'gyms/covers', `gym-${req.user.tenantId}`);
    await gymService.updateProfile(req.tenantDb, req.user.tenantId, { coverImageUrl });
    return sendSuccess(res, { coverImageUrl }, 'Cover image uploaded');
  } catch (err) {
    next(err);
  }
};

// ── POST /gyms/profile/images ─────────────────────────────────────────────────
const uploadGymImages = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) throw createError('At least one image is required', 422);
    const urls = await storageService.uploadImages(req.files, `gyms/${req.user.tenantId}/images`);
    const result = await gymService.addGymImages(req.tenantDb, req.user.tenantId, urls);
    return sendSuccess(res, { gym: result.gym, uploadedUrls: urls }, 'Images uploaded');
  } catch (err) {
    next(err);
  }
};

// ── DELETE /gyms/profile/images ───────────────────────────────────────────────
const deleteGymImage = async (req, res, next) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) throw createError('imageUrl is required', 422);
    await storageService.deleteImage(imageUrl).catch(() => {});
    const result = await gymService.removeGymImage(req.tenantDb, req.user.tenantId, imageUrl);
    return sendSuccess(res, { gym: result.gym }, 'Image removed');
  } catch (err) {
    next(err);
  }
};

// ── POST /gyms/branches/:branchId/images ─────────────────────────────────────
const uploadBranchImages = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) throw createError('At least one image is required', 422);
    const storageService = require('../services/storage.service');
    const urls = await storageService.uploadImages(req.files, `branches/${req.params.branchId}/images`);
    const result = await gymService.addBranchImages(req.tenantDb, req.params.branchId, urls);
    return sendSuccess(res, { branch: result.branch, uploadedUrls: urls }, 'Images uploaded');
  } catch (err) {
    next(err);
  }
};

// ── DELETE /gyms/branches/:branchId/images ───────────────────────────────────
const deleteBranchImage = async (req, res, next) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) throw createError('imageUrl is required', 422);
    const storageService = require('../services/storage.service');
    await storageService.deleteImage(imageUrl).catch(() => {});
    const result = await gymService.removeBranchImage(req.tenantDb, req.params.branchId, imageUrl);
    return sendSuccess(res, { branch: result.branch }, 'Image removed');
  } catch (err) {
    next(err);
  }
};

const listMembers = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { q, status } = req.query;
    let branchId = req.query.branchId;

    if (req.user.role === 'BRANCH_MANAGER') {
      branchId = req.user.branchId;
    }

    const result = await gymService.listMembers(req.tenantDb, req.user.tenantId, { q, status, branchId, page, limit, offset });
    return sendSuccess(res, { members: result.members }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── GET /gyms/members/search?email=... ────────────────────────────────────────
const searchMember = async (req, res, next) => {
  try {
    const { email } = req.query;
    if (!email) throw createError('email query param is required', 422);
    const result = await gymService.searchMember(email);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── POST /gyms/members/enroll ─────────────────────────────────────────────────
const enrollMember = async (req, res, next) => {
  try {
    const result = await gymService.enrollMember(req.tenantDb, req.user.tenantId, req.body, req.user);
    return sendSuccess(res, result, 'Member enrolled successfully', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /gyms/staff ───────────────────────────────────────────────────────────
const listAllStaff = async (req, res, next) => {
  try {
    const result = await gymService.listAllStaff(req.tenantDb);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── POST /gyms/staff ──────────────────────────────────────────────────────────
const createStaffUser = async (req, res, next) => {
  try {
    const result = await gymService.createStaffUser(req.tenantDb, req.body);
    return sendSuccess(res, result, 'Staff user created successfully', 201);
  } catch (err) {
    next(err);
  }
};

// ── DELETE /gyms/staff/:userId ────────────────────────────────────────────────
const removeStaffUser = async (req, res, next) => {
  try {
    const result = await gymService.removeStaffUser(req.tenantDb, req.params.userId);
    return sendSuccess(res, null, result.message);
  } catch (err) {
    next(err);
  }
};

// ── GET /host/branches/:branchId/listing-content ─────────────────────────────
const getBranchListingContent = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const result = await gymService.getBranch(req.tenantDb, branchId);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── PATCH /host/branches/:branchId/listing-content ───────────────────────────
const updateBranchListingContent = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { 
      branchName, 
      tagline, 
      category, 
      tagsJson, 
      facilitiesJson, 
      imagesJson,
      openingTime,
      closingTime,
      address,
      phone,
      latitude,
      longitude,
      status,
      description,
      establishedYear,
      floorArea,
      addressLine1,
      addressLine2,
      postalCode,
      country,
      cityId,
      areaId,
    } = req.body;

    const patch = {};
    if (branchName !== undefined) patch.branchName = branchName;
    if (tagline !== undefined) patch.tagline = tagline;
    if (category !== undefined) patch.category = category;
    if (tagsJson !== undefined) patch.tagsJson = tagsJson;
    if (facilitiesJson !== undefined) patch.facilitiesJson = facilitiesJson;
    if (imagesJson !== undefined) patch.imagesJson = imagesJson;
    if (openingTime !== undefined) patch.openingTime = openingTime;
    if (closingTime !== undefined) patch.closingTime = closingTime;
    if (address !== undefined) patch.address = address;
    if (phone !== undefined) patch.phone = phone;
    if (latitude !== undefined) patch.latitude = latitude;
    if (longitude !== undefined) patch.longitude = longitude;
    if (status !== undefined) patch.status = status;
    if (description !== undefined) patch.description = description;
    if (establishedYear !== undefined) patch.establishedYear = establishedYear;
    if (floorArea !== undefined) patch.floorArea = floorArea;
    if (addressLine1 !== undefined) patch.addressLine1 = addressLine1;
    if (addressLine2 !== undefined) patch.addressLine2 = addressLine2;
    if (postalCode !== undefined) patch.postalCode = postalCode;
    if (country !== undefined) patch.country = country;
    if (cityId !== undefined) patch.cityId = cityId;
    if (areaId !== undefined) patch.areaId = areaId;

    const result = await gymService.updateBranch(req.tenantDb, branchId, patch);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getProfile,
  updateProfile,
  uploadLogo,
  uploadCover,
  uploadGymImages,
  deleteGymImage,
  listBranches,
  createBranch,
  getBranch,
  updateBranch,
  deleteBranch,
  listStaff,
  assignStaff,
  removeStaff,
  uploadBranchImages,
  deleteBranchImage,
  listMembers,
  searchMember,
  enrollMember,
  listAllStaff,
  createStaffUser,
  removeStaffUser,
  getBranchListingContent,
  updateBranchListingContent,
};

