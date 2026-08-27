const userService = require('../services/user.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');
const storageService = require('../services/storage.service');

// ── GET /users — paginated search ─────────────────────────────────────────────
const search = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { q, role, status } = req.query;

    const result = await userService.searchUsers({ q, role, status, page, limit, offset });
    return sendSuccess(res, { users: result.users }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── GET /users/:id ─────────────────────────────────────────────────────────────
const getById = async (req, res, next) => {
  try {
    const user = await userService.getUserById(req.params.id, req.tenantDb || null);
    return sendSuccess(res, { user }, 'User retrieved');
  } catch (err) {
    next(err);
  }
};

// ── POST /users — staff creates member ────────────────────────────────────────
const create = async (req, res, next) => {
  try {
    const user = await userService.createMember(req.body, req.tenantDb || null);
    return sendSuccess(res, { user }, 'Member account created', 201);
  } catch (err) {
    next(err);
  }
};

// ── PUT /users/:id ─────────────────────────────────────────────────────────────
const update = async (req, res, next) => {
  try {
    const user = await userService.updateUser(req.params.id, req.body, req.tenantDb || null);
    return sendSuccess(res, { user }, 'User updated');
  } catch (err) {
    next(err);
  }
};

// ── POST /users/:id/status ─────────────────────────────────────────────────────
const setStatus = async (req, res, next) => {
  try {
    const result = await userService.setStatus(req.params.id, req.body.status);
    return sendSuccess(res, result, 'User status updated');
  } catch (err) {
    next(err);
  }
};

// ── POST /users/:id/password ───────────────────────────────────────────────────
const adminResetPassword = async (req, res, next) => {
  try {
    const result = await userService.adminResetPassword(req.params.id, req.body.newPassword);
    return sendSuccess(res, null, result.message);
  } catch (err) {
    next(err);
  }
};

// ── POST /users/:id/profile-image ─────────────────────────────────────────────
const uploadProfileImage = async (req, res, next) => {
  try {
    if (!req.file) {
      const err = new Error('Image file is required');
      err.statusCode = 422;
      return next(err);
    }

    const imageUrl = await storageService.uploadImage(req.file.buffer, req.file.mimetype, 'profiles', req.params.id);
    const result = await userService.updateProfileImage(req.params.id, imageUrl);
    return sendSuccess(res, result, 'Profile image updated');
  } catch (err) {
    next(err);
  }
};

// ── GET /users/:id/account-statement ──────────────────────────────────────────
const accountStatement = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { from, to } = req.query;

    const result = await userService.getAccountStatement(
      req.params.id,
      req.tenantDb || null,
      { page, limit, offset, from, to }
    );
    return sendSuccess(res, result, 'Account statement retrieved');
  } catch (err) {
    next(err);
  }
};

// ── GET /users/:id/account-statement/export ────────────────────────────────────
const accountStatementExport = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const { page, limit, offset } = parsePagination({ page: 1, limit: 1000 }, 1000, 1000);

    const { subscriptions, payments } = await userService.getAccountStatement(
      req.params.id,
      req.tenantDb || null,
      { page, limit, offset, from, to }
    );

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 40 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="account-statement-${req.params.id}.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).text('Account Statement', { align: 'center' });
    doc.moveDown();

    // Subscriptions section
    doc.fontSize(14).text('Memberships', { underline: true });
    doc.moveDown(0.5);
    if (!subscriptions.length) {
      doc.fontSize(11).text('No memberships found.');
    } else {
      subscriptions.forEach((s) => {
        doc.fontSize(11).text(
          `• ${s.plan?.name || 'Plan'} | ${s.startDate} → ${s.endDate} | ${s.status}`
        );
      });
    }

    doc.moveDown();

    // Payments section
    doc.fontSize(14).text('Payments', { underline: true });
    doc.moveDown(0.5);
    if (!payments.length) {
      doc.fontSize(11).text('No payments found.');
    } else {
      payments.forEach((p) => {
        doc.fontSize(11).text(
          `• ${p.amount} ${p.currency} | ${p.method} | ${p.status} | ${p.paidAt ? new Date(p.paidAt).toLocaleDateString() : 'Pending'}`
        );
      });
    }

    doc.end();
  } catch (err) {
    next(err);
  }
};

module.exports = {
  search,
  getById,
  create,
  update,
  setStatus,
  adminResetPassword,
  uploadProfileImage,
  accountStatement,
  accountStatementExport,
};
