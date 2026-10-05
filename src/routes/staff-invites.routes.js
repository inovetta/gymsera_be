const crypto = require('crypto');
const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const { Tenant, User } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError, sendSuccess } = require('../utils/response.utils');
const notificationsService = require('../services/notifications.service');

const router = Router();
router.use(authenticate);

// Helper to find staff and its tenant connection
const _resolveStaffAndTenant = async (staffIdOrToken, requestedTenantId) => {
  let tenantId = requestedTenantId;
  let targetStaff = null;
  let targetTenant = null;

  const computedHash = staffIdOrToken
    ? crypto.createHash('sha256').update(String(staffIdOrToken)).digest('hex')
    : null;

  const findStaffOnDb = async (tenantDb) => {
    let staff = null;
    try {
      staff = await tenantDb.models.GymStaff.findByPk(staffIdOrToken);
    } catch (_) {}
    if (staff) return staff;

    if (computedHash) {
      try {
        staff = await tenantDb.models.GymStaff.findOne({ where: { inviteTokenHash: computedHash } });
      } catch (_) {}
      if (staff) return staff;
    }

    if (staffIdOrToken) {
      try {
        staff = await tenantDb.models.GymStaff.findOne({ where: { inviteTokenHash: String(staffIdOrToken).toLowerCase() } });
      } catch (_) {}
    }
    return staff;
  };

  if (tenantId) {
    targetTenant = await Tenant.findByPk(tenantId);
    if (targetTenant) {
      try {
        const tenantDb = await TenantDbManager.getConnection(targetTenant.id, targetTenant.connectionStringEncrypted);
        targetStaff = await findStaffOnDb(tenantDb);
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
        const staff = await findStaffOnDb(tenantDb);
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

const _assertInviteValid = (staff, reqUser) => {
  // 1. Single-use: must be pending
  if (staff.status !== 'pending') {
    throw createError('Staff invite has already been accepted or is no longer pending', 409);
  }

  // 2. Expiration: 7-day token expiration
  const expiresAt = staff.tokenExpiresAt
    ? new Date(staff.tokenExpiresAt)
    : new Date(new Date(staff.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000);
  if (expiresAt < new Date()) {
    throw createError('Staff invite has expired', 410);
  }

  // 3. User & email binding:
  if (staff.userId && staff.userId !== reqUser.id) {
    throw createError('Access denied: Invite is not assigned to your account', 403);
  }
  if (!staff.userId && staff.email) {
    const userEmail = (reqUser.email || '').toLowerCase().trim();
    const staffEmail = staff.email.toLowerCase().trim();
    if (userEmail !== staffEmail) {
      throw createError('Access denied: Invite is not assigned to your account', 403);
    }
  }
};

// GET /staff-invites/:staffId
router.get('/:staffId', async (req, res, next) => {
  try {
    const { staff, tenant } = await _resolveStaffAndTenant(req.params.staffId, req.query.tenantId);
    const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
    const branch = await tenantDb.models.Branch.findByPk(staff.branchId);

    // Get host user details
    const hostUser = await User.findByPk(tenant.ownerUserId);

    const expiresAt = staff.tokenExpiresAt
      ? new Date(staff.tokenExpiresAt)
      : new Date(new Date(staff.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000);
    const isExpired = expiresAt < new Date();

    return sendSuccess(res, {
      staff: {
        id: staff.id,
        designation: staff.designation,
        status: staff.status,
        createdAt: staff.createdAt,
        expiresAt,
        isExpired,
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
    
    // Ensure invite is pending, not expired, and assigned to this user/email
    _assertInviteValid(staff, req.user);

    const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
    const branch = await tenantDb.models.Branch.findByPk(staff.branchId);
    if (branch) {
      const { assertBranchNotBillingLocked } = require('../services/branch-billing-lock.service');
      assertBranchNotBillingLocked(branch);
    }

    // Accept invite - single-use: mark active and consume invite token
    await staff.update({ status: 'active', userId: req.user.id, inviteTokenHash: null });

    // Single authority: acceptStaffInvite creates or activates RoleAssignment
    const teamService = require('../services/team.service');
    await teamService.acceptStaffInvite({
      tenantDb,
      tenantId: tenant.id,
      userId: req.user.id,
      email: req.user.email,
      branchId: staff.branchId,
      designation: staff.designation,
      inviterUserId: tenant.ownerUserId,
    });

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
      const user = await User.findByPk(req.user.id);
      const branchName = branch ? branch.branchName : 'branch';
      
      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'staff_invite_accepted',
        title: 'Staff Invite Accepted',
        message: `${user?.fullName || 'A staff member'} has accepted the invite to join ${branchName} as staff.`,
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

    // Validate invite is pending, not expired, and assigned to this user/email
    _assertInviteValid(staff, req.user);

    // Decline invite - mark declined, clear token, and remove
    await staff.update({ status: 'declined', employmentStatus: 'TERMINATED', inviteTokenHash: null });
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
        message: `${user?.fullName || 'An invitee'} has declined the invite to join ${branchName} as staff.`,
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
