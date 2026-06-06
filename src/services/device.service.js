/**
 * device.service.js
 *
 * CRUD for Devices and DeviceMembers (ZKTeco PIN mappings).
 *
 * Devices are registered per-tenant-per-branch on the platform DB.
 * DeviceMembers map a numeric ZKTeco PIN → platform userId on a specific device.
 */

const { Device, DeviceMember, User, Tenant } = require('../models/platform');
const { createError, buildPagination } = require('../utils/response.utils');

// ── listDevices ───────────────────────────────────────────────────────────────
const listDevices = async ({ tenantId, page, limit, offset }) => {
  const where = {};
  if (tenantId) where.tenantId = tenantId;

  const { count, rows } = await Device.findAndCountAll({
    where,
    include: [{ model: Tenant, as: 'tenant', attributes: ['id', 'businessName'] }],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  return { devices: rows, pagination: buildPagination(count, page, limit) };
};

// ── getDevice ─────────────────────────────────────────────────────────────────
const getDevice = async (deviceId, tenantId = null) => {
  const where = { id: deviceId };
  if (tenantId) where.tenantId = tenantId;

  const device = await Device.findOne({
    where,
    include: [{ model: Tenant, as: 'tenant', attributes: ['id', 'businessName'] }],
  });
  if (!device) throw createError('Device not found', 404);
  return { device };
};

// ── createDevice ──────────────────────────────────────────────────────────────
const createDevice = async ({ tenantId, branchId, serialNumber, name, model, ipAddress }) => {
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'status'] });
  if (!tenant) throw createError('Tenant not found', 404);
  if (tenant.status !== 'ACTIVE') throw createError('Tenant is not active', 400);

  const existing = await Device.findOne({ where: { serialNumber } });
  if (existing) throw createError(`A device with serial number "${serialNumber}" is already registered`, 409);

  const device = await Device.create({
    tenantId,
    branchId,
    serialNumber: serialNumber.trim().toUpperCase(),
    name: name.trim(),
    model: model?.trim() || null,
    ipAddress: ipAddress?.trim() || null,
    status: 'ACTIVE',
  });

  return { device };
};

// ── updateDevice ──────────────────────────────────────────────────────────────
const updateDevice = async (deviceId, tenantId, { name, model, ipAddress, branchId, status }) => {
  const where = { id: deviceId };
  if (tenantId) where.tenantId = tenantId;

  const device = await Device.findOne({ where });
  if (!device) throw createError('Device not found', 404);

  const patch = {};
  if (name !== undefined) patch.name = name.trim();
  if (model !== undefined) patch.model = model?.trim() || null;
  if (ipAddress !== undefined) patch.ipAddress = ipAddress?.trim() || null;
  if (branchId !== undefined) patch.branchId = branchId;
  if (status !== undefined) {
    if (!['ACTIVE', 'INACTIVE'].includes(status)) throw createError('Invalid status', 400);
    patch.status = status;
  }

  await device.update(patch);
  return { device };
};

// ── deleteDevice ──────────────────────────────────────────────────────────────
const deleteDevice = async (deviceId, tenantId = null) => {
  const where = { id: deviceId };
  if (tenantId) where.tenantId = tenantId;

  const device = await Device.findOne({ where });
  if (!device) throw createError('Device not found', 404);

  // DeviceMembers cascade-delete via DB constraint (onDelete: CASCADE)
  await device.destroy();
};

// ── listDeviceMembers ─────────────────────────────────────────────────────────
const listDeviceMembers = async (deviceId, tenantId = null) => {
  const deviceWhere = { id: deviceId };
  if (tenantId) deviceWhere.tenantId = tenantId;

  const device = await Device.findOne({ where: deviceWhere });
  if (!device) throw createError('Device not found', 404);

  const members = await DeviceMember.findAll({
    where: { deviceId },
    include: [{ model: User, as: 'user', attributes: ['id', 'fullName', 'email', 'phone'] }],
    order: [['zkPin', 'ASC']],
  });

  return { members };
};

// ── addDeviceMember ───────────────────────────────────────────────────────────
const addDeviceMember = async (deviceId, tenantId, { userId, zkPin, label }) => {
  const deviceWhere = { id: deviceId };
  if (tenantId) deviceWhere.tenantId = tenantId;

  const device = await Device.findOne({ where: deviceWhere });
  if (!device) throw createError('Device not found', 404);

  if (!Number.isInteger(zkPin) || zkPin < 1 || zkPin > 9999999) {
    throw createError('zkPin must be a positive integer between 1 and 9999999', 400);
  }

  // Check PIN uniqueness on this device
  const pinConflict = await DeviceMember.findOne({ where: { deviceId, zkPin } });
  if (pinConflict) throw createError(`PIN ${zkPin} is already assigned on this device`, 409);

  // Check user not already on this device
  const userConflict = await DeviceMember.findOne({ where: { deviceId, userId } });
  if (userConflict) throw createError('This user is already registered on this device', 409);

  const user = await User.findByPk(userId, { attributes: ['id', 'fullName', 'email'] });
  if (!user) throw createError('User not found', 404);

  const member = await DeviceMember.create({
    deviceId,
    tenantId: device.tenantId,
    userId,
    zkPin,
    label: label || user.fullName,
  });

  return { member: { ...member.toJSON(), user } };
};

// ── removeDeviceMember ────────────────────────────────────────────────────────
const removeDeviceMember = async (deviceId, memberId, tenantId = null) => {
  const deviceWhere = { id: deviceId };
  if (tenantId) deviceWhere.tenantId = tenantId;

  const device = await Device.findOne({ where: deviceWhere });
  if (!device) throw createError('Device not found', 404);

  const member = await DeviceMember.findOne({ where: { id: memberId, deviceId } });
  if (!member) throw createError('Device member not found', 404);

  await member.destroy();
};

// ── getTenantDeviceSummary ────────────────────────────────────────────────────
const getTenantDeviceSummary = async (tenantId) => {
  const devices = await Device.findAll({
    where: { tenantId },
    attributes: ['id', 'serialNumber', 'name', 'model', 'status', 'lastSeenAt', 'branchId'],
    order: [['name', 'ASC']],
  });

  const deviceIds = devices.map((d) => d.id);
  const memberCounts = await DeviceMember.findAll({
    where: { deviceId: deviceIds },
    attributes: ['deviceId', [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']],
    group: ['deviceId'],
    raw: true,
  });
  const countMap = Object.fromEntries(memberCounts.map((r) => [r.deviceId, Number(r.count)]));

  return {
    devices: devices.map((d) => ({
      ...d.toJSON(),
      memberCount: countMap[d.id] || 0,
    })),
  };
};

module.exports = {
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevice,
  listDeviceMembers,
  addDeviceMember,
  removeDeviceMember,
  getTenantDeviceSummary,
};
