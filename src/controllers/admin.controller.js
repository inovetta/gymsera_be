const adminService = require('../services/admin.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');

// ── GET /admin/tenants ────────────────────────────────────────────────────────
const listTenants = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { status } = req.query;
    const result = await adminService.listTenants({ status, page, limit, offset });
    return sendSuccess(res, { tenants: result.tenants }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/tenants/:id ────────────────────────────────────────────────────
const getTenant = async (req, res, next) => {
  try {
    const result = await adminService.getTenant(req.params.id);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── POST /admin/tenants/:id/approve ──────────────────────────────────────────
const approveTenant = async (req, res, next) => {
  try {
    const result = await adminService.approveTenant(req.params.id, req.user.sub);
    return sendSuccess(res, result, 'Tenant approved. Database provisioning has been queued.');
  } catch (err) {
    next(err);
  }
};

// ── POST /admin/tenants/:id/reject ────────────────────────────────────────────
const rejectTenant = async (req, res, next) => {
  try {
    const result = await adminService.rejectTenant(req.params.id, req.user.sub, req.body.reason);
    return sendSuccess(res, result, 'Tenant application rejected and host notified.');
  } catch (err) {
    next(err);
  }
};

module.exports = { listTenants, getTenant, approveTenant, rejectTenant };
