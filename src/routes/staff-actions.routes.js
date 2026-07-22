const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const { Tenant, User, Notification } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError, sendSuccess } = require('../utils/response.utils');
const notificationsService = require('../services/notifications.service');
const gymService = require('../services/gym.service');
const subscriptionService = require('../services/subscription.service');

const router = Router();
router.use(authenticate);

// Helper to resolve Tenant DB from branch ID
const _resolveTenantFromBranch = async (branchId) => {
  const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
  for (const tenant of tenants) {
    try {
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const branch = await tenantDb.models.Branch.findByPk(branchId);
      if (branch) {
        return { tenantDb, tenant, branch };
      }
    } catch (err) {
      // Skip connection errors
    }
  }
  throw createError('Branch not found or inactive', 404);
};

// Helper to scan all active tenant databases to locate a request by ID
const _resolveRequestById = async (requestId) => {
  const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
  for (const tenant of tenants) {
    try {
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const request = await tenantDb.models.StaffActionRequest.findByPk(requestId);
      if (request) {
        return { tenantDb, tenant, request };
      }
    } catch (err) {
      // Skip
    }
  }
  throw createError('Action request not found', 404);
};

// Helper to map type to action text
const _getActionText = (type) => {
  if (type === 'add_member') return 'add a member';
  if (type === 'renew') return 'renew subscription';
  if (type === 'change_plan') return 'change plan';
  if (type === 'upgrade') return 'upgrade package';
  if (type === 'submit_expense') return 'submit an expense';
  return type;
};

// ── STAFF: POST /staff/branches/:branchId/action-requests ─────────────────────
router.post('/branches/:branchId/action-requests', async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { actionType, payload } = req.body;

    if (!['add_member', 'renew', 'change_plan', 'upgrade', 'submit_expense'].includes(actionType)) {
      throw createError('Invalid action type', 400);
    }

    const { tenantDb, tenant, branch } = await _resolveTenantFromBranch(branchId);

    // Verify enroller is an active staff member of this branch
    const staff = await tenantDb.models.GymStaff.findOne({
      where: {
        branchId,
        userId: req.user.id,
        status: 'active',
      }
    });
    if (!staff) {
      throw createError('Access denied: You are not active staff at this branch', 403);
    }

    // Create pending request
    const request = await tenantDb.models.StaffActionRequest.create({
      staffId: staff.id,
      branchId,
      actionType,
      payloadJson: payload,
      status: 'pending',
      requestedAt: new Date(),
    });

    // Notify the Host
    try {
      let notifMessage = '';
      if (actionType === 'submit_expense') {
        const title = payload.title || 'Expense';
        const amount = payload.amount || 0;
        notifMessage = `${req.user.fullName} submitted an expense: ${title} — Rs ${amount} — needs your approval.`;
      } else {
        let memberName = 'Member';
        if (actionType === 'add_member') {
          memberName = payload.fullName || 'Member';
        } else {
          const memberUserId = payload.memberUserId;
          if (memberUserId) {
            const user = await User.findByPk(memberUserId);
            if (user) memberName = user.fullName;
          }
        }
        notifMessage = `${req.user.fullName} requested to ${_getActionText(actionType)} for ${memberName} — needs your approval.`;
      }

      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'staff_action_requested',
        title: 'Pending Staff Request',
        message: notifMessage,
        priority: 'normal',
        deepLink: `/host/gyms/${branchId}/staff-requests`,
        metadataJson: { requestId: request.id, branchId, tenantId: tenant.id }
      });
    } catch (notifErr) {
      console.warn('[Staff Request Notification] Failed to notify Host:', notifErr.message);
    }

    return sendSuccess(res, request, 'Staff action request submitted successfully. Awaiting host approval.', 201);
  } catch (err) {
    next(err);
  }
});

