const { Router } = require('express');
const controller    = require('../controllers/reports.controller');
const authenticate  = require('../middleware/authenticate');
const authorize     = require('../middleware/authorize');
const tenantContext = require('../middleware/tenantContext');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Reports
 *   description: Dashboard KPIs and platform analytics
 */

/**
 * @swagger
 * /reports/dashboard:
 *   get:
 *     summary: Host dashboard KPIs — members, attendance, revenue, plans
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard KPI summary
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         members:    { type: object }
 *                         attendance: { type: object }
 *                         revenue:    { type: object }
 *                         plans:      { type: object }
 *                         branches:   { type: object }
 */
router.get(
  '/dashboard',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  controller.hostDashboard
);

/**
 * @swagger
 * /reports/monthly:
 *   get:
 *     summary: Detailed daily-granular monthly breakdown (revenue, subscriptions, check-ins)
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *         description: Year (defaults to current year)
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Month (defaults to current month)
 *     responses:
 *       200:
 *         description: Monthly breakdown by day
 */
router.get(
  '/monthly',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  controller.monthlyBreakdown
);

/**
 * @swagger
 * /reports/monthly/export-pdf:
 *   get:
 *     summary: Download monthly report as PDF
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: PDF download
 *         content:
 *           application/pdf: {}
 */
router.get(
  '/monthly/export-pdf',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  controller.monthlyExportPdf
);

/**
 * @swagger
 * /reports/monthly/print-layout:
 *   get:
 *     summary: Get a printable HTML version of the monthly report
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: HTML page for printing
 *         content:
 *           text/html: {}
 */
router.get(
  '/monthly/print-layout',
  authenticate,
  authorize('GYM_HOST', 'BRANCH_MANAGER'),
  tenantContext,
  controller.monthlyPrintLayout
);

// Alias: GET /reports/monthly/export (CMS uses /export, backend has /export-pdf)
router.get('/monthly/export', authenticate, authorize('GYM_HOST', 'BRANCH_MANAGER'), tenantContext, controller.monthlyExportPdf);

router.get('/yearly', authenticate, authorize('GYM_HOST', 'BRANCH_MANAGER'), tenantContext, controller.yearlyRevenue);
router.get('/weekly-attendance', authenticate, authorize('GYM_HOST', 'BRANCH_MANAGER'), tenantContext, controller.weeklyAttendance);

module.exports = router;
