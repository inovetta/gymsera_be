/**
 * /api/v1/host/devices: a gym's access devices (ZKTeco spec §11, Phase 1 subset).
 *
 * devices.view  list, detail                 (owner, org admin, manager, branch admin, front desk)
 * devices.manage add, edit, unpair            (owner, org admin, manager at their own branch)
 * devices.manage organization-wide: re-pair   (owner, org admin; spec §4.2 rule 3)
 * Platform admins: read with X-Tenant-Id, never write (§12). Mutations are audit-logged by
 * the /api/v1 auditLog middleware.
 *
 * Not to be confused with /devices and /admin/devices (devices.routes.js): the old router's
 * PIN-mapping routes for the platform `devices` table, left unchanged.
 */
const { Router } = require('express');
const { body, param, query } = require('express-validator');
const authenticate = require('../middleware/authenticate');
const tenantContext = require('../middleware/tenantContext');
const can = require('../middleware/can');
const validate = require('../middleware/validate');
const refusePlatformAdmin = require('../middleware/refusePlatformAdmin');
const ctrl = require('../controllers/host-devices.controller');
const screens = require('../controllers/host-device-screens.controller');
const imports = require('../controllers/host-device-import.controller');

const router = Router();
const idParam = param('id').isUUID().withMessage('Unknown device');
const name = (optional) => (optional ? body('name').optional() : body('name'))
  .isString().trim().isLength({ min: 1, max: 100 }).withMessage('Give the device a name (up to 100 characters).');
const direction = body('direction').optional().isIn(['in', 'out', 'both']).withMessage('Direction must be in, out or both.');

router.get(
  '/',
  authenticate,
  tenantContext.forTeamRoutes,
  validate([query('branchId').optional().isUUID().withMessage('Unknown branch')]),
  can.atAnyBranch('devices.view'),
  ctrl.listDevices
);

router.post(
  '/',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([
    body('branchId').isUUID().withMessage('Choose a branch.'),
    name(false),
    direction,
    body('linkMode').optional().isIn(['host', 'path', 'serial']).withMessage('Link mode must be host, path or serial.'),
    body('serialNumber').optional({ nullable: true }).isString().isLength({ max: 32 }),
    // Phase 4 (owner, 2026-11-11): required, no default. true = the device already has GymBioSync members:
    // added in import hold (nothing sent to it until go-live). NEW-239.
    body('importFirst').exists({ values: 'null' }).withMessage('Say whether this device already has members from GymBioSync.')
      .bail().isBoolean({ strict: true }).withMessage('Say whether this device already has members from GymBioSync: true or false.'),
  ], { stage: 2 }),
  can('devices.manage', { branch: 'body.branchId' }),
  ctrl.createDevice
);

// ── Phase 3: screens that are not one device (before /:id) ────────────────────────────────
router.get(
  '/unlinked-users',
  authenticate,
  tenantContext.forTeamRoutes,
  validate([query('branchId').optional().isUUID().withMessage('Unknown branch')]),
  can.atAnyBranch('devices.view'),
  screens.unlinkedAll
);

router.get(
  '/branch-settings/:branchId',
  authenticate,
  tenantContext.forTeamRoutes,
  validate([param('branchId').isUUID().withMessage('Unknown branch')]),
  screens.loadBranch,
  can('devices.view', { branch: 'params.branchId' }),
  screens.getBranchSettings
);

router.put(
  '/branch-settings/:branchId',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([
    param('branchId').isUUID().withMessage('Unknown branch'),
    body('capturePhotos').optional().isBoolean().withMessage('capturePhotos is true or false.'),
    body('alertsEnabled').optional().isBoolean().withMessage('alertsEnabled is true or false.'),
  ], { stage: 2 }),
  screens.loadBranch,
  can('devices.manage', { branch: 'params.branchId' }),
  screens.putBranchSettings
);

router.get(
  '/capture-photos/:photoId',
  authenticate,
  tenantContext.forTeamRoutes,
  validate([param('photoId').isInt({ min: 1 }).withMessage('Unknown photo')]),
  screens.loadCapturePhoto,
  can('devices.view', { branch: 'photoBranchId' }),
  screens.getCapturePhoto
);

router.get(
  '/:id',
  authenticate,
  tenantContext.forTeamRoutes,
  validate([idParam]),
  ctrl.loadDevice,
  can('devices.view', { branch: 'deviceBranchId' }),
  ctrl.getDevice
);

