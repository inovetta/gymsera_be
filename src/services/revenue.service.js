/**
 * NEW-252: one rule for "revenue" wherever it is shown.
 *
 * A payment counts as collected when it is COMPLETED, or REFUNDED (it was collected; the refund is a
 * separate, later event). Every refund is a REVERSAL ledger adjustment (PAY-07), counted once, at the
 * moment it was recorded, on its ledger day's branch. Net revenue = collected − refunded.
 *
 * Before NEW-252 a full refund turned the payment REFUNDED, so it left the COMPLETED sums of its own
 * month (history changed after the fact) while a partial refund was never deducted at all; the payout
 * balance did both, deducting a full refund twice.
 */
const { Op } = require('sequelize');
const { PaymentStatus } = require('../constants/payment-status');
const { toMinorUnits, fromMinorUnits, toMajorUnitsNumber } = require('../utils/money.utils');

/** Payment statuses whose money was collected (see above). */
const COLLECTED_REVENUE_STATUSES = Object.freeze([PaymentStatus.COMPLETED, PaymentStatus.REFUNDED]);

const _branchWhere = (branchIds) => (Array.isArray(branchIds) ? { branchId: { [Op.in]: branchIds } } : {});

/**
 * REVERSAL rows recorded in `window` (a Sequelize condition on the time, e.g. `{ [Op.gte]: monthStart }`,
 * null = all time) at `branchIds` (null = every branch). With `method`, only refunds of payments made
 * that way. Returns [{ amountMinor (positive), at: Date }].
 */
const refundRows = async (tenantDb, { branchIds = null, window = null, method = null } = {}) => {
  const { LedgerAdjustment, LedgerDay, Payment } = tenantDb.models;
  const rows = await LedgerAdjustment.findAll({
    where: { type: 'REVERSAL', ...(window ? { createdAt: window } : {}) },
    include: [{ model: LedgerDay, as: 'ledgerDay', where: _branchWhere(branchIds), required: true, attributes: [] }],
    attributes: ['amount', 'createdAt', 'relatedPaymentId'],
  });
  let kept = rows;
  if (method) {
    const ids = [...new Set(rows.map((r) => r.relatedPaymentId).filter(Boolean))];
    const matching = ids.length
      ? new Set((await Payment.findAll({ where: { id: ids, method }, attributes: ['id'] })).map((p) => p.id))
      : new Set();
    kept = rows.filter((r) => matching.has(r.relatedPaymentId));
  }
  return kept.map((r) => ({ amountMinor: Math.abs(toMinorUnits(r.amount || 0)), at: r.createdAt }));
};

const refundedMinor = async (tenantDb, opts) =>
  (await refundRows(tenantDb, opts)).reduce((acc, r) => acc + r.amountMinor, 0);

/** Collected minus refunded, in major units (a Number, as the screens already receive). */
const netRevenue = async (tenantDb, { branchIds = null, window = null } = {}) => {
  const { Payment } = tenantDb.models;
  const collected = await Payment.sum('amount', {
    where: { ..._branchWhere(branchIds), status: { [Op.in]: COLLECTED_REVENUE_STATUSES }, ...(window ? { paidAt: window } : {}) },
  });
  const refunded = await refundedMinor(tenantDb, { branchIds, window });
  return toMajorUnitsNumber(toMinorUnits(collected || 0) - refunded);
};

/**
 * Subtract refunds from rows grouped by a key (`DATE(paid_at)` day, or `MONTH(paid_at)`), adding rows
 * for keys that only had refunds. `keyOf(date)` must match the SQL grouping (the connection reads UTC).
 */
const subtractRefunds = (rows, refunds, { keyField, sumField, keyOf }) => {
  const byKey = new Map(rows.map((r) => [String(r[keyField]), { ...r }]));
  for (const ref of refunds) {
    const key = String(keyOf(ref.at));
    const row = byKey.get(key) || { [keyField]: key, [sumField]: '0.00', count: 0 };
    row[sumField] = fromMinorUnits(toMinorUnits(row[sumField] || 0) - ref.amountMinor);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => (String(a[keyField]) < String(b[keyField]) ? -1 : 1));
};

const utcDay = (d) => new Date(d).toISOString().slice(0, 10);

module.exports = { COLLECTED_REVENUE_STATUSES, refundRows, refundedMinor, netRevenue, subtractRefunds, utcDay };
