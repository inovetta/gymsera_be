/**
 * Approvable commands for Payouts (PAY-10, SEC-13, spec §6.3, §12).
 */
const { register } = require('./index');
const { createError } = require('../../utils/response.utils');
const { toMinorUnits, fromMinorUnits } = require('../../utils/money.utils');
const { getPayoutBalance, checkCoolingPeriod } = require('../payout.service');
const payoutAccountService = require('../payout-account.service');
const { moneyText, DEFAULT_CURRENCY } = require('../../utils/currency.utils');

const NO_ACCOUNT_MESSAGE =
  'There is no payout account to pay to. The owner adds the bank or wallet details under Payouts first; payouts are paid only to that saved account.';

/** The saved payout account's details, or 409 no_payout_destination (NEW-232, R-98). */
const savedDestinationOrThrow = (account) => {
  const details = account ? account.details : null;
  if (!details || typeof details !== 'object' || Object.keys(details).length === 0) {
    throw createError(NO_ACCOUNT_MESSAGE, 409, 'no_payout_destination');
  }
  return details;
};

register({
  actionKey: 'payouts.request',

  summarize: (p) => {
    const amountStr = p.amount != null ? moneyText(fromMinorUnits(toMinorUnits(p.amount)), p.currency) : '0.00';
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

    // P7b (R-94): the payout account of the branch's organization, else the tenant default.
    // Its SEC-13 cooling period and its details are the ones that count.
    const account = await payoutAccountService.resolveForBranch(ctx.tenantDb, ctx.tenantId, payload.branchId || null);

    const cooling = checkCoolingPeriod(account);
    if (cooling.active) {
      const err = createError(
        `Payout requests are temporarily blocked. Bank payout details were updated within the last 24 hours (${cooling.remainingHours}h remaining in cooling period).`,
        422
      );
      err.code = 'cooling_period_active';
      throw err;
    }

    // NEW-232 (R-98): only the saved payout account; a destination in the payload (a body, or the
    // stored payload of a request waiting for approval) is never read.
    savedDestinationOrThrow(account);

    // Check dynamic ledger balance
    const balance = await getPayoutBalance(ctx.tenantDb, payload.branchId);
    const availableMinor = toMinorUnits(balance.availableBalance);
    if (requestedMinor > availableMinor) {
      const err = createError(
        `Requested payout (${moneyText(fromMinorUnits(requestedMinor), balance.currency)}) exceeds available ledger balance (${moneyText(balance.availableBalance, balance.currency)})`,
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
          `Requested payout exceeds available ledger balance of ${moneyText(balance.availableBalance, balance.currency)}`,
          422
        );
        err.code = 'insufficient_balance';
        throw err;
      }

      const account = await payoutAccountService.resolveForBranch(ctx.tenantDb, ctx.tenantId, payload.branchId || null);
      if (checkCoolingPeriod(account).active) {
        const err = createError('Payout requests are temporarily blocked. Bank payout details were updated within the last 24 hours.', 422);
        err.code = 'cooling_period_active';
        throw err;
      }
      const destination = savedDestinationOrThrow(account);

      const payout = await Payout.create(
        {
          branchId: payload.branchId || null,
          amount: fromMinorUnits(requestedMinor),
          currency: balance.currency || DEFAULT_CURRENCY,
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
