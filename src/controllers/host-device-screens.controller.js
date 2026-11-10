/**
 * Device page tabs, Unlinked users, branch device settings, capture photos, Sync now, wipe on
 * unpair (ZKTeco spec §9.1, §10.3, D-6). Permission checks are in host-devices.routes.js; :id is
 * loaded (tenant-scoped, 404 otherwise) by host-devices.controller#loadDevice.
 */
const screens = require('../services/devices/device-screens.service');
const push = require('../services/devices/device-push.service');
const registry = require('../services/devices/device-registry.service');
const audit = require('../services/audit.service');
const { sendSuccess, createError } = require('../utils/response.utils');

const userIdOf = (req) => req.user?.id || req.user?.sub || null;
const roleKeyOf = (req) => (req.grants && req.grants.roleKeys && req.grants.roleKeys[0]) || null;
const wrap = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (err) {
    return next(err);
  }
};
const record = (req, action, entry) => audit.record({ tenantDb: req.tenantDb, userId: userIdOf(req), roleKey: roleKeyOf(req), req, branchId: entry.branchId || null }, { action, ...entry });

/** The branches the caller may see devices at (null = all), narrowed to ?branchId when given. */
const branchScope = (req) => {
  const permitted = req.permittedBranchIds ?? null;
  if (!req.query.branchId) return permitted;
  if (permitted !== null && !permitted.includes(req.query.branchId)) throw createError('You do not have permission to view access devices here', 403, 'forbidden');
  return [req.query.branchId];
};

// ── Sync now / Full audit (§9.1) ──────────────────────────────────────────────
const syncDevice = wrap(async (req, res) => {
  if (req.body.mode === 'audit') {
    // Phase 4: an audit removes users GymsEra does not want; never during an import.
    if (Number(req.device.details?.import_hold)) throw createError('This device is being imported. Audit it after you go live.', 409, 'device_in_import');
    const { requestAudit } = require('../jobs/device-jobs');
    const r = await requestAudit(req.tenantDb, req.params.id);
    await record(req, 'devices.audit_requested', { targetType: 'device', targetId: req.params.id, branchId: req.deviceBranchId, after: { auditId: r.auditId } });
    return sendSuccess(res, { auditId: r.auditId }, 'Full audit asked. The report is ready in about 1 to 3 minutes.', 202);
  }
  const data = await push.pushDevices(req.tenantDb, { kind: 'device', deviceIds: [req.params.id], requestedBy: userIdOf(req), roleKey: roleKeyOf(req), req });
  return sendSuccess(res, data, data.reused ? 'Already syncing this device.' : 'Syncing every pending change.', 202);
});

// ── Tabs (§10.3) ──────────────────────────────────────────────────────────────
const deviceMembers = wrap(async (req, res) => sendSuccess(res, await screens.deviceMembers(req.tenantDb, req.params.id, req.query)));
const deviceAccessEvents = wrap(async (req, res) => sendSuccess(res, await screens.accessEvents(req.tenantDb, { deviceId: req.params.id, afterId: req.query.afterId, limit: req.query.limit })));
const deviceErrors = wrap(async (req, res) => sendSuccess(res, await screens.deviceErrors(req.tenantDb, req.params.id, req.query)));
const deviceCommands = wrap(async (req, res) => sendSuccess(res, await screens.deviceCommands(req.tenantDb, req.params.id, req.query)));
const deviceAudits = wrap(async (req, res) => sendSuccess(res, await screens.deviceAudits(req.tenantDb, req.params.id)));

// ── Unlinked users (§7.5) ─────────────────────────────────────────────────────
const unlinkedForDevice = wrap(async (req, res) => sendSuccess(res, await screens.unlinkedUsers(req.tenantDb, { deviceIds: [req.params.id] })));

const unlinkedAll = wrap(async (req, res) => {
  const list = await registry.listDevices({ tenantId: req.tenantDb.tenantId, tenantDb: req.tenantDb, branchIds: branchScope(req) });
  return sendSuccess(res, await screens.unlinkedUsers(req.tenantDb, { deviceIds: list.map((d) => d.id) }));
});

