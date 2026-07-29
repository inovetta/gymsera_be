const adminService = require('../services/admin.service');
const { sendSuccess, parsePagination, createError } = require('../utils/response.utils');

// ── POST /admin/tenants ───────────────────────────────────────────────────────
const createTenant = async (req, res, next) => {
  try {
    const result = await adminService.createTenant(req.body);
    return sendSuccess(res, result, 'Tenant created successfully', 201);
  } catch (err) {
    next(err);
  }
};

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
    return sendSuccess(res, result, 'Tenant approved and database provisioned successfully.');
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

// ── POST /admin/tenants/:id/suspend ──────────────────────────────────────────
const suspendTenant = async (req, res, next) => {
  try {
    const result = await adminService.suspendTenant(req.params.id, req.user.sub, req.body.reason);
    return sendSuccess(res, result, 'Tenant suspended.');
  } catch (err) {
    next(err);
  }
};

// ── POST /admin/tenants/:id/reactivate ───────────────────────────────────────
const reactivateTenant = async (req, res, next) => {
  try {
    const result = await adminService.reactivateTenant(req.params.id, req.user.sub);
    return sendSuccess(res, result, 'Tenant reactivated.');
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/tenants/:id/branches ──────────────────────────────────────────
const getTenantBranches = async (req, res, next) => {
  try {
    const result = await adminService.getTenantBranches(req.params.id);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── PATCH /admin/tenants/:id/branches/:branchId/status ───────────────────────
const updateTenantBranchStatus = async (req, res, next) => {
  try {
    const result = await adminService.updateTenantBranchStatus(req.params.id, req.params.branchId, req.body.status);
    return sendSuccess(res, result, 'Branch status updated.');
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/tenants/:id/members ────────────────────────────────────────────
const getTenantMembers = async (req, res, next) => {
  try {
    const { page, limit } = parsePagination(req.query);
    const result = await adminService.getTenantMembers(req.params.id, { page, limit });
    return sendSuccess(res, { members: result.members }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/tenants/:id/membership-plans ───────────────────────────────────
const getTenantMembershipPlans = async (req, res, next) => {
  try {
    const result = await adminService.getTenantMembershipPlans(req.params.id);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── POST /admin/tenants/:id/logo ──────────────────────────────────────────────
const uploadTenantLogo = async (req, res, next) => {
  try {
    if (!req.file) return next(createError('No file uploaded', 422));
    const result = await adminService.uploadTenantLogo(req.params.id, req.file.buffer, req.file.mimetype);
    return sendSuccess(res, result, 'Logo uploaded');
  } catch (err) { next(err); }
};

// ── POST /admin/tenants/:id/cover ─────────────────────────────────────────────
const uploadTenantCover = async (req, res, next) => {
  try {
    if (!req.file) return next(createError('No file uploaded', 422));
    const result = await adminService.uploadTenantCover(req.params.id, req.file.buffer, req.file.mimetype);
    return sendSuccess(res, result, 'Cover image uploaded');
  } catch (err) { next(err); }
};

// ── GET /admin/tenants/:id/subscriptions ──────────────────────────────────────
const getTenantSubscriptions = async (req, res, next) => {
  try {
    const result = await adminService.getTenantSubscriptions(req.params.id);
    return sendSuccess(res, result);
  } catch (err) { next(err); }
};

// ── POST /admin/tenants/:id/subscriptions ─────────────────────────────────────
const assignTenantSubscription = async (req, res, next) => {
  try {
    const result = await adminService.assignTenantSubscription(req.params.id, req.body, req.user.sub);
    return sendSuccess(res, result, 'Subscription assigned', 201);
  } catch (err) { next(err); }
};

// ── PATCH /admin/tenants/:id/subscriptions/:subId/revoke ──────────────────────
const revokeTenantSubscription = async (req, res, next) => {
  try {
    const result = await adminService.revokeTenantSubscription(req.params.id, req.params.subId);
    return sendSuccess(res, result, 'Subscription revoked');
  } catch (err) { next(err); }
};

// ── GET /admin/tenants/:id/invoices ───────────────────────────────────────────
const getTenantInvoices = async (req, res, next) => {
  try {
    const { page, limit } = parsePagination(req.query);
    const result = await adminService.getTenantInvoices(req.params.id, { page, limit });
    return sendSuccess(res, { invoices: result.invoices }, 'OK', 200, result.pagination);
  } catch (err) { next(err); }
};

// ── POST /admin/tenants/:id/invoices ──────────────────────────────────────────
const createTenantInvoice = async (req, res, next) => {
  try {
    const result = await adminService.createTenantInvoice(req.params.id, req.body, req.user.sub);
    return sendSuccess(res, result, 'Invoice created', 201);
  } catch (err) { next(err); }
};

// ── PATCH /admin/tenants/:id/invoices/:invoiceId ──────────────────────────────
const updateTenantInvoice = async (req, res, next) => {
  try {
    const result = await adminService.updateTenantInvoice(req.params.id, req.params.invoiceId, req.body);
    return sendSuccess(res, result, 'Invoice updated');
  } catch (err) { next(err); }
};

// ── POST /admin/tenants/:id/invoices/:invoiceId/send-reminder ─────────────────
const sendInvoiceReminder = async (req, res, next) => {
  try {
    const { PlatformInvoice, Tenant, User } = require('../models/platform');
    const invoice = await PlatformInvoice.findOne({ where: { id: req.params.invoiceId, tenantId: req.params.id } });
    if (!invoice) return next(require('../utils/response.utils').createError('Invoice not found', 404));
    if (!['ISSUED', 'OVERDUE'].includes(invoice.status)) {
      return next(require('../utils/response.utils').createError('Reminder can only be sent for ISSUED or OVERDUE invoices', 400));
    }
    const tenant = await Tenant.findByPk(req.params.id, { include: [{ model: User, as: 'owner', attributes: ['fullName', 'email'] }] });
    if (tenant?.owner) {
      const emailService = require('../services/email.service');
      await emailService.sendPlatformInvoiceReminderEmail(tenant.owner.email, tenant.owner.fullName, {
        invoiceNo: invoice.invoiceNo,
        description: invoice.description,
        totalAmount: invoice.totalAmount,
        dueDate: invoice.dueDate,
        businessName: tenant.businessName,
      });
    }
    return sendSuccess(res, null, 'Reminder email sent');
  } catch (err) { next(err); }
};

// ── POST /admin/tenants/:id/invoices/:invoiceId/send-confirmation ──────────────
const sendInvoiceConfirmation = async (req, res, next) => {
  try {
    const { PlatformInvoice, Tenant, User } = require('../models/platform');
    const invoice = await PlatformInvoice.findOne({ where: { id: req.params.invoiceId, tenantId: req.params.id } });
    if (!invoice) return next(require('../utils/response.utils').createError('Invoice not found', 404));
    if (invoice.status !== 'PAID') {
      return next(require('../utils/response.utils').createError('Confirmation can only be sent for PAID invoices', 400));
    }
    const tenant = await Tenant.findByPk(req.params.id, { include: [{ model: User, as: 'owner', attributes: ['fullName', 'email'] }] });
    if (tenant?.owner) {
      const emailService = require('../services/email.service');
      await emailService.sendPlatformInvoicePaidEmail(tenant.owner.email, tenant.owner.fullName, {
        invoiceNo: invoice.invoiceNo,
        description: invoice.description,
        totalAmount: invoice.totalAmount,
        paidAt: invoice.paidAt,
        businessName: tenant.businessName,
      });
    }
    return sendSuccess(res, null, 'Payment confirmation email sent');
  } catch (err) { next(err); }
};

const deleteTenant = async (req, res, next) => {
  try {
    await adminService.deleteTenant(req.params.id);
    return sendSuccess(res, null, 'Tenant deleted');
  } catch (err) { next(err); }
};

const syncSubscriptions = async (req, res, next) => {
  try {
    const { runExpiryCheck } = require('../jobs/subscription-expiry.cron');
    runExpiryCheck().catch((err) => console.error('[Manual sync] error:', err.message));
    return sendSuccess(res, null, 'Subscription sync triggered');
  } catch (err) { next(err); }
};

const getPlatformStats = async (req, res, next) => {
  try {
    const stats = await adminService.getPlatformStats();
    return sendSuccess(res, stats);
  } catch (err) { next(err); }
};

const getPlatformAnalytics = async (req, res, next) => {
  try {
    const analytics = await adminService.getPlatformAnalytics(req.query.period);
    return sendSuccess(res, analytics);
  } catch (err) { next(err); }
};

// ── Gym listing management ─────────────────────────────────────────────────────
const getGymListing = async (req, res, next) => {
  try {
    const result = await adminService.getGymListing(req.params.id);
    return sendSuccess(res, result);
  } catch (err) { next(err); }
};

const createGymListing = async (req, res, next) => {
  try {
    const result = await adminService.createGymListing(req.params.id, req.body);
    return sendSuccess(res, result, 'Gym listing created', 201);
  } catch (err) { next(err); }
};

const updateGymListing = async (req, res, next) => {
  try {
    const result = await adminService.updateGymListing(req.params.id, req.body);
    return sendSuccess(res, result, 'Gym listing updated');
  } catch (err) { next(err); }
};

const uploadGymListingLogo = async (req, res, next) => {
  try {
    if (!req.file) throw { status: 422, message: 'Image file is required' };
    const result = await adminService.uploadGymListingLogo(req.params.id, req.file.buffer, req.file.mimetype);
    return sendSuccess(res, result, 'Logo uploaded');
  } catch (err) { next(err); }
};

const uploadGymListingCover = async (req, res, next) => {
  try {
    if (!req.file) throw { status: 422, message: 'Image file is required' };
    const result = await adminService.uploadGymListingCover(req.params.id, req.file.buffer, req.file.mimetype);
    return sendSuccess(res, result, 'Cover image uploaded');
  } catch (err) { next(err); }
};

const uploadGymListingImages = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) throw { status: 422, message: 'At least one image is required' };
    const result = await adminService.uploadGymListingImages(req.params.id, req.files);
    return sendSuccess(res, result, 'Images uploaded');
  } catch (err) { next(err); }
};

const deleteGymListingImage = async (req, res, next) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) throw { status: 422, message: 'imageUrl is required' };
    await adminService.deleteGymListingImage(req.params.id, imageUrl);
    return sendSuccess(res, null, 'Image removed');
  } catch (err) { next(err); }
};

// ── Admin branch management ───────────────────────────────────────────────────
const createAdminTenantBranch = async (req, res, next) => {
  try {
    const result = await adminService.createAdminTenantBranch(req.params.id, req.body);
    return sendSuccess(res, result, 'Branch created', 201);
  } catch (err) { next(err); }
};

const updateAdminTenantBranch = async (req, res, next) => {
  try {
    const result = await adminService.updateAdminTenantBranch(req.params.id, req.params.branchId, req.body);
    return sendSuccess(res, result, 'Branch updated');
  } catch (err) { next(err); }
};

const uploadAdminBranchImages = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) throw { status: 422, message: 'At least one image is required' };
    const result = await adminService.uploadAdminBranchImages(req.params.id, req.params.branchId, req.files);
    return sendSuccess(res, result, 'Images uploaded');
  } catch (err) { next(err); }
};

const deleteAdminBranchImage = async (req, res, next) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) throw { status: 422, message: 'imageUrl is required' };
    await adminService.deleteAdminBranchImage(req.params.id, req.params.branchId, imageUrl);
    return sendSuccess(res, null, 'Image removed');
  } catch (err) { next(err); }
};

