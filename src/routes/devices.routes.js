/**
 * devices.routes.js
 *
 * Two route groups:
 *
 *   /admin/devices  — platform admin manages all devices across all tenants
 *   /devices        — gym host manages their own tenant's devices
 *
 * Mounted from routes/index.js.
 */

const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const ctrl = require('../controllers/device.controller');

// ─────────────────────────────────────────────────────────────────────────────
// Admin routes  →  mounted at /admin/devices
// ─────────────────────────────────────────────────────────────────────────────
const adminRouter = Router();

adminRouter.use(authenticate, authorize('PLATFORM_ADMIN'));

// List all devices (optionally filter by tenantId query param)
adminRouter.get('/', ctrl.listDevices);

// Register a new device
adminRouter.post(
  '/',
  validate([
    body('tenantId').isUUID().withMessage('Valid tenantId UUID required'),
    body('branchId').isUUID().withMessage('Valid branchId UUID required'),
    body('serialNumber').notEmpty().withMessage('serialNumber is required'),
    body('name').notEmpty().withMessage('Device name is required'),
    body('model').optional({ nullable: true }).isString(),
    body('ipAddress').optional({ nullable: true }).isIP().withMessage('Must be a valid IP address'),
  ]),
  ctrl.createDevice
);

// Get single device
adminRouter.get(
  '/:id',
  validate([param('id').isUUID()]),
  ctrl.getDevice
);

// Update device
adminRouter.put(
  '/:id',
  validate([
    param('id').isUUID(),
    body('name').optional().notEmpty(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    body('ipAddress').optional({ nullable: true }).isIP().withMessage('Must be a valid IP address'),
  ]),
  ctrl.updateDevice
);

// Delete device (also deletes all PIN mappings)
adminRouter.delete(
  '/:id',
  validate([param('id').isUUID()]),
  ctrl.deleteDevice
);

// ── PIN mappings ──────────────────────────────────────────────────────────────

// List all member PIN mappings for a device
adminRouter.get('/:id/members', validate([param('id').isUUID()]), ctrl.listDeviceMembers);

// Add a PIN mapping: assign zkPin to a platform userId
adminRouter.post(
  '/:id/members',
  validate([
    param('id').isUUID(),
    body('userId').isUUID().withMessage('Valid userId UUID required'),
    body('zkPin').isInt({ min: 1, max: 9999999 }).withMessage('zkPin must be an integer 1–9999999'),
    body('label').optional({ nullable: true }).isString(),
  ]),
  ctrl.addDeviceMember
);

// Remove a PIN mapping
adminRouter.delete(
  '/:id/members/:memberId',
  validate([param('id').isUUID(), param('memberId').isUUID()]),
  ctrl.removeDeviceMember
);

// ─────────────────────────────────────────────────────────────────────────────
// Host routes  →  mounted at /devices
// Gym hosts manage only their own tenant's devices.
// ─────────────────────────────────────────────────────────────────────────────
const hostRouter = Router();

hostRouter.use(authenticate, authorize('GYM_HOST', 'BRANCH_MANAGER'));

// List own devices
hostRouter.get('/', ctrl.myDevices);

// Register a device for own tenant
hostRouter.post(
  '/',
  validate([
    body('branchId').isUUID().withMessage('Valid branchId UUID required'),
    body('serialNumber').notEmpty().withMessage('serialNumber is required'),
    body('name').notEmpty().withMessage('Device name is required'),
    body('model').optional({ nullable: true }).isString(),
    body('ipAddress').optional({ nullable: true }).isIP().withMessage('Must be a valid IP address'),
  ]),
  ctrl.hostCreateDevice
);

// Update own device
hostRouter.put(
  '/:id',
  validate([
    param('id').isUUID(),
    body('name').optional().notEmpty(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    body('ipAddress').optional({ nullable: true }).isIP(),
  ]),
  ctrl.hostUpdateDevice
);

// Delete own device
hostRouter.delete('/:id', validate([param('id').isUUID()]), ctrl.hostDeleteDevice);

// ── PIN mappings (host) ───────────────────────────────────────────────────────
hostRouter.get('/:id/members', validate([param('id').isUUID()]), ctrl.hostListDeviceMembers);

hostRouter.post(
  '/:id/members',
  validate([
    param('id').isUUID(),
    body('userId').isUUID().withMessage('Valid userId UUID required'),
    body('zkPin').isInt({ min: 1, max: 9999999 }).withMessage('zkPin must be an integer 1–9999999'),
    body('label').optional({ nullable: true }).isString(),
  ]),
  ctrl.hostAddDeviceMember
);

hostRouter.delete(
  '/:id/members/:memberId',
  validate([param('id').isUUID(), param('memberId').isUUID()]),
  ctrl.hostRemoveDeviceMember
);

module.exports = { adminRouter, hostRouter };
