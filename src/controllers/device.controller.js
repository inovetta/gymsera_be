const deviceService = require('../services/device.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');

// ── Admin: list all devices (platform-wide) ───────────────────────────────────
const listDevices = async (req, res, next) => {
  try {
    const { tenantId } = req.query;
    const { page, limit, offset } = parsePagination(req.query);
    const result = await deviceService.listDevices({ tenantId: tenantId || null, page, limit, offset });
    return sendSuccess(res, result, 'Devices retrieved', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── Admin: create device ──────────────────────────────────────────────────────
const createDevice = async (req, res, next) => {
  try {
    const { tenantId, branchId, serialNumber, name, model, ipAddress } = req.body;
    const result = await deviceService.createDevice({ tenantId, branchId, serialNumber, name, model, ipAddress });
    return sendSuccess(res, result, 'Device registered', 201);
  } catch (err) {
    next(err);
  }
};

// ── Admin: get device ─────────────────────────────────────────────────────────
const getDevice = async (req, res, next) => {
  try {
    const result = await deviceService.getDevice(req.params.id);
    return sendSuccess(res, result, 'Device retrieved');
  } catch (err) {
    next(err);
  }
};

// ── Admin: update device ──────────────────────────────────────────────────────
const updateDevice = async (req, res, next) => {
  try {
    const result = await deviceService.updateDevice(req.params.id, null, req.body);
    return sendSuccess(res, result, 'Device updated');
  } catch (err) {
    next(err);
  }
};

// ── Admin: delete device ──────────────────────────────────────────────────────
const deleteDevice = async (req, res, next) => {
  try {
    await deviceService.deleteDevice(req.params.id);
    return sendSuccess(res, null, 'Device deleted');
  } catch (err) {
    next(err);
  }
};

// ── Admin: list device members (PIN mappings) ─────────────────────────────────
const listDeviceMembers = async (req, res, next) => {
  try {
    const result = await deviceService.listDeviceMembers(req.params.id);
    return sendSuccess(res, result, 'Device members retrieved');
  } catch (err) {
    next(err);
  }
};

// ── Admin: add member PIN mapping ─────────────────────────────────────────────
const addDeviceMember = async (req, res, next) => {
  try {
    const { userId, zkPin, label } = req.body;
    const result = await deviceService.addDeviceMember(req.params.id, null, { userId, zkPin: parseInt(zkPin), label });
    return sendSuccess(res, result, 'Member PIN mapping added', 201);
  } catch (err) {
    next(err);
  }
};

// ── Admin: remove member PIN mapping ─────────────────────────────────────────
const removeDeviceMember = async (req, res, next) => {
  try {
    await deviceService.removeDeviceMember(req.params.id, req.params.memberId);
    return sendSuccess(res, null, 'Member PIN mapping removed');
  } catch (err) {
    next(err);
  }
};

// ── Host: list own devices summary ────────────────────────────────────────────
const myDevices = async (req, res, next) => {
  try {
    const result = await deviceService.getTenantDeviceSummary(req.user.tenantId);
    return sendSuccess(res, result, 'Devices retrieved');
  } catch (err) {
    next(err);
  }
};

// ── Host: create device ───────────────────────────────────────────────────────
const hostCreateDevice = async (req, res, next) => {
  try {
    const { branchId, serialNumber, name, model, ipAddress } = req.body;
    const result = await deviceService.createDevice({
      tenantId: req.user.tenantId,
      branchId,
      serialNumber,
      name,
      model,
      ipAddress,
    });
    return sendSuccess(res, result, 'Device registered', 201);
  } catch (err) {
    next(err);
  }
};

// ── Host: update device ───────────────────────────────────────────────────────
const hostUpdateDevice = async (req, res, next) => {
  try {
    const result = await deviceService.updateDevice(req.params.id, req.user.tenantId, req.body);
    return sendSuccess(res, result, 'Device updated');
  } catch (err) {
    next(err);
  }
};

// ── Host: delete device ───────────────────────────────────────────────────────
const hostDeleteDevice = async (req, res, next) => {
  try {
    await deviceService.deleteDevice(req.params.id, req.user.tenantId);
    return sendSuccess(res, null, 'Device deleted');
  } catch (err) {
    next(err);
  }
};

// ── Host: list device members ─────────────────────────────────────────────────
const hostListDeviceMembers = async (req, res, next) => {
  try {
    const result = await deviceService.listDeviceMembers(req.params.id, req.user.tenantId);
    return sendSuccess(res, result, 'Device members retrieved');
  } catch (err) {
    next(err);
  }
};

// ── Host: add member PIN mapping ──────────────────────────────────────────────
const hostAddDeviceMember = async (req, res, next) => {
  try {
    const { userId, zkPin, label } = req.body;
    const result = await deviceService.addDeviceMember(req.params.id, req.user.tenantId, {
      userId,
      zkPin: parseInt(zkPin),
      label,
    });
    return sendSuccess(res, result, 'Member PIN mapping added', 201);
  } catch (err) {
    next(err);
  }
};

// ── Host: remove member PIN mapping ──────────────────────────────────────────
const hostRemoveDeviceMember = async (req, res, next) => {
  try {
    await deviceService.removeDeviceMember(req.params.id, req.params.memberId, req.user.tenantId);
    return sendSuccess(res, null, 'Member PIN mapping removed');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listDevices, createDevice, getDevice, updateDevice, deleteDevice,
  listDeviceMembers, addDeviceMember, removeDeviceMember,
  myDevices, hostCreateDevice, hostUpdateDevice, hostDeleteDevice,
  hostListDeviceMembers, hostAddDeviceMember, hostRemoveDeviceMember,
};