const linkUnlinked = wrap(async (req, res) => {
  const result = await screens.linkUnlinked(req.tenantDb, { deviceId: req.params.id, pin: req.params.pin, memberId: req.body.memberId });
  await record(req, 'devices.unlinked_linked', { targetType: 'device', targetId: req.params.id, branchId: req.deviceBranchId, after: { pin: result.pin, memberId: result.memberId } });
  return sendSuccess(res, result, 'Device user linked to the member.');
});

const dismissUnlinked = wrap(async (req, res) => {
  const result = await screens.dismissUnlinked(req.tenantDb, { deviceId: req.params.id, pin: req.params.pin, removeFromDevice: Boolean(req.body.removeFromDevice) });
  await record(req, 'devices.unlinked_dismissed', { targetType: 'device', targetId: req.params.id, branchId: req.deviceBranchId, after: result });
  return sendSuccess(res, result, result.removeFromDevice ? 'Dismissed. The device will delete this user.' : 'Dismissed.');
});

// ── Branch settings (D-6, alerts) ─────────────────────────────────────────────
const loadBranch = async (req, _res, next) => {
  try {
    const [b] = await req.tenantDb.sequelize.query('SELECT id FROM branches WHERE id = ?', { replacements: [req.params.branchId], type: 'SELECT' });
    if (!b) return next(createError('Branch not found.', 404, 'branch_not_found'));
    return next();
  } catch (err) {
    return next(err);
  }
};

const getBranchSettings = wrap(async (req, res) => sendSuccess(res, { settings: await screens.branchSettings(req.tenantDb, req.params.branchId) }));

const putBranchSettings = wrap(async (req, res) => {
  const { before, photosDeleted, ...settings } = await screens.updateBranchSettings(req.tenantDb, {
    branchId: req.params.branchId, capturePhotos: req.body.capturePhotos, alertsEnabled: req.body.alertsEnabled, byUserId: userIdOf(req),
  });
  await record(req, 'devices.branch_settings', {
    targetType: 'branch', targetId: req.params.branchId, branchId: req.params.branchId,
    before: { capturePhotos: before.capturePhotos, alertsEnabled: before.alertsEnabled },
    after: { capturePhotos: settings.capturePhotos, alertsEnabled: settings.alertsEnabled, photosDeleted },
  });
  return sendSuccess(res, { settings, photosDeleted }, 'Device settings saved.');
});

// ── Capture photos (D-6) ──────────────────────────────────────────────────────
/** Loads :photoId and exposes its branch to can({ branch: 'photoBranchId' }). */
const loadCapturePhoto = async (req, _res, next) => {
  try {
    req.capturePhoto = await screens.capturePhoto(req.tenantDb, req.params.photoId);
    req.photoBranchId = req.capturePhoto.branch_id;
    return next();
  } catch (err) {
    return next(err);
  }
};

const getCapturePhoto = wrap(async (req, res) => {
  const bytes = await screens.capturePhotoBytes(req.capturePhoto);
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'Content-Length': String(bytes.length) });
  return res.status(200).send(bytes);
});

// ── Remove, with an optional wipe (§10.3) ─────────────────────────────────────
const unpairDevice = wrap(async (req, res) => {
  const wipe = req.body && req.body.wipeDevice === true;
  if (wipe) {
    const name = String(req.device.view.name || '').trim().toLowerCase();
    if (String(req.body.confirmName || '').trim().toLowerCase() !== name || !name) {
      throw createError('Type the device name to confirm the wipe.', 422, 'wipe_confirmation_required');
    }
  }
  const result = await registry.unpairDevice({ tenantId: req.tenantDb.tenantId, tenantDb: req.tenantDb, deviceId: req.params.id, wipe });
  await record(req, wipe ? 'devices.removed_with_wipe' : 'devices.removed', { targetType: 'device', targetId: req.params.id, branchId: req.deviceBranchId, after: result });
  return sendSuccess(res, { id: req.params.id, ...result }, wipe
    ? 'The device will delete every GymsEra user the next time it connects, then it is removed.'
    : 'Device removed from GymsEra. Its users stay on the device.');
});

module.exports = {
  syncDevice, deviceMembers, deviceAccessEvents, deviceErrors, deviceCommands, deviceAudits,
  unlinkedForDevice, unlinkedAll, linkUnlinked, dismissUnlinked,
  loadBranch, getBranchSettings, putBranchSettings, loadCapturePhoto, getCapturePhoto, unpairDevice,
};