// ── HOST & STAFF: GET /host/branches/:branchId/action-requests?status=pending ──────────
// Note: We mount this on `/staff` but filter for host or active staff authorization
router.get('/host/branches/:branchId/action-requests', async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { status = 'pending' } = req.query;

    const { tenantDb, tenant } = await _resolveTenantFromBranch(branchId);

    // Verify caller is the tenant owner (Host) OR an active staff member of this branch
    const isHost = tenant.ownerUserId === req.user.id;
    const staff = await tenantDb.models.GymStaff.findOne({
      where: {
        branchId,
        userId: req.user.id,
        status: 'active',
      }
    });

    if (!isHost && !staff) {
      throw createError('Access denied: Only the gym host or active branch staff can review staff requests', 403);
    }

    const requests = await tenantDb.models.StaffActionRequest.findAll({
      where: { branchId, status },
      order: [['requestedAt', 'DESC']]
    });

    // Enrich requests with staff member and member details
    const enriched = [];
    for (const r of requests) {
      const staffMember = await tenantDb.models.GymStaff.findByPk(r.staffId);
      let staffUser = null;
      if (staffMember && staffMember.userId) {
        staffUser = await User.findByPk(staffMember.userId);
      }

      let payload = r.payloadJson;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (e) {
          payload = {};
        }
      }

      let targetMemberName = 'Member';
      if (r.actionType === 'add_member') {
        targetMemberName = payload.fullName || 'Member';
      } else {
        const memberUserId = payload.memberUserId;
        if (memberUserId) {
          const user = await User.findByPk(memberUserId);
          if (user) targetMemberName = user.fullName;
        }
      }

      enriched.push({
        id: r.id,
        actionType: r.actionType,
        payload: payload,
        status: r.status,
        requestedAt: r.requestedAt,
        staff: staffUser ? {
          fullName: staffUser.fullName,
          email: staffUser.email,
        } : { fullName: 'Staff' },
        memberName: targetMemberName,
      });
    }

    return sendSuccess(res, enriched, 'Requests retrieved');
  } catch (err) {
    next(err);
  }
});

// ── HOST: POST /host/action-requests/:requestId/approve ─────────────────────────
router.post('/host/action-requests/:requestId/approve', async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const { tenantDb, tenant, request } = await _resolveRequestById(requestId);

    // Verify caller is host
    if (tenant.ownerUserId !== req.user.id) {
      throw createError('Access denied: Only the gym host can approve staff requests', 403);
    }

    if (request.status !== 'pending') {
      throw createError('Action request is already resolved', 400);
    }

    let payload = request.payloadJson;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (e) {
        payload = {};
      }
    }
    let actionResult = null;

    // Execute underlying host action
    if (request.actionType === 'add_member') {
      // Walk-in enrollment
      actionResult = await gymService.enrollMember(
        tenantDb,
        tenant.id,
        payload,
        { role: 'GYM_HOST', id: req.user.id }
      );
    } else if (request.actionType === 'renew') {
      actionResult = await subscriptionService.renew(
        payload.memberUserId,
        payload.subscriptionId
      );
    } else if (request.actionType === 'change_plan') {
      actionResult = await subscriptionService.changePlan(
        payload.memberUserId,
        payload.subscriptionId,
        payload.newPlanId
      );
    } else if (request.actionType === 'upgrade') {
      actionResult = await subscriptionService.upgradeSubscription(
        payload.memberUserId,
        payload.subscriptionId,
        payload.newPlanId
      );
    } else if (request.actionType === 'submit_expense') {
      const { Expense } = tenantDb.models;
      const staffMember = await tenantDb.models.GymStaff.findByPk(request.staffId);

      // Create the real expense row on Host Approval
      actionResult = await Expense.create({
        branchId: request.branchId,
        categoryId: payload.categoryId,
        title: payload.title,
        amount: payload.amount,
        expenseDate: payload.expenseDate,
        paymentMethod: payload.paymentMethod || 'cash',
        vendorName: payload.vendorName || null,
        notes: payload.notes || null,
        receiptUrl: payload.receiptUrl || null,
        isRecurring: Boolean(payload.isRecurring),
        recurrenceFrequency: payload.recurrenceFrequency || null,
        recurrenceEndDate: payload.recurrenceEndDate || null,
        status: 'approved',
        createdBy: staffMember ? staffMember.userId : req.user.id,
        reviewedBy: req.user.id,
      });
    }

    // Update request state
    await request.update({
      status: 'approved',
      reviewedAt: new Date(),
      reviewedBy: req.user.id,
    });

    // Notify Staff member of approval outcome
    try {
      const staffMember = await tenantDb.models.GymStaff.findByPk(request.staffId);
      if (staffMember && staffMember.userId) {
        const branch = await tenantDb.models.Branch.findByPk(request.branchId);
        const branchName = branch ? branch.branchName : 'branch';
        
        await notificationsService.createNotification({
          userId: staffMember.userId,
          role: 'traveler', // Send to their traveler-app notification list
          type: 'staff_action_approved',
          title: 'Request Approved',
          message: `Your request to ${_getActionText(request.actionType)} at ${branchName} was approved by the Host.`,
          priority: 'normal',
          deepLink: `/staff/dashboard`,
          metadataJson: { requestId: request.id, branchId: request.branchId, tenantId: tenant.id }
        });
      }
    } catch (notifErr) {
      console.warn('[Staff Notification] Failed to notify staff of approval:', notifErr.message);
    }

    return sendSuccess(res, { request, result: actionResult }, 'Request approved and executed successfully');
  } catch (err) {
    next(err);
  }
});