router.patch(
  '/:id',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([
    idParam, name(true), direction, body('enabled').optional().isBoolean().withMessage('enabled is true or false.'),
    // Phase 5: per-device options of a T&A PUSH device (null = back to the default) and its poll delay.
    body('attOptions').optional().isObject().withMessage('attOptions is an object.'),
    body('attOptions.userAuthorize').optional({ nullable: true }).isBoolean({ strict: true }).withMessage('userAuthorize is true or false.'),
    body('attOptions.validityMode').optional({ nullable: true }).isIn(['none', 'datetime', 'seconds']).withMessage('Validity must be none, datetime or seconds.'),
    body('attOptions.userCommandForm').optional({ nullable: true }).isIn(['user', 'userinfo']).withMessage('The user command form must be user or userinfo.'),
    body('pollDelaySeconds').optional({ nullable: true }).isInt({ min: 1, max: 5 }).withMessage('The poll delay is 1 to 5 seconds.').toInt(),
  ], { stage: 2 }),
  ctrl.loadDevice,
  can('devices.manage', { branch: 'deviceBranchId' }),
  ctrl.updateDevice
);

router.post(
  '/:id/repair',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([idParam], { stage: 2 }),
  ctrl.loadDevice,
  can('devices.manage', { orgWide: true }),
  ctrl.repairDevice
);

// Remove; with { wipeDevice: true, confirmName: '<device name>' } the device first deletes every
// GymsEra user (§10.3: explicit confirmation, never automatic).
router.delete(
  '/:id',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([
    idParam,
    body('wipeDevice').optional().isBoolean().withMessage('wipeDevice is true or false.'),
    body('confirmName').optional().isString().isLength({ max: 100 }),
  ], { stage: 2 }),
  ctrl.loadDevice,
  can('devices.manage', { branch: 'deviceBranchId' }),
  screens.unpairDevice
);

// ── Phase 2 (sync engine): consent, remote enrolment, staff device access ─────────────────
const memberParam = param('memberId').isUUID().withMessage('Unknown member');

router.get(
  '/members/:memberId/biometric-consent',
  authenticate,
  tenantContext.forTeamRoutes,
  validate([memberParam]),
  can.atAnyBranch('devices.view'),
  ctrl.getConsent
);

router.post(
  '/members/:memberId/biometric-consent',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([memberParam, body('method').optional().isIn(['in_person', 'app']).withMessage('method is in_person or app.')], { stage: 2 }),
  can.atAnyBranch('biometrics.enroll'),
  ctrl.giveConsent
);

router.delete(
  '/members/:memberId/biometric-consent',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([memberParam], { stage: 2 }),
  can.atAnyBranch('biometrics.delete'),
  ctrl.withdrawConsent
);

// The Team panel's "Door access" switches: one gym_staff row per branch of this person (D-8).
router.get(
  '/staff/by-user/:userId',
  authenticate,
  tenantContext.forTeamRoutes,
  validate([param('userId').isUUID().withMessage('Unknown staff member')]),
  can.atAnyBranch('devices.view'),
  ctrl.staffDeviceAccess
);

router.patch(
  '/staff/:staffId/device-access',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([param('staffId').isUUID().withMessage('Unknown staff member'), body('deviceAccess').isBoolean().withMessage('deviceAccess is true or false.')], { stage: 2 }),
  ctrl.loadStaff,
  can('devices.manage', { branch: 'staffBranchId' }),
  ctrl.setStaffDeviceAccess
);

router.post(
  '/:id/enroll',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([idParam, body('memberId').isUUID().withMessage('Choose a member.'), body('type').optional().isInt({ min: 1, max: 10 }).withMessage('Unknown biometric type.')], { stage: 2 }),
  ctrl.loadDevice,
  can('biometrics.enroll', { branch: 'deviceBranchId' }),
  ctrl.enroll
);

// ── Phase 3: one device's tabs and actions (§9.1, §10.3) ──────────────────────────────────
const view = (path, handler, extra = []) => router.get(
  path,
  authenticate,
  tenantContext.forTeamRoutes,
  validate([idParam, ...extra]),
  ctrl.loadDevice,
  can('devices.view', { branch: 'deviceBranchId' }),
  handler
);
view('/:id/members', screens.deviceMembers, [query('limit').optional().isInt({ min: 1, max: 500 }), query('offset').optional().isInt({ min: 0 })]);
view('/:id/access-events', screens.deviceAccessEvents, [query('afterId').optional().isInt({ min: 0 }), query('limit').optional().isInt({ min: 1, max: 200 })]);
view('/:id/errors', screens.deviceErrors, [query('limit').optional().isInt({ min: 1, max: 200 })]);
view('/:id/commands', screens.deviceCommands);
view('/:id/audits', screens.deviceAudits);
view('/:id/unlinked-users', screens.unlinkedForDevice);

