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

// ── Sprint 2 — Auth ───────────────────────────────────────────────────────────
router.use('/auth', require('./auth.routes'));

// ── Sprint 3 — Platform Core & Tenant Onboarding ────────────────────────────
router.use('/cities',            require('./cities.routes'));
router.use('/platform-packages', require('./platform-packages.routes'));
router.use('/tenants',           require('./tenants.routes'));
router.use('/admin',             require('./admin.routes'));

// ── Sprint 4 — Gym, Branch & Discovery ───────────────────────────────────────
router.use('/gyms',      require('./gyms.routes'));
router.use('/discovery', require('./discovery.routes'));

// ── Sprint 5 — Membership Plans & Subscriptions ───────────────────────────────
router.use('/membership-plans', require('./membership-plans.routes'));
router.use('/subscriptions',    require('./subscriptions.routes'));
router.use('/me',               require('./me.routes'));

// ── Sprint 6 — Payments, Attendance & Trainers ────────────────────────────────
router.use('/payments',   require('./payments.routes'));
router.use('/invoices',   require('./invoices.routes'));
router.use('/attendance', require('./attendance.routes'));
router.use('/trainers',   require('./trainers.routes'));

// ── Sprint 7 — Reports ────────────────────────────────────────────────────────
router.use('/reports', require('./reports.routes'));

// ── Sprint 8 — User management & parity ──────────────────────────────────────
router.use('/users', require('./users.routes'));

module.exports = router;
