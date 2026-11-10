/**
 * Manual push, member device status, remote enrolment, live feed for a branch (ZKTeco spec §9,
 * §10.4, §10.5, §11). Permission checks are in the routes (host-device-push.routes.js); every
 * handler is tenant-scoped (req.tenantDb) and limited to req.permittedBranchIds when set.
 */
const push = require('../services/devices/device-push.service');
const screens = require('../services/devices/device-screens.service');
const { sendSuccess, createError } = require('../utils/response.utils');

const userIdOf = (req) => req.user?.id || req.user?.sub || null;
const roleKeyOf = (req) => (req.grants && req.grants.roleKeys && req.grants.roleKeys[0]) || null;
const ctxOf = (req) => ({ requestedBy: userIdOf(req), roleKey: roleKeyOf(req), req, permittedBranchIds: req.permittedBranchIds ?? null });
const ids = (v) => (Array.isArray(v) && v.length ? [...new Set(v)] : null);

const pushMember = async (req, res, next) => {
  try {
    const data = await push.pushMember(req.tenantDb, { memberId: req.params.memberId, deviceIds: ids(req.body.deviceIds), ...ctxOf(req) });
    return sendSuccess(res, data, data.reused ? 'Already pushing this member.' : 'Pushing to the devices.', 202);
  } catch (err) {
    return next(err);
  }
};

const removeMember = async (req, res, next) => {
  try {
    const data = await push.removeMember(req.tenantDb, { memberId: req.params.memberId, deviceIds: ids(req.body.deviceIds), ...ctxOf(req) });
    return sendSuccess(res, data, 'Removing the member from the devices.', 202);
  } catch (err) {
    return next(err);
  }
};

const memberDeviceStatus = async (req, res, next) => {
  try {
    return sendSuccess(res, await push.memberDeviceStatus(req.tenantDb, { memberId: req.params.memberId, permittedBranchIds: req.permittedBranchIds ?? null }));
  } catch (err) {
    return next(err);
  }
};

const enroll = async (req, res, next) => {
  try {
    const data = await push.requestEnroll(req.tenantDb, {
      memberId: req.params.memberId, deviceId: req.body.deviceId, type: req.body.type ?? 9, no: req.body.no ?? 0, ...ctxOf(req),
    });
    return sendSuccess(res, data, 'Ask the member to stand in front of the device.', 202);
  } catch (err) {
    return next(err);
  }
};

const requestStatus = async (req, res, next) => {
  try {
    return sendSuccess(res, await push.statusOf(req.tenantDb, req.params.requestId, { permittedBranchIds: req.permittedBranchIds ?? null }));
  } catch (err) {
    return next(err);
  }
};

/** 404 for a branch that is not this tenant's (before the permission check, which would pass for an owner). */
const loadBranch = async (req, _res, next) => {
  try {
    const [b] = await req.tenantDb.sequelize.query('SELECT id FROM branches WHERE id = ?', { replacements: [req.params.branchId], type: 'SELECT' });
    if (!b) return next(createError('Branch not found.', 404, 'branch_not_found'));
    return next();
  } catch (err) {
    return next(err);
  }
};

const pushBranch = async (req, res, next) => {
  try {
    const data = await push.pushDevices(req.tenantDb, { kind: 'branch', branchId: req.params.branchId, ...ctxOf(req), permittedBranchIds: null });
    return sendSuccess(res, data, data.reused ? 'Already pushing this branch.' : 'Pushing every pending change.', 202);
  } catch (err) {
    return next(err);
  }
};

const branchAccessEvents = async (req, res, next) => {
  try {
    return sendSuccess(res, await screens.accessEvents(req.tenantDb, { branchId: req.params.branchId, afterId: req.query.afterId, limit: req.query.limit }));
  } catch (err) {
    return next(err);
  }
};

module.exports = { pushMember, removeMember, memberDeviceStatus, enroll, requestStatus, loadBranch, pushBranch, branchAccessEvents };