/** Sync now: devices.push. Full audit: devices.manage (§12). */
const syncPermission = (req, res, next) => can(req.body.mode === 'audit' ? 'devices.manage' : 'devices.push', { branch: 'deviceBranchId' })(req, res, next);
router.post(
  '/:id/sync',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([idParam, body('mode').optional().isIn(['quick', 'audit']).withMessage('mode is quick or audit.')], { stage: 2 }),
  ctrl.loadDevice,
  syncPermission,
  screens.syncDevice
);

const pinParam = param('pin').matches(/^[0-9A-Za-z]{1,16}$/).withMessage('Unknown device user');
router.post(
  '/:id/unlinked-users/:pin/link',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([idParam, pinParam, body('memberId').isUUID().withMessage('Choose a member.')], { stage: 2 }),
  ctrl.loadDevice,
  can('devices.manage', { branch: 'deviceBranchId' }),
  ctrl.assertBodyMember,
  screens.linkUnlinked
);

router.post(
  '/:id/unlinked-users/:pin/dismiss',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([idParam, pinParam, body('removeFromDevice').optional().isBoolean().withMessage('removeFromDevice is true or false.')], { stage: 2 }),
  ctrl.loadDevice,
  can('devices.manage', { branch: 'deviceBranchId' }),
  screens.dismissUnlinked
);

// ── Phase 4: import from device (GymBioSync), cut-over, move (§11, §15 Phase 4) ─────────────────────
const importParam = param('importId').matches(/^[0-9A-Z]{26}$/).withMessage('Unknown import');
const importPin = param('pin').matches(/^\d{1,9}$/).withMessage('Unknown device user');
const manage = (path, method, handler, checks = [], extra = []) => router[method](
  path,
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([idParam, ...checks], { stage: 2 }),
  ctrl.loadDevice,
  can('devices.manage', { branch: 'deviceBranchId' }),
  ...extra,
  handler
);

view('/:id/imports', imports.listImports);
view('/:id/imports/:importId', imports.getImport, [importParam]);
view('/:id/imports/:importId/users', imports.listUsers, [
  importParam,
  query('filter').optional().isIn(['all', 'matched', 'unmatched', 'conflict', 'admin', 'remove']).withMessage('Unknown filter.'),
  query('limit').optional().isInt({ min: 1, max: 500 }),
  query('offset').optional().isInt({ min: 0 }),
]);
view('/:id/imports/:importId/preview', imports.preview, [importParam]);
view('/:id/cutover', imports.getCutover);

manage('/:id/imports', 'post', imports.startImport);
manage('/:id/imports/:importId/users/:pin', 'put', imports.matchUser, [
  importParam,
  importPin,
  body('memberId').optional({ nullable: true }).isUUID().withMessage('Choose a member.'),
  body('removeAtGoLive').optional().isBoolean().withMessage('removeAtGoLive is true or false.'),
]);
manage('/:id/imports/:importId/mapping', 'post', imports.mapCsv, [
  importParam,
  body('csv').isString().isLength({ min: 1, max: 1048576 }).withMessage('Upload a CSV file of at most 1 MB.'),
]);
manage('/:id/imports/:importId/apply', 'post', imports.apply, [importParam]);
manage('/:id/imports/:importId/rollback', 'post', imports.rollback, [importParam]);
manage('/:id/imports/:importId/cancel', 'post', imports.cancel, [importParam]);
manage('/:id/imports/:importId/reread', 'post', imports.reread, [importParam]); // NEW-242
manage('/:id/cutover/go-live', 'post', imports.goLive, [body('removeUnmatched').optional().isBoolean().withMessage('removeUnmatched is true or false.')]);
manage('/:id/cutover/gymbiosync-stopped', 'post', imports.gbsStopped);
// Move to another branch: devices.manage at the device's branch AND at the new one. Named /branch, not /move:
// no route may end in /move (R-81, Move branch removed; guard p5b-08). Spec §11's `POST …/move`.
manage('/:id/branch', 'put', imports.moveDevice, [body('branchId').isUUID().withMessage('Choose a branch.')], [
  (req, res, next) => can('devices.manage', { branch: 'body.branchId' })(req, res, next),
]);

module.exports = router;
