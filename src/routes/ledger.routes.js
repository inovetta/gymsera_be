/**
 * Collection ledger routes.
 *
 * Every read is gated by its own permission (today/weekly/monthly are separate
 * keys — a Branch Admin who can see today's collections doesn't automatically
 * see three months of them). Closing a day goes through the generic
 * `/actions/ledger.close` command instead of a route here — see
 * commands/ledger.commands.js — so a Manager's close request/approval flow is
 * the same engine every other approvable action already uses.
 */
const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const tenantContext = require('../middleware/tenantContext');
const can = require('../middleware/can');
const controller = require('../controllers/ledger.controller');

const router = Router();
router.use(authenticate, tenantContext);

/**
 * @swagger
 * /ledger/today:
 *   get:
 *     summary: Today's Ledger for a branch — collections, OPEN/CLOSED state, adjustments
 *     tags: [Ledger]
 *     parameters:
 *       - { in: query, name: branchId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Today's ledger }
 */
router.get('/today', can('ledger.today.view', { branch: 'query.branchId' }), controller.getToday);

/**
 * @swagger
 * /ledger/open-days:
 *   get:
 *     summary: Every OPEN business day older than today — the reconciliation queue
 *     tags: [Ledger]
 *     parameters:
 *       - { in: query, name: branchId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Open (missed) ledger days }
 */
router.get('/open-days', can('ledger.today.view', { branch: 'query.branchId' }), controller.getOpenDays);

/**
 * @swagger
 * /ledger/day/{businessDate}:
 *   get:
 *     summary: The ledger for one specific business date — how a missed day gets reconciled
 *     tags: [Ledger]
 *     parameters:
 *       - { in: path, name: businessDate, required: true, schema: { type: string, example: '2026-09-01' } }
 *       - { in: query, name: branchId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: One day's ledger }
 */
router.get('/day/:businessDate', can('ledger.today.view', { branch: 'query.branchId' }), controller.getDay);

/**
 * @swagger
 * /ledger/weekly:
 *   get:
 *     summary: Weekly ledger — derived from finalized daily collections, never separately stored
 *     tags: [Ledger]
 *     parameters:
 *       - { in: query, name: branchId, required: true, schema: { type: string } }
 *       - { in: query, name: businessDate, schema: { type: string }, description: Any date inside the target week; defaults to today }
 *     responses:
 *       200: { description: Weekly ledger }
 */
router.get('/weekly', can('ledger.weekly.view', { branch: 'query.branchId' }), controller.getWeekly);

/**
 * @swagger
 * /ledger/monthly:
 *   get:
 *     summary: Monthly ledger — derived, same shape as weekly over a wider range
 *     tags: [Ledger]
 *     parameters:
 *       - { in: query, name: branchId, required: true, schema: { type: string } }
 *       - { in: query, name: businessDate, schema: { type: string }, description: Any date inside the target month; defaults to today }
 *     responses:
 *       200: { description: Monthly ledger }
 */
router.get('/monthly', can('ledger.monthly.view', { branch: 'query.branchId' }), controller.getMonthly);

/**
 * @swagger
 * /ledger/{ledgerDayId}/adjustments:
 *   post:
 *     summary: Log a reconciliation adjustment against a ledger day (discrepancy note, variance, reversal)
 *     description: >
 *       Append-only — never edits a payment or the ledger day's own totals.
 *       A day's live totals always include whatever's logged here as an addend.
 *     tags: [Ledger]
 *     parameters:
 *       - { in: path, name: ledgerDayId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [branchId, type, reason]
 *             properties:
 *               branchId:        { type: string }
 *               type:            { type: string, enum: [DISCREPANCY_NOTE, VARIANCE_ADJUSTMENT, REVERSAL, MISSED_DAY_RECONCILIATION] }
 *               relatedPaymentId: { type: string }
 *               amount:          { type: number }
 *               reason:          { type: string }
 *     responses:
 *       201: { description: Adjustment recorded }
 */
router.post(
  '/:ledgerDayId/adjustments',
  can('ledger.verify', { branch: 'body.branchId' }),
  controller.createAdjustment
);

module.exports = router;
