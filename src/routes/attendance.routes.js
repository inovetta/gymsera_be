const { Router } = require('express');
const controller = require('../controllers/attendance.controller');
const validators = require('../validators/attendance.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const tenantContext = require('../middleware/tenantContext');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Attendance
 *   description: QR-code and manual gym check-in
 */

/**
 * @swagger
 * /attendance/qr-scan:
 *   post:
 *     summary: QR code check-in — validates subscription and records attendance
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [qrCode, branchId]
 *             properties:
 *               qrCode:   { type: string }
 *               branchId: { type: string, format: uuid }
 *               deviceId: { type: string }
 *     responses:
 *       201:
 *         description: Check-in recorded
 *       403:
 *         description: Subscription inactive, expired, or visits exhausted
 *       404:
 *         description: QR code / branch not found
 */
router.post(
  '/qr-scan',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  validate(validators.qrScan),
  controller.qrScan
);

/**
 * @swagger
 * /attendance/manual:
 *   post:
 *     summary: Staff manual check-in
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, branchId, subscriptionId]
 *             properties:
 *               userId:         { type: string, format: uuid }
 *               branchId:       { type: string, format: uuid }
 *               subscriptionId: { type: string, format: uuid }
 *               notes:          { type: string }
 *     responses:
 *       201:
 *         description: Check-in recorded
 *       403:
 *         description: Subscription not valid
 */
router.post(
  '/manual',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  validate(validators.manual),
  controller.manual
);

/**
 * @swagger
 * /attendance:
 *   get:
 *     summary: List attendance logs (host view)
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: branchId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: date
 *         schema: { type: string, format: date }
 *         description: Filter to a specific date (YYYY-MM-DD)
 *       - in: query
 *         name: userId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated attendance log
 */
router.get(
  '/',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  validate(validators.list),
  controller.list
);

// ── Sprint 8H new endpoints ───────────────────────────────────────────────────

/**
 * @swagger
 * /attendance/device-notify:
 *   post:
 *     summary: ZKTeco / biometric device push (API-key secured, no JWT)
 *     tags: [Attendance]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [deviceId, userId, branchId]
 *             properties:
 *               deviceId:  { type: string }
 *               userId:    { type: string, format: uuid }
 *               branchId:  { type: string, format: uuid }
 *               eventTime: { type: string, format: date-time }
 *     responses:
 *       201:
 *         description: Device event recorded
 *       401:
 *         description: Invalid or missing API key
 */
router.post(
  '/device-notify',
  // API-key guard
  (req, _res, next) => {
    const apiKey = req.headers['x-device-api-key'];
    if (!apiKey || apiKey !== process.env.DEVICE_API_KEY) {
      const err = new Error('Invalid or missing device API key');
      err.statusCode = 401;
      return next(err);
    }
    next();
  },
  // Device-specific tenant resolver — uses tenantId from body (no JWT available)
  async (req, res, next) => {
    try {
      const tenantId = req.body.tenantId;
      if (!tenantId) return res.status(400).json({ success: false, message: 'tenantId is required in device payload' });

      const { safeRedisGet, safeRedisSetex } = require('../config/redis.config');
      const TenantDbManager = require('../database/TenantDbManager');
      const { Tenant } = require('../models/platform');

      const cacheKey = `tenant:${tenantId}:connStr`;
      let encryptedConnStr = await safeRedisGet(cacheKey);

      if (!encryptedConnStr) {
        const tenant = await Tenant.findOne({ where: { id: tenantId, status: 'ACTIVE' }, attributes: ['id', 'connectionStringEncrypted'] });
        if (!tenant || !tenant.connectionStringEncrypted) return res.status(404).json({ success: false, message: 'Tenant not found or not active' });
        encryptedConnStr = tenant.connectionStringEncrypted;
        await safeRedisSetex(cacheKey, 3600, encryptedConnStr);
      }

      req.tenantDb = await TenantDbManager.getConnection(tenantId, encryptedConnStr);
      next();
    } catch (err) {
      next(err);
    }
  },
  controller.deviceNotify
);

/**
 * @swagger
 * /attendance/today:
 *   get:
 *     summary: Today's attendance (shorthand for ?date=today)
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: branchId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Today's check-ins
 */
router.get(
  '/today',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  controller.todayLogs
);

/**
 * @swagger
 * /attendance/range:
 *   get:
 *     summary: Attendance logs for a date range
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: branchId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: userId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated attendance logs in range
 */
router.get(
  '/range',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  controller.rangeLogs
);

/**
 * @swagger
 * /attendance/customer/{userId}:
 *   get:
 *     summary: Full attendance history for a member
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Member attendance history
 */
router.get(
  '/customer/:userId',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  controller.memberHistory
);

/**
 * @swagger
 * /attendance/report/{period}:
 *   get:
 *     summary: Aggregated attendance report
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: period
 *         required: true
 *         schema:
 *           type: string
 *           enum: [daily, weekly, monthly, yearly]
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         schema: { type: integer }
 *         description: Required for daily period
 *       - in: query
 *         name: branchId
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Aggregated check-in counts by period
 */
router.get(
  '/report/:period',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  controller.report
);

// Alias: GET /attendance/report?period=xxx (CMS sends period as query param)
router.get(
  '/report',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  (req, _res, next) => { req.params.period = req.query.period; next(); },
  controller.report
);

// Alias: POST /attendance/check-in (CMS uses check-in instead of manual)
router.post(
  '/check-in',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  validate(validators.manual),
  controller.manual
);

// PATCH /attendance/:id/check-out
router.patch(
  '/:id/check-out',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  controller.checkOut
);

module.exports = router;

