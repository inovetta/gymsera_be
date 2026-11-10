/**
 * Import from device, cut-over, move, one-template delete (ZKTeco spec §11, §15 Phase 4).
 * Permission checks are in the routes; :id is loaded (tenant-scoped, 404 otherwise) by
 * host-devices.controller#loadDevice. Every change is written to the tenant audit log (IDs and counts
 * only, never a template).
 */
const imports = require('../services/devices/device-import.service');
const registry = require('../services/devices/device-registry.service');
const biometrics = require('../services/devices/biometric.service');
const audit = require('../services/audit.service');
const { sendSuccess, createError } = require('../utils/response.utils');

const userIdOf = (req) => req.user?.id || req.user?.sub || null;
const roleKeyOf = (req) => (req.grants && req.grants.roleKeys && req.grants.roleKeys[0]) || null;
const tenantIdOf = (req) => req.tenantId || req.tenantDb.tenantId;
const wrap = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (err) {
    return next(err);
  }
};
const record = (req, action, after) => audit.record(
  { tenantDb: req.tenantDb, userId: userIdOf(req), roleKey: roleKeyOf(req), req, branchId: req.deviceBranchId || null },
  { action, targetType: 'device', targetId: req.params.id, after }
);
const importOf = (req) => imports.importOf(req.tenantDb, req.params.id, req.params.importId);

// ── Import ────────────────────────────────────────────────────────────────────
const startImport = wrap(async (req, res) => {
  const out = await imports.startImport(req.tenantDb, { tenantId: tenantIdOf(req), deviceId: req.params.id, byUserId: userIdOf(req) });
  if (!out.reused) await record(req, 'devices.import_started', { importId: out.import.id });
  return out.reused
    ? sendSuccess(res, out, 'This device is already being imported.')
    : sendSuccess(res, out, 'Reading the users on the device. This takes a minute or two.', 202);
});

const listImports = wrap(async (req, res) => sendSuccess(res, await imports.listImports(req.tenantDb, req.params.id)));

const getImport = wrap(async (req, res) => sendSuccess(res, { import: await imports.viewOf(req.tenantDb, await importOf(req)) }));

const listUsers = wrap(async (req, res) => sendSuccess(res, await imports.listUsers(req.tenantDb, await importOf(req), {
  filter: req.query.filter, limit: req.query.limit, offset: req.query.offset,
})));

const matchUser = wrap(async (req, res) => {
  const imp = await importOf(req);
  imports.assertEditable(imp);
  const user = await imports.setMatch(req.tenantDb, imp, req.params.pin, { memberId: req.body.memberId, removeAtGoLive: req.body.removeAtGoLive });
  await record(req, 'devices.import_matched', { importId: imp.id, pin: user.pin, memberId: user.memberId, removeAtGoLive: user.removeAtGoLive });
  return sendSuccess(res, { user });
});

const mapCsv = wrap(async (req, res) => {
  const imp = await importOf(req);
  const out = await imports.mapCsv(req.tenantDb, imp, req.body.csv);
  await record(req, 'devices.import_mapping', { importId: imp.id, matched: out.matched, errors: out.errors.length });
  return sendSuccess(res, out);
});

const preview = wrap(async (req, res) => sendSuccess(res, { preview: await imports.preview(req.tenantDb, await importOf(req)) }));

const apply = wrap(async (req, res) => {
  const out = await imports.apply(req.tenantDb, await importOf(req), { byUserId: userIdOf(req) });
  if (!out.alreadyApplied) await record(req, 'devices.import_applied', { importId: out.import.id, ...out.result });
  return sendSuccess(res, out, out.alreadyApplied ? 'Already applied.' : 'Applied. Nothing changes on the device until you go live.');
});

const rollback = wrap(async (req, res) => {
  const out = await imports.rollback(req.tenantDb, await importOf(req), { byUserId: userIdOf(req) });
  await record(req, 'devices.import_rolled_back', { importId: out.import.id });
  return sendSuccess(res, out, 'Rolled back. The device was not changed.');
});

const cancel = wrap(async (req, res) => {
  const out = await imports.cancel(req.tenantDb, await importOf(req), { byUserId: userIdOf(req) });
  await record(req, 'devices.import_cancelled', { importId: out.import.id });
  return sendSuccess(res, out, 'Import cancelled. GymsEra manages the device again.');
});

// ── Cut-over ──────────────────────────────────────────────────────────────────
const getCutover = wrap(async (req, res) => sendSuccess(res, { cutover: await imports.cutover(req.tenantDb, { tenantId: tenantIdOf(req), deviceId: req.params.id }) }));

const goLive = wrap(async (req, res) => {
  const cutover = await imports.goLive(req.tenantDb, {
    tenantId: tenantIdOf(req), deviceId: req.params.id, byUserId: userIdOf(req), removeUnmatched: req.body.removeUnmatched === true,
  });
  await record(req, 'devices.import_live', { importId: cutover.import?.id || null, removeUnmatched: req.body.removeUnmatched === true });
  return sendSuccess(res, { cutover }, 'Live. GymsEra now manages who this device lets in.');
});

const gbsStopped = wrap(async (req, res) => {
  const cutover = await imports.markGbsStopped(req.tenantDb, { tenantId: tenantIdOf(req), deviceId: req.params.id });
  await record(req, 'devices.gymbiosync_stopped', {});
  return sendSuccess(res, { cutover });
});

// ── Move ──────────────────────────────────────────────────────────────────────
const moveDevice = wrap(async (req, res) => {
  const from = req.deviceBranchId;
  const out = await registry.moveDevice({ tenantId: tenantIdOf(req), tenantDb: req.tenantDb, deviceId: req.params.id, branchId: req.body.branchId });
  await record(req, 'devices.moved', { fromBranchId: from, toBranchId: req.body.branchId, queued: out.sync.queued });
  return sendSuccess(res, out, 'Device moved. It now lets in this branch\'s members.');
});

// ── One template ──────────────────────────────────────────────────────────────
const deleteTemplate = wrap(async (req, res) => {
  await require('../services/devices/device-push.service').assertMember(req.tenantDb, req.params.memberId);
  const out = await biometrics.deleteTemplate(req.tenantDb, { memberId: req.params.memberId, bioId: req.params.bioId });
  if (!out.deleted) throw createError('Template not found.', 404, 'template_not_found');
  // Every device drops it (no exit grace: the template is gone, the member is not).
  await require('../services/devices/device-sync.service').reconcileMember(req.tenantDb, req.params.memberId, 'template_deleted', { priority: 1 });
  await audit.record(
    { tenantDb: req.tenantDb, userId: userIdOf(req), roleKey: roleKeyOf(req), req, branchId: null },
    { action: 'biometrics.template_deleted', targetType: 'member', targetId: req.params.memberId, after: { bioId: req.params.bioId, type: out.bioType } }
  );
  return sendSuccess(res, { deleted: out.deleted, bioId: req.params.bioId, type: out.bioType }, 'Template deleted here and from the devices.');
});

module.exports = {
  startImport, listImports, getImport, listUsers, matchUser, mapCsv, preview, apply, rollback, cancel,
  getCutover, goLive, gbsStopped, moveDevice, deleteTemplate,
};
