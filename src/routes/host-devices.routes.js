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
  ], { stage: 2 }),
  can('devices.manage', { branch: 'body.branchId' }),
  ctrl.createDevice
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
  validate.strict([idParam, name(true), direction, body('enabled').optional().isBoolean().withMessage('enabled is true or false.')], { stage: 2 }),
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

router.delete(
  '/:id',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([idParam], { stage: 2 }),
  ctrl.loadDevice,
  can('devices.manage', { branch: 'deviceBranchId' }),
  ctrl.unpairDevice
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
  can.atAnyBranch('devices.manage'),
  ctrl.giveConsent
);

router.delete(
  '/members/:memberId/biometric-consent',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([memberParam], { stage: 2 }),
  can.atAnyBranch('devices.manage'),
  ctrl.withdrawConsent
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
  can('devices.manage', { branch: 'deviceBranchId' }),
  ctrl.enroll
);

module.exports = router;