// ── HOST: POST /host/action-requests/:requestId/reject ─────────────────────────
router.post('/host/action-requests/:requestId/reject', async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const { rejectionReason } = req.body || {};
    const { tenantDb, tenant, request } = await _resolveRequestById(requestId);

    // Verify caller is host
    if (tenant.ownerUserId !== req.user.id) {
      throw createError('Access denied: Only the gym host can reject staff requests', 403);
    }

    if (request.status !== 'pending') {
      throw createError('Action request is already resolved', 400);
    }

    // Update request state (No expense row is ever created)
    await request.update({
      status: 'rejected',
      rejectionReason: rejectionReason ? rejectionReason.trim() : null,
      reviewedAt: new Date(),
      reviewedBy: req.user.id,
    });

    // Notify Staff member of rejection outcome
    try {
      const staffMember = await tenantDb.models.GymStaff.findByPk(request.staffId);
      if (staffMember && staffMember.userId) {
        const branch = await tenantDb.models.Branch.findByPk(request.branchId);
        const branchName = branch ? branch.branchName : 'branch';

        await notificationsService.createNotification({
          userId: staffMember.userId,
          role: 'traveler',
          type: 'staff_action_rejected',
          title: 'Request Rejected',
          message: `Your request to ${_getActionText(request.actionType)} at ${branchName} was rejected by the Host.${rejectionReason ? ` Reason: ${rejectionReason}` : ''}`,
          priority: 'normal',
          deepLink: `/staff/dashboard`,
          metadataJson: { requestId: request.id, branchId: request.branchId, tenantId: tenant.id }
        });
      }
    } catch (notifErr) {
      console.warn('[Staff Notification] Failed to notify staff of rejection:', notifErr.message);
    }

    return sendSuccess(res, request, 'Request rejected successfully');
  } catch (err) {
    next(err);
  }
});

// ── STAFF: GET /staff/branches/:branchId/my-expenses ───────────────────────────
router.get('/branches/:branchId/my-expenses', async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const { tenantDb } = await _resolveTenantFromBranch(branchId);

    const staff = await tenantDb.models.GymStaff.findOne({
      where: {
        branchId,
        userId: req.user.id,
        status: 'active',
      },
    });

    if (!staff) {
      throw createError('Access denied: You are not active staff at this branch', 403);
    }

    const requests = await tenantDb.models.StaffActionRequest.findAll({
      where: {
        staffId: staff.id,
        branchId,
        actionType: 'submit_expense',
      },
      order: [['requestedAt', 'DESC']],
    });

    const items = requests.map((r) => {
      let payload = r.payloadJson;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (e) {
          payload = {};
        }
      }

      return {
        id: r.id,
        actionType: r.actionType,
        status: r.status, // 'pending', 'approved', 'rejected'
        rejectionReason: r.rejectionReason || null,
        requestedAt: r.requestedAt,
        reviewedAt: r.reviewedAt,
        title: payload.title || 'Expense',
        amount: payload.amount || 0,
        categoryId: payload.categoryId,
        categoryName: payload.categoryName || 'General',
        expenseDate: payload.expenseDate,
        paymentMethod: payload.paymentMethod || 'cash',
        vendorName: payload.vendorName || null,
        notes: payload.notes || null,
        receiptUrl: payload.receiptUrl || null,
      };
    });

    return sendSuccess(res, items, 'Staff submitted expenses retrieved');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
