/**
 * Host access devices (ZKTeco spec §10, §11): add, list, detail (status only), edit, re-pair, unpair.
 * Permission checks are in the routes; every handler here is already tenant-scoped (req.tenantDb).
 */
const devices = require('../services/devices/device-registry.service');
const { sendSuccess, createError } = require('../utils/response.utils');

const userIdOf = (req) => req.user?.id || req.user?.sub || null;

/** Loads :id for this tenant (404 otherwise) and exposes its branch to can({ branch: 'deviceBranchId' }). */
const loadDevice = async (req, _res, next) => {
  try {
    const found = await devices.getDevice({ tenantId: req.tenantId || req.tenantDb.tenantId, tenantDb: req.tenantDb, deviceId: req.params.id });
    if (!found) return next(createError('Device not found.', 404, 'device_not_found'));
    req.device = found;
    req.deviceBranchId = found.row.branch_id;
    return next();
  } catch (err) {
    return next(err);
  }
};

const listDevices = async (req, res, next) => {
  try {
    const permitted = req.permittedBranchIds; // null = every branch
    let branchIds = permitted;
    if (req.query.branchId) {
      if (permitted !== null && !permitted.includes(req.query.branchId)) {
        throw createError('You do not have permission to view access devices here', 403, 'forbidden');
      }
      branchIds = [req.query.branchId];
    }
    const list = await devices.listDevices({ tenantId: req.tenantDb.tenantId, tenantDb: req.tenantDb, branchIds });
    return sendSuccess(res, { devices: list });
  } catch (err) {
    return next(err);
  }
};

const createDevice = async (req, res, next) => {
  try {
    const { branchId, name, direction, linkMode, serialNumber } = req.body;
    const result = await devices.createDevice({
      tenantId: req.tenantDb.tenantId,
      tenantDb: req.tenantDb,
      branchId,
      name,
      direction,
      linkMode,
      serialNumber,
      createdBy: userIdOf(req),
    });
    return sendSuccess(res, result, 'Device added. Enter the settings below on the device.', 201);
  } catch (err) {
    return next(err);
  }
};

const getDevice = (req, res) => sendSuccess(res, { device: req.device.view, setup: req.device.setup });

const updateDevice = async (req, res, next) => {
  try {
    const args = { tenantId: req.tenantDb.tenantId, tenantDb: req.tenantDb, deviceId: req.params.id };
    let found = await devices.updateDevice({ ...args, name: req.body.name, direction: req.body.direction });
    if (req.body.enabled !== undefined) found = await devices.setEnabled({ ...args, enabled: Boolean(req.body.enabled) });
    return sendSuccess(res, { device: found.view, setup: found.setup });
  } catch (err) {
    return next(err);
  }
};

const repairDevice = async (req, res, next) => {
  try {
    const result = await devices.repairDevice({ tenantId: req.tenantDb.tenantId, tenantDb: req.tenantDb, deviceId: req.params.id });
    return sendSuccess(res, result, 'New device key created. Enter it on the device; the old key no longer works.');
  } catch (err) {
    return next(err);
  }
};

const unpairDevice = async (req, res, next) => {
  try {
    await devices.unpairDevice({ tenantId: req.tenantDb.tenantId, tenantDb: req.tenantDb, deviceId: req.params.id });
    return sendSuccess(res, { id: req.params.id }, 'Device removed from GymsEra.');
  } catch (err) {
    return next(err);
  }
};

module.exports = { loadDevice, listDevices, createDevice, getDevice, updateDevice, repairDevice, unpairDevice };
