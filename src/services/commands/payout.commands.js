/**
 * Approvable commands for Payouts (PAY-10, SEC-13, spec §6.3, §12).
 */
const { register } = require('./index');
const { createError } = require('../../utils/response.utils');
const { toMinorUnits, fromMinorUnits } = require('../../utils/money.utils');
const { getPayoutBalance, checkCoolingPeriod } = require('../payout.service');
const { Tenant } = require('../../models/platform');

register({
  actionKey: 'payouts.request',

  summarize: (p) => {
    const amountStr = p.amount != null ? `Rs ${fromMinorUnits(toMinorUnits(p.amount))}` : '0.00';
    return `Request payout: ${amountStr}${p.notes ? ` — ${p.notes}` : ''}`;
  },

  validate: async (ctx, payload) => {
    if (!payload || payload.amount == null) {
      throw createError('Payout amount is required', 400);
    }

    const requestedMinor = toMinorUnits(payload.amount);
    if (requestedMinor <= 0) {
      const err = createError('Payout amount must be strictly greater than zero', 422);
      err.code = 'invalid_amount';
      throw err;
    }

    // Check cooling period & payout destination on platform Tenant
    const tenant = await Tenant.findByPk(ctx.tenantId, {
      attributes: ['id', 'paymentDetailsJson', 'paymentDetailsUpdatedAt'],
    });
    if (!tenant) {
      throw createError('Tenant not found', 404);
    }

    const cooling = checkCoolingPeriod(tenant);
    if (cooling.active) {
      const err = createError(
        `Payout requests are temporarily blocked. Bank payout details were updated within the last 24 hours (${cooling.remainingHours}h remaining in cooling period).`,
        422
      );
      err.code = 'cooling_period_active';
      throw err;
    }

    const destination = payload.destinationJson || tenant.paymentDetailsJson;
    if (!destination || (typeof destination === 'object' && Object.keys(destination).length === 0)) {
      const err = createError('No payout account configured. Set up bank payout details before requesting a payout.', 422);
      err.code = 'no_payout_destination';
      throw err;
    }

    // Check dynamic ledger balance
    const balance = await getPayoutBalance(ctx.tenantDb, payload.branchId);
    const availableMinor = toMinorUnits(balance.availableBalance);
    if (requestedMinor > availableMinor) {
      const err = createError(
        `Requested payout (Rs ${fromMinorUnits(requestedMinor)}) exceeds available ledger balance (Rs ${balance.availableBalance})`,
        422
      );
      err.code = 'insufficient_balance';
      throw err;
    }
  },

  execute: async (ctx, payload) => {
    const { Payout } = ctx.tenantDb.models;
    const requestedMinor = toMinorUnits(payload.amount);

    return ctx.tenantDb.sequelize.transaction(async (tx) => {
      // Idempotency check: if a payout with this key was already created, return it
      if (payload.idempotencyKey) {
        const existing = await Payout.findOne({
          where: { idempotencyKey: payload.idempotencyKey },
          transaction: tx,
        });
        if (existing) {
          return existing.toJSON();
        }
      }

      // Re-verify balance inside transaction
      const balance = await getPayoutBalance(ctx.tenantDb, payload.branchId, { transaction: tx });
      const availableMinor = toMinorUnits(balance.availableBalance);
      if (requestedMinor > availableMinor) {
        const err = createError(
          `Requested payout exceeds available ledger balance of Rs ${balance.availableBalance}`,
          422
        );
        err.code = 'insufficient_balance';
        throw err;
      }

      const tenant = await Tenant.findByPk(ctx.tenantId, {
        attributes: ['id', 'paymentDetailsJson'],
      });

      const destination = payload.destinationJson || (tenant ? tenant.paymentDetailsJson : null);

      const payout = await Payout.create(
        {
          branchId: payload.branchId || null,
          amount: fromMinorUnits(requestedMinor),
          currency: payload.currency || 'PKR',
          status: 'PENDING',
          destinationJson: destination,
          notes: payload.notes || null,
          idempotencyKey: payload.idempotencyKey || null,
          requestedBy: ctx.requestedBy || ctx.userId,
        },
        { transaction: tx }
      );

      return payout.toJSON();
    });
  },
});
