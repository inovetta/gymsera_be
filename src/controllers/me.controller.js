const meService = require('../services/me.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');
const storageService = require('../services/storage.service');
const inboxService = require('../services/inbox.service');

// ── GET /me/profile ────────────────────────────────────────────────────────────
const getProfile = async (req, res, next) => {
  try {
    const profile = await meService.getMyProfile(req.user.sub, req.tenantDb || null);
    return sendSuccess(res, { profile }, 'Profile retrieved');
  } catch (err) {
    next(err);
  }
};

// ── PUT /me/profile ────────────────────────────────────────────────────────────
const updateProfile = async (req, res, next) => {
  try {
    const profile = await meService.updateMyProfile(req.user.sub, req.body, req.tenantDb || null);
    return sendSuccess(res, { profile }, 'Profile updated');
  } catch (err) {
    next(err);
  }
};

// ── POST /me/password ──────────────────────────────────────────────────────────
const changePassword = async (req, res, next) => {
  try {
    const result = await meService.changePassword(
      req.user.sub,
      req.body.currentPassword,
      req.body.newPassword
    );
    return sendSuccess(res, null, result.message);
  } catch (err) {
    next(err);
  }
};

// ── POST /me/profile-image ─────────────────────────────────────────────────────
const uploadProfileImage = async (req, res, next) => {
  try {
    if (!req.file) {
      const err = new Error('Image file is required');
      err.statusCode = 422;
      return next(err);
    }

    const imageUrl = await storageService.uploadImage(req.file.buffer, req.file.mimetype, 'profiles', req.user.sub);
    const result = await meService.updateProfileImage(req.user.sub, imageUrl);
    return sendSuccess(res, result, 'Profile image updated');
  } catch (err) {
    next(err);
  }
};

// ── GET /me/account-statement ──────────────────────────────────────────────────
const accountStatement = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { from, to } = req.query;
    const result = await meService.getMyAccountStatement(
      req.user.sub,
      { page, limit, offset, from, to }
    );
    return sendSuccess(res, result, 'Account statement retrieved');
  } catch (err) {
    next(err);
  }
};

// ── GET /me/account-statement/export ──────────────────────────────────────────
const accountStatementExport = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const { subscriptions, payments } = await meService.getMyAccountStatement(
      req.user.sub,
      { page: 1, limit: 1000, offset: 0, from, to }
    );

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 40 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="my-account-statement.pdf"');
    doc.pipe(res);

    doc.fontSize(18).text('My Account Statement', { align: 'center' });
    doc.moveDown();

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

// ── GET /me/payment-requests ───────────────────────────────────────────────────
const getPaymentRequests = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 50);
    const result = await meService.getMyPaymentRequests(req.user.sub, { page, limit, offset });
    return sendSuccess(res, { payments: result.payments }, 'OK', 200, {
      total: result.total,
      page,
      limit,
      totalPages: Math.ceil(result.total / limit),
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /me/payment-request ───────────────────────────────────────────────────
const submitPaymentRequest = async (req, res, next) => {
  try {
    const payment = await meService.submitPaymentRequest(req.user.sub, req.body);
    return sendSuccess(res, { payment }, 'Payment request submitted', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /me/attendance ─────────────────────────────────────────────────────────
const getMyAttendance = async (req, res, next) => {
  try {
    const logs = await meService.getMyAttendance(req.user.sub, req.query.subscriptionId);
    return sendSuccess(res, logs, 'Attendance logs retrieved');
  } catch (err) {
    next(err);
  }
};

// ── POST /me/payment-requests/:id/proof ───────────────────────────────────────
const uploadPaymentProof = async (req, res, next) => {
  try {
    if (!req.file) {
      const err = new Error('Proof image file is required');
      err.statusCode = 422;
      return next(err);
    }

    const proofUrl = `${process.env.STORAGE_BASE_URL || '/uploads'}/payment-proofs/${req.params.id}-${Date.now()}.jpg`;
    const result = await meService.uploadPaymentProof(req.user.sub, req.params.id, proofUrl);
    return sendSuccess(res, result, 'Payment proof uploaded');
  } catch (err) {
    next(err);
  }
};

// ── GET /me/saved-gyms ────────────────────────────────────────────────────────
const getSavedGyms = async (req, res, next) => {
  try {
    const gyms = await meService.getSavedGyms(req.user.sub);
    return sendSuccess(res, { gyms }, 'Saved gyms retrieved');
  } catch (err) {
    next(err);
  }
};

// ── POST /me/saved-gyms/:gymId ───────────────────────────────────────────────
const saveGym = async (req, res, next) => {
  try {
    const saved = await meService.saveGym(req.user.sub, req.params.gymId);
    return sendSuccess(res, { saved }, 'Gym saved to wishlist', 201);
  } catch (err) {
    next(err);
  }
};

// ── DELETE /me/saved-gyms/:gymId ─────────────────────────────────────────────
const unsaveGym = async (req, res, next) => {
  try {
    await meService.unsaveGym(req.user.sub, req.params.gymId);
    return sendSuccess(res, null, 'Gym removed from wishlist', 200);
  } catch (err) {
    next(err);
  }
};

// ── POST /me/request-deletion ────────────────────────────────────────────────
const requestDeletion = async (req, res, next) => {
  try {
    await meService.requestAccountDeletion(req.user.sub);
    return sendSuccess(res, null, 'Account deletion requested. You will be contacted within 7 days.', 200);
  } catch (err) {
    next(err);
  }
};

// ── GET /me/inbox ──────────────────────────────────────────────────────────────
const listMyInbox = async (req, res, next) => {
  try {
    const conversations = await inboxService.listTravelerConversations(req.user.sub);
    return sendSuccess(res, { conversations });
  } catch (err) {
    next(err);
  }
};

// ── GET /me/inbox/:conversationId ──────────────────────────────────────────────
const getMyConversation = async (req, res, next) => {
  try {
    const result = await inboxService.getTravelerConversationDetail(
      req.params.conversationId,
      req.user.sub
    );
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── POST /me/inbox/:conversationId/reply ───────────────────────────────────────
const replyToMyConversation = async (req, res, next) => {
  try {
    const message = await inboxService.replyAsUser(
      req.params.conversationId,
      req.user.sub,
      req.body.text
    );
    return sendSuccess(res, { message }, 'Message sent', 201);
  } catch (err) {
    next(err);
  }
};

// ── PATCH /me/inbox/:conversationId/read ───────────────────────────────────────
const markMyConversationRead = async (req, res, next) => {
  try {
    await inboxService.markTravelerRead(req.params.conversationId, req.user.sub);
    return sendSuccess(res, {}, 'Marked as read');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getProfile,
  updateProfile,
  changePassword,
  uploadProfileImage,
  accountStatement,
  accountStatementExport,
  getPaymentRequests,
  submitPaymentRequest,
  uploadPaymentProof,
  getMyAttendance,
  getSavedGyms,
  saveGym,
  unsaveGym,
  requestDeletion,
  listMyInbox,
  getMyConversation,
  replyToMyConversation,
  markMyConversationRead,
};
