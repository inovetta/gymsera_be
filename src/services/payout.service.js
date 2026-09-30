/**
 * Payout Service (PAY-10, SEC-13, spec §6.3, §12)
 *
 * Core principles:
 * - Balance is dynamically computed from the ledger (payments - reversals - expenses - payouts),
 *   never a mutable stored balance field.
 * - Integer minor units math throughout (zero floating point drift).
 * - Payout account updates require re-auth, owner notification, and a 24-hour cooling period.
 * - Payout request goes through approval engine (DIRECT for owner, REQUEST for manager, OFF for others).
 */
const { Op } = require('sequelize');
const { toMinorUnits, fromMinorUnits } = require('../utils/money.utils');
const { createError } = require('../utils/response.utils');
const { Tenant, User } = require('../models/platform');

const COOLING_PERIOD_HOURS = 24;
const COOLING_PERIOD_MS = COOLING_PERIOD_HOURS * 60 * 60 * 1000;

/**
 * Derives available payout balance dynamically from the ledger.
 *
 * @param {object} tenantDb
 * @param {string|null} [branchId]
 * @param {object} [options]
 * @param {import('sequelize').Transaction} [options.transaction]
 */
const getPayoutBalance = async (tenantDb, branchId = null, options = {}) => {
  const { Payment, LedgerAdjustment, LedgerDay, Expense, Payout } = tenantDb.models;
  const tx = options.transaction || null;

  // 1. Total completed payments
  const payments = await Payment.findAll({
    where: {
      status: 'COMPLETED',
      ...(branchId ? { branchId } : {}),
    },
    attributes: ['amount'],
    transaction: tx,
  });
  const paymentsMinor = payments.reduce((acc, p) => acc + toMinorUnits(p.amount), 0);

  // 2. Total reversing ledger adjustments (refunds)
  let reversals;
  if (branchId && LedgerDay) {
    reversals = await LedgerAdjustment.findAll({
      where: { type: 'REVERSAL' },
      include: [
        {
          model: LedgerDay,
          as: 'ledgerDay',
          where: { branchId },
          required: true,
          attributes: [],
        },
      ],
      attributes: ['amount'],
      transaction: tx,
    });
  } else {
    reversals = await LedgerAdjustment.findAll({
      where: { type: 'REVERSAL' },
      attributes: ['amount'],
      transaction: tx,
    });
  }
  const refundsMinor = reversals.reduce((acc, r) => acc + Math.abs(toMinorUnits(r.amount)), 0);

  // 3. Total expenses
  const expenses = await Expense.findAll({
    where: {
      ...(branchId ? { branchId } : {}),
    },
    attributes: ['amount'],
    transaction: tx,
  });
  const expensesMinor = expenses.reduce((acc, e) => acc + toMinorUnits(e.amount), 0);

  // 4. Total active/completed payouts
  const payouts = await Payout.findAll({
    where: {
      status: { [Op.in]: ['PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED'] },
      ...(branchId ? { branchId } : {}),
    },
    attributes: ['amount'],
    transaction: tx,
  });
  const payoutsMinor = payouts.reduce((acc, p) => acc + toMinorUnits(p.amount), 0);

  // 5. Available net balance
  const netMinor = paymentsMinor - refundsMinor - expensesMinor - payoutsMinor;
  const availableBalanceMinor = Math.max(0, netMinor);

  return {
    branchId: branchId || null,
    totalCollected: fromMinorUnits(paymentsMinor),
    totalRefunded: fromMinorUnits(refundsMinor),
    totalExpenses: fromMinorUnits(expensesMinor),
    totalPayouts: fromMinorUnits(payoutsMinor),
    availableBalance: fromMinorUnits(availableBalanceMinor),
    currency: 'PKR',
  };
};

/**
 * Check if the tenant's payout destination is currently subject to a cooling period.
 *
 * @param {object} tenant
 * @returns {{ active: boolean, remainingHours?: number }}
 */
const checkCoolingPeriod = (tenant) => {
  if (!tenant || !tenant.paymentDetailsUpdatedAt) {
    return { active: false };
  }

  const updatedTime = new Date(tenant.paymentDetailsUpdatedAt).getTime();
  const elapsedMs = Date.now() - updatedTime;

  if (elapsedMs < COOLING_PERIOD_MS) {
    const remainingMs = COOLING_PERIOD_MS - elapsedMs;
    const remainingHours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));
    return { active: true, remainingHours };
  }

  return { active: false };
};

/**
 * List payouts with pagination.
 */
const listPayouts = async (tenantDb, { branchId = null, limit = 20, offset = 0 } = {}) => {
  const { Payout } = tenantDb.models;
  const where = {};
  if (branchId) where.branchId = branchId;

  const { rows, count } = await Payout.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return { payouts: rows, total: count };
};

module.exports = {
  getPayoutBalance,
  checkCoolingPeriod,
  listPayouts,
  COOLING_PERIOD_HOURS,
};
