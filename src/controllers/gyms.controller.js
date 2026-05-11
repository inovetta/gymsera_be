const gymService = require('../services/gym.service');
const { sendSuccess } = require('../utils/response.utils');

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

module.exports = {
  getProfile,
  updateProfile,
  listBranches,
  createBranch,
  getBranch,
  updateBranch,
  deleteBranch,
  listStaff,
  assignStaff,
  removeStaff,
};
