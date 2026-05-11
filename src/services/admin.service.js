const { Op } = require('sequelize');
const { Tenant, User, City, PlatformPackage, GymListing } = require('../models/platform');
const { createError, parsePagination, buildPagination } = require('../utils/response.utils');
const { TenantStatus, KycStatus } = require('../constants/subscription-status');
const { tenantProvisioningQueue } = require('../jobs/queues');
const emailService = require('./email.service');

// ── listTenants ───────────────────────────────────────────────────────────────
const listTenants = async ({ status, page, limit, offset }) => {
  const where = {};
  if (status) {
    if (!Object.values(TenantStatus).includes(status)) {
      throw createError(`Invalid status. Valid values: ${Object.values(TenantStatus).join(', ')}`, 400);
    }
    where.status = status;
  }

  const { count, rows } = await Tenant.findAndCountAll({
    where,
    include: [
      { model: User, as: 'owner', attributes: ['id', 'fullName', 'email', 'phone'] },
      { model: City, as: 'city', attributes: ['id', 'name'] },
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  return { tenants: rows, pagination: buildPagination(count, page, limit) };
};

// ── getTenant ─────────────────────────────────────────────────────────────────
const getTenant = async (tenantId) => {
  const tenant = await Tenant.findByPk(tenantId, {
    include: [
      { model: User, as: 'owner', attributes: ['id', 'fullName', 'email', 'phone'] },
      { model: City, as: 'city', attributes: ['id', 'name'] },
    ],
  });
  if (!tenant) throw createError('Tenant not found', 404);
  return { tenant };
};

// ── approveTenant ─────────────────────────────────────────────────────────────
/**
 * Admin approves a tenant — updates status to APPROVED and enqueues
 * the DB provisioning job. The job will flip status to ACTIVE once done.
 */
const approveTenant = async (tenantId, adminUserId) => {
  const tenant = await Tenant.findByPk(tenantId, {
    include: [{ model: User, as: 'owner', attributes: ['id', 'fullName', 'email'] }],
  });
  if (!tenant) throw createError('Tenant not found', 404);

  if (tenant.status !== TenantStatus.PENDING_REVIEW && tenant.status !== TenantStatus.UNDER_REVIEW) {
    throw createError('Tenant is not in a reviewable state', 400);
  }

  await tenant.update({
    status: TenantStatus.APPROVED,
    approvedAt: new Date(),
    approvedBy: adminUserId,
    kycStatus: KycStatus.APPROVED,
  });

  // Enqueue the provisioning job — processed by TenantProvisioningService
  await tenantProvisioningQueue.add({ tenantId: tenant.id }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: false,
    removeOnFail: false,
  });

  return { tenant };
};

// ── rejectTenant ──────────────────────────────────────────────────────────────
const rejectTenant = async (tenantId, adminUserId, reason) => {
  const tenant = await Tenant.findByPk(tenantId, {
    include: [{ model: User, as: 'owner', attributes: ['id', 'fullName', 'email'] }],
  });
  if (!tenant) throw createError('Tenant not found', 404);

  if (tenant.status !== TenantStatus.PENDING_REVIEW && tenant.status !== TenantStatus.UNDER_REVIEW) {
    throw createError('Tenant is not in a reviewable state', 400);
  }

  if (!reason || !reason.trim()) {
    throw createError('A rejection reason is required', 400);
  }

  await tenant.update({
    status: TenantStatus.REJECTED,
    rejectedAt: new Date(),
    rejectedBy: adminUserId,
    rejectionReason: reason.trim(),
    kycStatus: KycStatus.REJECTED,
  });

  // Notify the gym host
  if (tenant.owner) {
    await emailService.sendTenantRejectedEmail(
      tenant.owner.email,
      tenant.owner.fullName,
      tenant.businessName,
      reason.trim()
    );
  }

  return { tenant };
};

module.exports = { listTenants, getTenant, approveTenant, rejectTenant };
