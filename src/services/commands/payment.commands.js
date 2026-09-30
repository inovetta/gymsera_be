/**
 * Approvable commands for Payments (PAY-07, spec §6.3, §12).
 */
const { register } = require('./index');
const { createError } = require('../../utils/response.utils');
const { PaymentStatus } = require('../../constants/payment-status');
const { toMinorUnits, fromMinorUnits, toMajorUnitsNumber, sumMinor } = require('../../utils/money.utils');
const { UserGymMembership } = require('../../models/platform');
const ledgerService = require('../ledger.service');

register({
  actionKey: 'payments.refund',

  summarize: (p) => {
    const amountStr = p.amount != null ? `Rs ${fromMinorUnits(toMinorUnits(p.amount))}` : 'full';
    return `Refund payment ${p.paymentId || ''}: ${amountStr}${p.reason ? ` — ${p.reason}` : ''}`;
  },

  validate: async (ctx, payload) => {
    if (!payload || !payload.paymentId) {
      throw createError('A paymentId is required to process a refund', 400);
    }
    const { Payment, LedgerAdjustment } = ctx.tenantDb.models;
    const payment = await Payment.findByPk(payload.paymentId);
    if (!payment) {
      throw createError('Payment not found', 404);
    }

    if (payment.status === PaymentStatus.REFUNDED) {
      const err = createError('Payment has already been fully refunded', 422);
      err.code = 'payment_already_refunded';
      throw err;
    }

    if (payment.status !== PaymentStatus.COMPLETED) {
      const err = createError(`Only completed payments can be refunded (current status: ${payment.status})`, 422);
      err.code = 'payment_not_refundable';
      throw err;
    }

    const existingReversals = await LedgerAdjustment.findAll({
      where: { relatedPaymentId: payment.id, type: 'REVERSAL' },
    });
    const alreadyRefundedMinor = existingReversals.reduce(
      (acc, a) => acc + Math.abs(toMinorUnits(a.amount)),
      0
    );
    const paymentAmountMinor = toMinorUnits(payment.amount);
    const remainingRefundableMinor = Math.max(0, paymentAmountMinor - alreadyRefundedMinor);

    if (remainingRefundableMinor <= 0) {
      const err = createError('Payment has already been fully refunded', 422);
      err.code = 'payment_already_refunded';
      throw err;
    }

    if (payload.amount != null) {
      const requestedRefundMinor = toMinorUnits(payload.amount);
      if (requestedRefundMinor <= 0) {
        const err = createError('Refund amount must be strictly greater than zero', 422);
        err.code = 'invalid_refund_amount';
        throw err;
      }
      if (requestedRefundMinor > remainingRefundableMinor) {
        const err = createError(
          `Refund amount (Rs ${fromMinorUnits(requestedRefundMinor)}) exceeds remaining refundable balance (Rs ${fromMinorUnits(remainingRefundableMinor)})`,
          422
        );
        err.code = 'refund_exceeds_refundable';
        throw err;
      }
    }
  },

  execute: async (ctx, payload) => {
    const { Payment, LedgerAdjustment, MemberSubscription } = ctx.tenantDb.models;

    return ctx.tenantDb.sequelize.transaction(async (tx) => {
      // Row-level lock to prevent concurrent double-refunds
      const payment = await Payment.findByPk(payload.paymentId, {
        transaction: tx,
        lock: tx.LOCK.UPDATE,
      });
      if (!payment) throw createError('Payment not found', 404);

      if (payment.status === PaymentStatus.REFUNDED) {
        const err = createError('Payment has already been fully refunded', 422);
        err.code = 'payment_already_refunded';
        throw err;
      }

      if (payment.status !== PaymentStatus.COMPLETED) {
        const err = createError(`Only completed payments can be refunded (current status: ${payment.status})`, 422);
        err.code = 'payment_not_refundable';
        throw err;
      }

      const existingReversals = await LedgerAdjustment.findAll({
        where: { relatedPaymentId: payment.id, type: 'REVERSAL' },
        transaction: tx,
      });
      const alreadyRefundedMinor = existingReversals.reduce(
        (acc, a) => acc + Math.abs(toMinorUnits(a.amount)),
        0
      );
      const paymentAmountMinor = toMinorUnits(payment.amount);
      const remainingRefundableMinor = Math.max(0, paymentAmountMinor - alreadyRefundedMinor);

      if (remainingRefundableMinor <= 0) {
        const err = createError('Payment has already been fully refunded', 422);
        err.code = 'payment_already_refunded';
        throw err;
      }

      const refundMinor = payload.amount != null ? toMinorUnits(payload.amount) : remainingRefundableMinor;
      if (refundMinor <= 0) {
        const err = createError('Refund amount must be strictly greater than zero', 422);
        err.code = 'invalid_refund_amount';
        throw err;
      }
      if (refundMinor > remainingRefundableMinor) {
        const err = createError(
          `Refund amount exceeds remaining refundable balance of Rs ${fromMinorUnits(remainingRefundableMinor)}`,
          422
        );
        err.code = 'refund_exceeds_refundable';
        throw err;
      }

      const isFullRefund = refundMinor === remainingRefundableMinor;

      // 1. Post reversing entry in LedgerAdjustment to today's open ledger day
      const todayBusinessDate = await ledgerService.todayBusinessDate(ctx.tenantDb, payment.branchId);
      const openDay = await ledgerService.getOrCreateLedgerDay(ctx.tenantDb, payment.branchId, todayBusinessDate);

      const reversalAdjustment = await LedgerAdjustment.create(
        {
          ledgerDayId: openDay.id,
          type: 'REVERSAL',
          relatedPaymentId: payment.id,
          amount: -Math.abs(toMajorUnitsNumber(refundMinor)),
          reason: payload.reason || 'Member payment refund',
          createdBy: ctx.requestedBy || ctx.userId,
        },
        { transaction: tx }
      );

      // 2. Update payment status if full refund, and append audit note
      const refundNote = `Refunded Rs ${fromMinorUnits(refundMinor)}: ${payload.reason || 'Member refund'}`;
      const newNotes = payment.notes ? `${payment.notes}\n${refundNote}` : refundNote;

      const updateData = { notes: newNotes };
      if (isFullRefund) {
        updateData.status = PaymentStatus.REFUNDED;
      }
      await payment.update(updateData, { transaction: tx });

      // 3. Adjust membership if full refund
      if (isFullRefund && payment.paymentFor === 'MEMBERSHIP' && payment.referenceEntityId && MemberSubscription) {
        await MemberSubscription.update(
          { status: 'CANCELLED' },
          { where: { id: payment.referenceEntityId }, transaction: tx }
        );

        tx.afterCommit(async () => {
          await UserGymMembership.update(
            { status: 'CANCELLED' },
            { where: { subscriptionId: payment.referenceEntityId } }
          ).catch((err) => {
            console.warn('[Refund] Failed to sync UserGymMembership cancellation:', err.message);
          });
        });
      }

      return {
        paymentId: payment.id,
        refundedAmount: fromMinorUnits(refundMinor),
        remainingRefundable: fromMinorUnits(remainingRefundableMinor - refundMinor),
        isFullRefund,
        status: isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.COMPLETED,
        adjustmentId: reversalAdjustment.id,
      };
    });
  },
});
