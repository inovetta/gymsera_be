const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const { Tenant, User } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError, sendSuccess } = require('../utils/response.utils');
const notificationsService = require('../services/notifications.service');

const router = Router();
router.use(authenticate);

// Helper to find staff and its tenant connection
const _resolveStaffAndTenant = async (staffId, requestedTenantId) => {
  let tenantId = requestedTenantId;
  let targetStaff = null;
  let targetTenant = null;

  if (tenantId) {
    targetTenant = await Tenant.findByPk(tenantId);
    if (targetTenant) {
      try {
        const tenantDb = await TenantDbManager.getConnection(targetTenant.id, targetTenant.connectionStringEncrypted);
        targetStaff = await tenantDb.models.GymStaff.findByPk(staffId);
      } catch (err) {
        console.warn(`[Staff Invite] Failed to connect using provided tenantId:`, err.message);
      }
    }
  }

  // Scan fallback
  if (!targetStaff) {
    const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
    for (const t of tenants) {
      try {
        const tenantDb = await TenantDbManager.getConnection(t.id, t.connectionStringEncrypted);
        const staff = await tenantDb.models.GymStaff.findByPk(staffId);
        if (staff) {
          targetStaff = staff;
          targetTenant = t;
          break;
        }
      } catch (err) {
        // Skip
      }
    }
  }

  if (!targetStaff || !targetTenant) {
    throw createError('Staff invite not found', 404);
  }

  return { staff: targetStaff, tenant: targetTenant };
};

// GET /staff-invites/:staffId
router.get('/:staffId', async (req, res, next) => {
  try {
    const { staff, tenant } = await _resolveStaffAndTenant(req.params.staffId, req.query.tenantId);
    const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
    const branch = await tenantDb.models.Branch.findByPk(staff.branchId);

    // Get host user details
    const hostUser = await User.findByPk(tenant.ownerUserId);

    return sendSuccess(res, {
      staff: {
        id: staff.id,
        designation: staff.designation,
        status: staff.status,
        createdAt: staff.createdAt,
      },
      branch: branch ? {
        id: branch.id,
        name: branch.branchName,
      } : null,
      gym: {
        id: tenant.id,
        name: tenant.gymName || tenant.businessName,
      },
      host: hostUser ? {
        fullName: hostUser.fullName,
        email: hostUser.email,
      } : null,
    }, 'Invite retrieved successfully');
  } catch (err) {
    next(err);
  }
});

// POST /staff-invites/:staffId/accept
router.post('/:staffId/accept', async (req, res, next) => {
  try {
    const { staff, tenant } = await _resolveStaffAndTenant(req.params.staffId, req.body.tenantId || req.query.tenantId);
    
    // Ensure this invite is indeed for this authenticated user
    if (staff.userId && staff.userId !== req.user.id) {
      throw createError('Access denied: Invite is not assigned to your account', 403);
    }

    // Accept invite
    await staff.update({ status: 'active' });

    // Update user role to include staff capabilities (we update their platform role to BRANCH_MANAGER if it was MEMBER)
    const user = await User.findByPk(req.user.id);
    if (user && user.role === 'MEMBER') {
      await user.update({ role: 'BRANCH_MANAGER' });
    }

    // Find and mark the notification read
    try {
      const { Notification } = require('../models/platform');
      const notification = await Notification.findOne({
        where: {
          userId: req.user.id,
          type: 'staff_invite',
          isRead: false
        }
      });
      if (notification) {
        await notification.update({ isRead: true });
      }
    } catch (err) {
      console.warn('[Staff Invite] Failed to mark notification read:', err.message);
    }

    // Send confirmation notification to the Host
    try {
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const branch = await tenantDb.models.Branch.findByPk(staff.branchId);
      const branchName = branch ? branch.branchName : 'branch';
      
      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'staff_invite_accepted',
        title: 'Staff Invite Accepted',
        message: `${user.fullName} has accepted the invite to join ${branchName} as staff.`,
        priority: 'normal',
        deepLink: `/host/gyms/${staff.branchId}/staff`,
        metadataJson: { staffId: staff.id, branchId: staff.branchId, tenantId: tenant.id }
      });
    } catch (err) {
      console.warn('[Staff Invite] Failed to notify host:', err.message);
    }

    return sendSuccess(res, { status: 'active' }, 'Staff invitation accepted');
  } catch (err) {
    next(err);
  }
});

// POST /staff-invites/:staffId/decline
router.post('/:staffId/decline', async (req, res, next) => {
  try {
    const { staff, tenant } = await _resolveStaffAndTenant(req.params.staffId, req.body.tenantId || req.query.tenantId);

    if (staff.userId && staff.userId !== req.user.id) {
      throw createError('Access denied: Invite is not assigned to your account', 403);
    }

    // Decline invite
    await staff.update({ status: 'declined' });
    // Remove the pending staff record
    await staff.destroy();

    // Mark notification read
    try {
      const { Notification } = require('../models/platform');
      const notification = await Notification.findOne({
        where: {
          userId: req.user.id,
          type: 'staff_invite',
          isRead: false
        }
      });
      if (notification) {
        await notification.update({ isRead: true });
      }
    } catch (err) {
      console.warn('[Staff Invite] Failed to mark notification read:', err.message);
    }

    // Notify Host
    try {
      const user = await User.findByPk(req.user.id);
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const branch = await tenantDb.models.Branch.findByPk(staff.branchId);
      const branchName = branch ? branch.branchName : 'branch';

      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'staff_invite_declined',
        title: 'Staff Invite Declined',
        message: `${user.fullName} has declined the invite to join ${branchName} as staff.`,
        priority: 'normal',
        deepLink: `/host/gyms/${staff.branchId}/staff`,
        metadataJson: { branchId: staff.branchId, tenantId: tenant.id }
      });
    } catch (err) {
      console.warn('[Staff Invite] Failed to notify host:', err.message);
    }

    return sendSuccess(res, null, 'Staff invitation declined');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
