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
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
    },
  });
});

router.get('/debug-sync-db', async (_req, res) => {
  try {
    const { Sequelize } = require('sequelize');
    const { Tenant } = require('../models/platform');
    const registerTenantModels = require('../models/tenant');
    const { decrypt } = require('../utils/crypto.utils');

    const tenants = await Tenant.findAll();
    const results = [];

    for (const tenant of tenants) {
      if (tenant.connectionStringEncrypted !== 'PENDING_PROVISIONING') {
        const connUrl = decrypt(tenant.connectionStringEncrypted);
        const tenantSeq = new Sequelize(connUrl, {
          dialect: 'mysql',
          logging: false,
        });
        try {
          await tenantSeq.authenticate();
          registerTenantModels(tenantSeq);
          await tenantSeq.sync({ force: false, alter: true });
          results.push({ tenant: tenant.tenantCode, status: 'SUCCESS' });
        } catch (err) {
          results.push({ tenant: tenant.tenantCode, status: 'FAILED', error: err.message });
        } finally {
          await tenantSeq.close();
        }
      } else {
        results.push({ tenant: tenant.tenantCode, status: 'PENDING_PROVISIONING' });
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Sprint 2 — Auth ───────────────────────────────────────────────────────────
router.use('/auth', require('./auth.routes'));

// ── Sprint 3 — Platform Core & Tenant Onboarding ────────────────────────────
router.use('/cities',            require('./cities.routes'));
router.use('/platform-packages', require('./platform-packages.routes'));
router.use('/tenants',           require('./tenants.routes'));
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

// ── Sprint 8 — User management & parity ──────────────────────────────────────
router.use('/users', require('./users.routes'));

// ── ZKTeco Biometric Device Management ───────────────────────────────────────
const { adminRouter: devicesAdminRouter, hostRouter: devicesHostRouter } = require('./devices.routes');
router.use('/admin/devices', devicesAdminRouter);
router.use('/devices', devicesHostRouter);

module.exports = router;
