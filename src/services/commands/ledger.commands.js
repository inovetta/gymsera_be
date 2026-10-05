/**
 * Approvable commands for the Ledger module.
 *
 * `ledger.close` is the only ledger action that goes through the generic
 * approval engine — Owner/Org Admin close directly, a Manager's close becomes a
 * request an Org Admin decides, using the exact same command-execute path either
 * way. `ledger.verify` (adjustments) and the *.view keys are plain permission
 * checks with no direct/request duality, so they're plain REST endpoints in
 * ledger.controller.js instead.
 */
const { register } = require('./index');
const { createError } = require('../../utils/response.utils');

/** Resolve the LedgerDay this payload is about, creating it if this is the first touch. */
const resolveLedgerDay = async (ctx, payload) => {
  const ledgerService = require('../ledger.service');
  const { LedgerDay } = ctx.tenantDb.models;

  if (payload.ledgerDayId) {
    const day = await LedgerDay.findByPk(payload.ledgerDayId);
    if (!day) throw createError('Ledger day not found', 404);
    return day;
  }

  if (!ctx.branchId) throw createError('A branch is required to close a ledger day', 400);
  const businessDate = payload.businessDate || (await ledgerService.todayBusinessDate(ctx.tenantDb, ctx.branchId));
  return ledgerService.getOrCreateLedgerDay(ctx.tenantDb, ctx.branchId, businessDate);
};

register({
  actionKey: 'ledger.close',

  summarize: (payload) => `Close ledger — ${payload.businessDate || 'today'}`,

  validate: async (ctx, payload) => {
    // Re-checked at approval time: between a Manager's request and an Org
    // Admin's decision, someone else may have already closed this exact day,
    // or a late payment may have landed against it — both are still fine to
    // close, the state just needs re-confirming, not assumed from request time.
    const day = await resolveLedgerDay(ctx, payload);
    if (day.status === 'CLOSED') {
      throw createError('This day is already closed', 409);
    }
  },

  execute: async (ctx, payload) => {
    const ledgerService = require('../ledger.service');
    const day = await resolveLedgerDay(ctx, payload);
    return ledgerService.closeDay(ctx, { ledgerDayId: day.id });
  },
});

register({
  actionKey: 'ledger.verify',

  targetType: 'ledger_day',

  summarize: (payload) =>
    `Ledger adjustment — ${payload.type || 'ADJUSTMENT'}${payload.amount != null ? ` (${payload.amount})` : ''}: ${payload.reason || ''}`,

  validate: async (ctx, payload) => {
    if (!payload.reason || !payload.reason.trim()) {
      throw createError('A reason is required for a ledger adjustment', 422);
    }
    const { LedgerDay } = ctx.tenantDb.models;
    const ledgerDayId = payload.ledgerDayId;
    if (!ledgerDayId) throw createError('ledgerDayId is required', 422);

    const ledgerDay = await LedgerDay.findByPk(ledgerDayId);
    if (!ledgerDay) throw createError('Ledger day not found', 404);

    if (ledgerDay.status === 'CLOSED') {
      const err = createError(
        `Ledger day ${ledgerDay.businessDate} is closed. Late adjustments must be posted against an open business day referencing the closed day.`,
        409
      );
      err.code = 'ledger_day_closed';
      throw err;
    }

    const effectiveBranchId = ctx.branchId || payload.branchId;
    if (effectiveBranchId && ledgerDay.branchId !== effectiveBranchId) {
      throw createError('That ledger day does not belong to this branch', 403);
    }
  },

  execute: async (ctx, payload) => {
    const ledgerService = require('../ledger.service');
    return ledgerService.addAdjustment(ctx, payload);
  },
});

