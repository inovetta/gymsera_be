/**
 * Host access devices (ZKTeco spec §10, §11): add, list, detail (status only), edit, re-pair, unpair.
 * Permission checks are in the routes; every handler here is already tenant-scoped (req.tenantDb).
 */
const { utc } = require('../services/devices/sql-time');
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
    const { branchId, name, direction, linkMode, serialNumber, importFirst } = req.body;
    const result = await devices.createDevice({
      tenantId: req.tenantDb.tenantId,
      tenantDb: req.tenantDb,
      branchId,
      name,
      direction,
      linkMode,
      serialNumber,
      importFirst: importFirst === true,
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
    let found = await devices.updateDevice({
      ...args, name: req.body.name, direction: req.body.direction, attOptions: req.body.attOptions, pollDelaySeconds: req.body.pollDelaySeconds,
    });
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


// ── Phase 2: consent, enrolment, staff device access (ZKTeco spec §6.2, §7.6, D-8) ──────────
const privacy = () => require('../services/devices/device-privacy.service');

/** 404 unless the person is a member (or staff) of this tenant. */
const assertMember = async (tenantDb, userId) => {
  const { MemberSubscription, MemberProfile, GymStaff } = tenantDb.models;
  const found = (await MemberSubscription.count({ where: { userId } })) || (await MemberProfile.count({ where: { userId } })) || (await GymStaff.count({ where: { userId } }));
  if (!found) throw createError('Member not found.', 404, 'member_not_found');
};

const getConsent = async (req, res, next) => {
  try {
    await assertMember(req.tenantDb, req.params.memberId);
    const status = await require('../services/devices/biometric.service').consentStatus(req.tenantDb, req.params.memberId);
    return sendSuccess(res, { consent: status });
  } catch (err) {
    return next(err);
  }
};

const giveConsent = async (req, res, next) => {
  try {
    await assertMember(req.tenantDb, req.params.memberId);
    await privacy().giveConsent(req.tenantDb, { memberId: req.params.memberId, byUserId: userIdOf(req), method: req.body.method || 'in_person' });
    const status = await require('../services/devices/biometric.service').consentStatus(req.tenantDb, req.params.memberId);
    return sendSuccess(res, { consent: status }, 'Biometric consent recorded.');
  } catch (err) {
    return next(err);
  }
};

const withdrawConsent = async (req, res, next) => {
  try {
    await assertMember(req.tenantDb, req.params.memberId);
    const result = await privacy().withdrawConsent(req.tenantDb, { memberId: req.params.memberId, byUserId: userIdOf(req) });
    return sendSuccess(res, { templatesDeleted: result.templatesDeleted, photosDeleted: result.photosDeleted },
      'Consent withdrawn. The member\'s face, fingerprint and palm data is deleted here and from every device.');
  } catch (err) {
    return next(err);
  }
};

const enroll = async (req, res, next) => {
  try {
    await assertMember(req.tenantDb, req.body.memberId);
    const result = await privacy().requestEnrollment(req.tenantDb, { deviceId: req.params.id, memberId: req.body.memberId, type: req.body.type ?? 9 });
    return sendSuccess(res, result, 'Ask the member to stand in front of the device.', 202);
  } catch (err) {
    return next(err);
  }
};

/** Loads :staffId (a gym_staff row of this tenant) and exposes its branch to can(). */
const loadStaff = async (req, _res, next) => {
  try {
    const staff = await req.tenantDb.models.GymStaff.findByPk(req.params.staffId, { attributes: ['id', 'branchId', 'userId'] });
    if (!staff) return next(createError('Staff member not found.', 404, 'staff_not_found'));
    req.staffRow = staff;
    req.staffBranchId = staff.branchId;
    return next();
  } catch (err) {
    return next(err);
  }
};

/** This person's staff rows (branch, device access) in the branches the caller may see. */
const staffDeviceAccess = async (req, res, next) => {
  try {
    const permitted = req.permittedBranchIds ?? null;
    const rows = await req.tenantDb.sequelize.query(
      `SELECT s.id, s.branch_id, s.device_access, s.employment_status, s.status, b.branch_name FROM gym_staff s
         JOIN branches b ON b.id = s.branch_id WHERE s.user_id = ? ORDER BY b.branch_name`,
      { replacements: [req.params.userId], type: 'SELECT' }
    );
    const staff = rows
      .filter((r) => permitted === null || permitted.includes(r.branch_id))
      .map((r) => ({
        staffId: r.id, branchId: r.branch_id, branchName: r.branch_name, deviceAccess: Boolean(Number(r.device_access)),
        active: r.employment_status === 'ACTIVE' && r.status === 'active',
      }));
    return sendSuccess(res, { staff });
  } catch (err) {
    return next(err);
  }
};

const setStaffDeviceAccess = async (req, res, next) => {
  try {
    const on = Boolean(req.body.deviceAccess);
    await req.tenantDb.sequelize.query('UPDATE gym_staff SET device_access = ?, updated_at = ? WHERE id = ?', { replacements: utc([on ? 1 : 0, new Date(), req.staffRow.id]) });
    await require('../services/devices/device-triggers').enqueue(req.tenantDb.sequelize, { memberIds: [req.staffRow.userId], reason: 'staff_device_access' });
    return sendSuccess(res, { staffId: req.staffRow.id, deviceAccess: on });
  } catch (err) {
    return next(err);
  }
};

/** 404 unless req.body.memberId is a member (or staff) of this tenant. */
const assertBodyMember = async (req, _res, next) => {
  try {
    await assertMember(req.tenantDb, req.body.memberId);
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  assertBodyMember,
  loadDevice, listDevices, createDevice, getDevice, updateDevice, repairDevice,
  getConsent, giveConsent, withdrawConsent, enroll, loadStaff, setStaffDeviceAccess, staffDeviceAccess,
};