const updateBranchTravelerVisibility = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { status, reason } = req.body;

    if (status === 'deactivated' && (!reason || !reason.trim())) {
      throw createError('Reason is required when deactivating a branch', 400);
    }

    const result = await adminService.updateBranchTravelerVisibility(
      branchId,
      status,
      reason,
      req.user.id
    );

    return sendSuccess(res, result, 'Branch traveler visibility updated successfully.');
  } catch (err) {
    next(err);
  }
};

const getBranchVisibilityHistory = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const result = await adminService.getBranchVisibilityHistory(branchId);
    return sendSuccess(res, result, 'Branch visibility history retrieved.');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createTenant, listTenants, getTenant, approveTenant, rejectTenant, suspendTenant,
  reactivateTenant, getTenantBranches, updateTenantBranchStatus, getTenantMembers, getTenantMembershipPlans,
  uploadTenantLogo, uploadTenantCover,
  getGymListing, createGymListing, updateGymListing,
  uploadGymListingLogo, uploadGymListingCover, uploadGymListingImages, deleteGymListingImage,
  createAdminTenantBranch, updateAdminTenantBranch, uploadAdminBranchImages, deleteAdminBranchImage,
  getTenantSubscriptions, assignTenantSubscription, revokeTenantSubscription,
  getTenantInvoices, createTenantInvoice, updateTenantInvoice,
  sendInvoiceReminder, sendInvoiceConfirmation,
  getPlatformStats, getPlatformAnalytics,
  deleteTenant, syncSubscriptions,
  updateBranchTravelerVisibility,
  getBranchVisibilityHistory,
};
