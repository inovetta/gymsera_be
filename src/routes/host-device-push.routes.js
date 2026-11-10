/**
 * /api/v1/host/…: manual push and the member / branch device views (ZKTeco spec §9, §10.4, §10.5, §11).
 * Mounted before host.routes; only these paths.
 *
 * devices.push        Push now, Remove from device now, Push to branch   (owner, org admin, manager, branch admin, front desk)
 * devices.view        member device status, request status, live feed    (the same, front desk and branch admin view)
 * biometrics.enroll   remote enrolment                                   (owner, org admin, manager, branch admin, front desk)
 * Platform admins: read only (§12: no push, no biometric access). Every push is written to the
 * tenant audit log by device-push.service (devices.push, devices.push_result).
 */
const { Router } = require('express');
const { body, param, query } = require('express-validator');
const authenticate = require('../middleware/authenticate');
const tenantContext = require('../middleware/tenantContext');
const can = require('../middleware/can');
const validate = require('../middleware/validate');
const refusePlatformAdmin = require('../middleware/refusePlatformAdmin');
const ctrl = require('../controllers/host-device-push.controller');

const router = Router();
const memberParam = param('memberId').isUUID().withMessage('Unknown member');
const branchParam = param('branchId').isUUID().withMessage('Unknown branch');
const deviceIds = body('deviceIds').optional().isArray({ min: 1, max: 50 }).withMessage('deviceIds is a list of devices.');
const deviceIdItems = body('deviceIds.*').isUUID().withMessage('Unknown device');

router.post(
  '/members/:memberId/device-push',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([memberParam, deviceIds, deviceIdItems], { stage: 2 }),
  can.atAnyBranch('devices.push'),
  ctrl.pushMember
);

router.post(
  '/members/:memberId/device-remove',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([memberParam, deviceIds, deviceIdItems], { stage: 2 }),
  can.atAnyBranch('devices.push'),
  ctrl.removeMember
);

router.get(
  '/members/:memberId/device-status',
  authenticate,
  tenantContext.forTeamRoutes,
  validate([memberParam]),
  can.atAnyBranch('devices.view'),
  ctrl.memberDeviceStatus
);

router.post(
  '/members/:memberId/biometrics/enroll',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([
    memberParam,
    body('deviceId').isUUID().withMessage('Choose a device.'),
    body('type').optional().isInt({ min: 1, max: 10 }).withMessage('Unknown biometric type.'),
    body('no').optional().isInt({ min: 0, max: 9 }).withMessage('Unknown finger number.'),
  ], { stage: 2 }),
  can.atAnyBranch('biometrics.enroll'),
  ctrl.enroll
);

router.get(
  '/device-push-requests/:requestId',
  authenticate,
  tenantContext.forTeamRoutes,
  validate([param('requestId').matches(/^[0-9A-Z]{26}$/).withMessage('Unknown push request')]),
  can.atAnyBranch('devices.view'),
  ctrl.requestStatus
);

router.post(
  '/branches/:branchId/device-push',
  authenticate,
  refusePlatformAdmin.deviceWrite,
  tenantContext.forTeamRoutes,
  validate.strict([branchParam], { stage: 2 }),
  ctrl.loadBranch,
  can('devices.push', { branch: 'params.branchId' }),
  ctrl.pushBranch
);

router.get(
  '/branches/:branchId/access-events',
  authenticate,
  tenantContext.forTeamRoutes,
  validate([branchParam, query('afterId').optional().isInt({ min: 0 }), query('limit').optional().isInt({ min: 1, max: 200 })]),
  ctrl.loadBranch,
  can('devices.view', { branch: 'params.branchId' }),
  ctrl.branchAccessEvents
);

module.exports = router;
