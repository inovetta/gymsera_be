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
    const result = await gymService.listBranches(req.tenantDb, req.user.tenantId);
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

// ── GET /gyms/members ─────────────────────────────────────────────────────────
const listMembers = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { q, status } = req.query;
    const result = await gymService.listMembers(req.tenantDb, req.user.tenantId, { q, status, page, limit, offset });
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
    const result = await gymService.enrollMember(req.tenantDb, req.user.tenantId, req.body, req.user.role);
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
};
