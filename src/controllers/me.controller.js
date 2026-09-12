const meService = require('../services/me.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');
const storageService = require('../services/storage.service');
const inboxService = require('../services/inbox.service');
const { ROLE_META } = require('../constants/roles');

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

// ── GET /me/staff-status ───────────────────────────────────────────────────────
/**
 * Drives the traveler shell's decision to show the "Gyms" tab: does this account
 * have team access anywhere, and at which branches?
 *
 * Resolved from `user_org_index` — one indexed platform-DB read, then a tenant DB
 * connection per organization the user is actually in. Previously this scanned
 * every active tenant's `gym_staff` table on every call, which (a) got slower
 * with every tenant onboarded and (b) only ever found legacy staff rows — a team
 * member added through the current Team & Access invite flow has a
 * `role_assignments` row, not a `gym_staff` one, and was invisible here even
 * though the notification telling them about their new access had already sent.
 */
const getStaffStatus = async (req, res, next) => {
  try {
    const { Tenant } = require('../models/platform');
    const TenantDbManager = require('../database/TenantDbManager');
    const membershipService = require('../services/membership.service');

    const userId = req.user.id || req.user.sub;
    const branches = [];

    const memberships = await membershipService.listUserTenants(userId, { activeOnly: true });

    for (const membership of memberships) {
      try {
        const tenant = await Tenant.findByPk(membership.tenantId, {
          attributes: ['id', 'gymName', 'businessName', 'connectionStringEncrypted', 'status'],
        });
        if (!tenant || !tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') {
          continue;
        }

        const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const { RoleAssignment, RoleAssignmentBranch, Branch } = tenantDb.models;

        const assignments = await RoleAssignment.findAll({
          where: { userId, status: 'ACTIVE' },
          include: [{ model: RoleAssignmentBranch, as: 'branchLinks', required: false }],
        });
        if (assignments.length === 0) continue;

        const isOrgScoped = assignments.some((a) => a.scopeType === 'ORG');
        const designation =
          assignments.find((a) => a.jobTitle)?.jobTitle ||
          ROLE_META[assignments[0].roleKey]?.displayName ||
          assignments[0].roleKey;

        const branchWhere = isOrgScoped
          ? { status: 'ACTIVE' }
          : {
              id: [
                ...new Set(assignments.flatMap((a) => (a.branchLinks || []).map((l) => l.branchId))),
              ],
              status: 'ACTIVE',
            };
        if (!isOrgScoped && branchWhere.id.length === 0) continue;

        const branchRows = await Branch.findAll({ where: branchWhere });
        for (const branch of branchRows) {
          branches.push({
            branchId: branch.id,
            tenantId: tenant.id,
            branchName: branch.branchName,
            gymName: tenant.gymName || tenant.businessName,
            designation,
          });
        }
      } catch (err) {
        // One unreachable tenant must not break the whole status check.
        console.warn(`[staff-status] tenant ${membership.tenantId} unreachable:`, err.message);
      }
    }

    // Legacy fallback: a tenant not yet backfilled onto role_assignments (see
    // scripts/backfill-rbac.js) may still only have a gym_staff row. Once every
    // tenant is migrated this whole branch — and the scan it does — can be
    // deleted; it deliberately runs only when the indexed lookup found nothing,
    // so a migrated user never pays for it.
    if (branches.length === 0) {
      await _legacyGymStaffScan(userId, req.user.email, branches);
    }

    return sendSuccess(res, {
      isStaff: branches.length > 0,
      branches,
    }, 'Staff status retrieved');
  } catch (err) {
    next(err);
  }
};

/** @deprecated remove once every tenant has run the RBAC backfill. */
const _legacyGymStaffScan = async (userId, email, branches) => {
  const { Tenant } = require('../models/platform');
  const TenantDbManager = require('../database/TenantDbManager');
  const { Op } = require('sequelize');

  const userEmail = email ? email.toLowerCase().trim() : '';
  const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });

  for (const tenant of tenants) {
    try {
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { GymStaff, Branch } = tenantDb.models;

      const whereCondition = { employmentStatus: 'ACTIVE' };
      if (userEmail && userId) whereCondition[Op.or] = [{ userId }, { email: userEmail }];
      else if (userId) whereCondition.userId = userId;
      else if (userEmail) whereCondition.email = userEmail;
      else continue;

      const staffRecords = await GymStaff.findAll({ where: whereCondition });

      for (const staff of staffRecords) {
        if (userId && (!staff.userId || staff.status !== 'active')) {
          await staff.update({ userId, status: 'active' }).catch(() => {});
        }
        const branch = await Branch.findByPk(staff.branchId);
        if (branch && branch.status === 'ACTIVE') {
          branches.push({
            branchId: branch.id,
            tenantId: tenant.id,
            branchName: branch.branchName,
            gymName: tenant.gymName || tenant.businessName,
            designation: staff.designation || 'Staff',
          });
        }
      }
    } catch (err) {
      // Skip connection or query errors.
    }
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
  getStaffStatus,
};
