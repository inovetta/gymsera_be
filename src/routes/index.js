const { Router } = require('express');

const router = Router();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: API health check
 *     tags: [System]
 *     security: []
 *     responses:
 *       200:
 *         description: API is running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: GymsEra API is running
 *                 data:
 *                   type: object
 */
router.get('/health', (_req, res) => {
  res.json({
    success: true,
    message: 'GymsEra API is running',
    data: {
      version: '1.1.0',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
    },
  });
});

/**
 * NEW-126: 503 while any tenant database is behind the tenant schema target or could not be
 * read (last startup / scheduled check). Counts only; the tenant codes are in the error log and
 * the TENANT_SCHEMA_BEHIND alert. /health stays a liveness check.
 */
router.get('/health/tenant-schema', (_req, res) => {
  const tenantSchema = require('../services/tenant-schema-health.service').tenantSchemaHealth();
  const ok = tenantSchema.status === 'ok';
  res.status(ok ? 200 : 503).json({
    success: ok,
    message: {
      ok: 'Every tenant database is at the schema target',
      behind: 'One or more tenant databases are behind the schema target or could not be checked',
      unchecked: 'The tenant schema check has not finished yet',
    }[tenantSchema.status],
    data: { tenantSchema },
  });
});

/**
 * Diagnostic endpoint to check WebSocket / Socket.IO runtime status
 */
router.get('/system/socket-status', (_req, res) => {
  let socketModuleInstalled = false;
  let socketIoVersion = null;
  let socketError = null;

  try {
    const pkg = require('socket.io/package.json');
    socketModuleInstalled = true;
    socketIoVersion = pkg.version;
  } catch (err) {
    try {
      require('../socket/socket-bundle');
      socketModuleInstalled = true;
      socketIoVersion = '4.8.3-bundled';
    } catch (_) {
      socketError = err.message;
    }
  }

  const socketGateway = require('../socket');
  const ioInstance = socketGateway.getIO();
  let connectedSockets = 0;
  if (ioInstance && ioInstance.sockets && ioInstance.sockets.sockets) {
    connectedSockets = ioInstance.sockets.sockets.size || 0;
  }

  res.json({
    success: true,
    data: {
      socketModuleInstalled,
      socketIoVersion,
      socketError,
      socketIORunning: !!ioInstance,
      connectedSockets,
      nodeVersion: process.version,
      port: process.env.PORT || 3000,
      timestamp: new Date().toISOString(),
    },
  });
});

/**
 * Diagnostic endpoint to check Firebase Cloud Messaging (FCM) runtime status,
 * configuration, credentials, and registered device tokens.
 */
router.get('/system/fcm-status', async (_req, res) => {
  const pushService = require('../services/push.service');
  const status = pushService.getPushStatus();

  let adminInstalled = false;
  let adminVersion = null;
  try {
    const pkg = require('firebase-admin/package.json');
    adminInstalled = true;
    adminVersion = pkg.version;
  } catch (_) {}

  let deviceTokensCount = 0;
  let sampleTokens = [];
  try {
    const { DeviceToken, User } = require('../models/platform');
    deviceTokensCount = await DeviceToken.count();
    sampleTokens = await DeviceToken.findAll({
      include: [{ model: User, as: 'user', attributes: ['id', 'email', 'fullName', 'role'] }],
      order: [['lastActiveAt', 'DESC']],
      limit: 10,
    });
  } catch (err) {
    sampleTokens = [{ error: err.message }];
  }

  const fs = require('fs');
  const path = require('path');
  const localServiceAccountPath = path.join(process.cwd(), 'firebase-service-account.json');
  const localFileExists = fs.existsSync(localServiceAccountPath);

  res.json({
    success: true,
    data: {
      status,
      adminInstalled,
      adminVersion,
      hasJsonEnv: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim().length > 0,
      hasPathEnv: !!process.env.FIREBASE_SERVICE_ACCOUNT_PATH && process.env.FIREBASE_SERVICE_ACCOUNT_PATH.trim().length > 0,
      localFileExists,
      deviceTokensCount,
      sampleTokens: sampleTokens.map((t) => (t.toJSON ? {
        id: t.id,
        userId: t.userId,
        userEmail: t.user?.email,
        platform: t.platform,
        tokenPreview: t.token ? `${t.token.slice(0, 16)}...${t.token.slice(-8)}` : null,
        lastActiveAt: t.lastActiveAt,
      } : t)),
      timestamp: new Date().toISOString(),
    },
  });
});

// ── Sprint 2 — Auth ───────────────────────────────────────────────────────────
router.use('/auth', require('./auth.routes'));

// ── Sprint 3 — Platform Core & Tenant Onboarding ────────────────────────────
router.use('/cities',            require('./cities.routes'));
router.use('/platform-packages', require('./platform-packages.routes'));
router.use('/tenants',           require('./tenants.routes'));
router.use('/billing',           require('./billing.routes'));
router.use('/admin/billing-plans', require('./billing-plans.routes'));
router.use('/admin',             require('./admin.routes'));

router.use('/gyms',      require('./gyms.routes'));
router.use('/discovery', require('./discovery.routes'));
router.use('/host',      require('./host.routes'));

// ── Sprint 5 — Membership Plans & Subscriptions ───────────────────────────────
router.use('/membership-plans', require('./membership-plans.routes'));
router.use('/subscriptions',    require('./subscriptions.routes'));
router.use('/member',           require('./member.routes'));
router.use('/me',               require('./me.routes'));
router.use('/notifications',    require('./notifications.routes'));

// ── Sprint 6 — Payments, Attendance & Trainers ────────────────────────────────
router.use('/payments',   require('./payments.routes'));
router.use('/invoices',   require('./invoices.routes'));
router.use('/attendance', require('./attendance.routes'));
router.use('/trainers',   require('./trainers.routes'));

// ── Sprint 7 — Reports ────────────────────────────────────────────────────────
router.use('/reports', require('./reports.routes'));

// ── Access control: unified Team & Access + the approval inbox ───────────────
router.use('/team',      require('./team.routes'));
router.use('/approvals', require('./approvals.routes'));
router.use('/actions',   require('./actions.routes'));
router.use('/ledger',    require('./ledger.routes'));

router.use('/users', require('./users.routes'));
router.use('/staff-invites', require('./staff-invites.routes'));
router.use('/staff', require('./staff-actions.routes'));

// ── ZKTeco Biometric Device Management ───────────────────────────────────────
const { adminRouter: devicesAdminRouter, hostRouter: devicesHostRouter } = require('./devices.routes');
router.use('/admin/devices', devicesAdminRouter);
router.use('/devices', devicesHostRouter);

// ── Scheduled job HTTP triggers (Vercel Cron / external scheduler) ──────────
router.use('/cron', require('./cron.routes'));

// ── Meta catalog & client support (spec §4.2) ───────────────────────────────
router.use('/meta', require('./meta.routes'));

module.exports = router;
