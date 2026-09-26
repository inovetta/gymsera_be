/**
 * Ledger service — the financial reconciliation layer over `payments`.
 *
 * Deliberately holds no copy of "what was collected." A collection *is* a row in
 * `payments`; this service reads that table filtered by branch + business date and
 * layers two things on top that genuinely have no other home:
 *
 *   - LedgerDay        the OPEN/CLOSED state of one branch's one business date
 *   - LedgerAdjustment append-only reconciliation entries against a LedgerDay
 *
 * Weekly and monthly views are the identical query over a wider date range —
 * there is no separate weekly/monthly table to drift out of sync with reality.
 *
 * Business dates are computed once, at payment-creation time, from the branch's
 * own IANA timezone (see computeBusinessDate) — every read here just filters on
 * that stamped column. Nothing in this file recomputes a timezone conversion.
 */
const { Op, fn, col, literal } = require('sequelize');
const { createError } = require('../utils/response.utils');
const { PaymentStatus } = require('../constants/payment-status');
const auditService = require('./audit.service');

// Statuses that represent money genuinely in play for the day — everything a
// reconciler needs to see. FAILED/REFUNDED payments are excluded from every
// ledger total; they never represented a real collection.
const LIVE_STATUSES = [PaymentStatus.PENDING, PaymentStatus.STAFF_COLLECTED, PaymentStatus.COMPLETED];
// Physically collected — cash in hand or a transfer confirmed, whether or not the
// tenant has given it final sign-off yet.
const COLLECTED_STATUSES = [PaymentStatus.STAFF_COLLECTED, PaymentStatus.COMPLETED];

/**
 * The branch-local calendar date for `date`, as 'YYYY-MM-DD'. Zero-dependency —
 * Node's built-in ICU support handles arbitrary IANA timezones correctly,
 * including the day-rollover a naive UTC date would get wrong.
 */
const computeBusinessDate = (date, timezone) => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date instanceof Date ? date : new Date(date));
};

/**
 * Single authority for determining the physical/collection timestamp of a payment.
 *
 * Precedence rule:
 * 1. collectedAt / collected_at is always authoritative when present.
 * 2. If collectedAt is empty:
 *    - For CASH payments (money taken physically at the desk), created_at holds the
 *      actual moment cash entered the drawer; paid_at represents later host verification.
 *      Fallback order: createdAt -> paidAt -> now.
 *    - For ONLINE / BANK_TRANSFER payments (electronic transfers), paid_at holds the
 *      moment funds cleared/settled; created_at was merely order intent creation.
 *      Fallback order: paidAt -> createdAt -> now.
 *
 * Accepts either a Sequelize Payment model instance or a plain DB row object.
 */
const getPaymentCollectionTime = (payment) => {
  if (!payment) return new Date();

  const getVal = (camel, snake) => {
    if (typeof payment.getDataValue === 'function') {
      const v = payment.getDataValue(camel);
      if (v !== undefined && v !== null) return v;
    }
    if (payment[camel] !== undefined && payment[camel] !== null) return payment[camel];
    if (snake && payment[snake] !== undefined && payment[snake] !== null) return payment[snake];
    if (typeof payment.previous === 'function') {
      const p = payment.previous(camel);
      if (p !== undefined && p !== null) return p;
    }
    return null;
  };

  const collectedAt = getVal('collectedAt', 'collected_at');
  if (collectedAt) return collectedAt;

  const rawMethod = getVal('method', 'method');
  const method = typeof rawMethod === 'string' ? rawMethod.trim().toUpperCase() : '';
  const isCash = method === 'CASH';

  const createdAt = getVal('createdAt', 'created_at');
  const paidAt = getVal('paidAt', 'paid_at');

  if (isCash) {
    return createdAt || paidAt || new Date();
  }
  return paidAt || createdAt || new Date();
};

/** Today's business date for a branch, resolving its timezone from the DB. */
const todayBusinessDate = async (tenantDb, branchId) => {
  const { Branch } = tenantDb.models;
  const branch = await Branch.findByPk(branchId, { attributes: ['id', 'timezone'] });
  if (!branch) throw createError('Branch not found', 404);
  return computeBusinessDate(new Date(), branch.timezone);
};

/**
 * Stamp the branch-local business date onto a payload about to become a Payment
 * row. Called from payment.service.js at every point a Payment is created —
 * never computed later, never recomputed on read.
 */
const stampBusinessDate = async (tenantDb, branchId, date = new Date(), options = {}) => {
  if (!branchId) return null;
  const { Branch } = tenantDb.models;
  const branch = await Branch.findByPk(branchId, {
    attributes: ['id', 'timezone'],
    transaction: options?.transaction,
  });
  return computeBusinessDate(date, branch ? branch.timezone : 'Asia/Karachi');
};

/**
 * The LedgerDay row for a branch + business date, creating it OPEN on first
 * touch. Safe under concurrent first-collections of the day: the unique
 * (branch_id, business_date) index makes a losing second INSERT a duplicate-key
 * error, which is caught and re-read as the winner's row.
 */
const getOrCreateLedgerDay = async (tenantDb, branchId, businessDate) => {
  const { LedgerDay } = tenantDb.models;
  const existing = await LedgerDay.findOne({ where: { branchId, businessDate } });
  if (existing) return existing;

  try {
    return await LedgerDay.create({ branchId, businessDate, status: 'OPEN', openedAt: new Date() });
  } catch (err) {
    const retry = await LedgerDay.findOne({ where: { branchId, businessDate } });
    if (retry) return retry;
    throw err;
  }
};

/** Sum + group payments for a branch over a business-date range in one query. */
const _paymentTotals = async (tenantDb, branchId, fromDate, toDate) => {
  const { Payment } = tenantDb.models;
  const where = {
    branchId,
    businessDate: { [Op.between]: [fromDate, toDate] },
    status: { [Op.in]: LIVE_STATUSES },
  };

  const rows = await Payment.findAll({
    where,
    attributes: ['id', 'userId', 'amount', 'method', 'status', 'businessDate', 'staffCollectedBy', 'createdBy', 'paidAt', 'referenceEntityId'],
    order: [['createdAt', 'DESC']],
  });

  const expectedTotal = rows.reduce((s, p) => s + parseFloat(p.amount), 0);
  const collectedTotal = rows
    .filter((p) => COLLECTED_STATUSES.includes(p.status))
    .reduce((s, p) => s + parseFloat(p.amount), 0);
  const verifiedTotal = rows
    .filter((p) => p.status === PaymentStatus.COMPLETED)
    .reduce((s, p) => s + parseFloat(p.amount), 0);
  const pendingTotal = expectedTotal - collectedTotal;

  const byMethod = {};
  for (const p of rows) {
    byMethod[p.method] = (byMethod[p.method] || 0) + parseFloat(p.amount);
  }

  const byCollector = {};
  for (const p of rows) {
    if (!COLLECTED_STATUSES.includes(p.status)) continue;
    const collectorId = p.staffCollectedBy || p.createdBy || 'unknown';
    if (!byCollector[collectorId]) byCollector[collectorId] = { collectorId, total: 0, count: 0 };
    byCollector[collectorId].total += parseFloat(p.amount);
    byCollector[collectorId].count += 1;
  }

  // Names for the collector-wise breakdown — platform users, cross-DB, so a
  // second cheap lookup rather than a join.
  const collectorIds = Object.keys(byCollector).filter((id) => id !== 'unknown');
  if (collectorIds.length > 0) {
    try {
      const { User } = require('../models/platform');
      const users = await User.findAll({ where: { id: collectorIds }, attributes: ['id', 'fullName'] });
      for (const u of users) {
        if (byCollector[u.id]) byCollector[u.id].collectorName = u.fullName;
      }
    } catch (_) { /* names are a display nicety, never worth failing the ledger over */ }
  }

  return {
    payments: rows,
    totals: {
      expected: round2(expectedTotal),
      collected: round2(collectedTotal),
      verified: round2(verifiedTotal),
      pending: round2(pendingTotal),
      variance: round2(collectedTotal - verifiedTotal),
    },
    byMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, round2(v)])),
    byCollector: Object.values(byCollector).map((c) => ({ ...c, total: round2(c.total) })),
  };
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Today's Ledger for a branch: the day's collections, its OPEN/CLOSED state, and
 * any reconciliation adjustments already logged against it.
 */
const getTodayLedger = async (tenantDb, branchId) => {
  const businessDate = await todayBusinessDate(tenantDb, branchId);
  return getDayLedger(tenantDb, branchId, businessDate);
};

/** The full ledger view for one specific business date — today or a past/missed one. */
const getDayLedger = async (tenantDb, branchId, businessDate) => {
  const { LedgerAdjustment } = tenantDb.models;
  const ledgerDay = await getOrCreateLedgerDay(tenantDb, branchId, businessDate);
  const { payments, totals, byMethod, byCollector } = await _paymentTotals(tenantDb, branchId, businessDate, businessDate);
  const adjustments = await LedgerAdjustment.findAll({
    where: { ledgerDayId: ledgerDay.id },
    order: [['createdAt', 'ASC']],
  });

  return {
    ledgerDay,
    businessDate,
    isMissed: ledgerDay.status === 'OPEN' && businessDate < (await todayBusinessDate(tenantDb, branchId)),
    payments,
    totals,
    byMethod,
    byCollector,
    adjustments,
  };
};

/**
 * Every OPEN day for a branch older than today — the reconciliation queue.
 * Never disappears on its own; only an explicit close removes a day from here.
 */
const listOpenDays = async (tenantDb, branchId) => {
  const { LedgerDay } = tenantDb.models;
  const today = await todayBusinessDate(tenantDb, branchId);
  return LedgerDay.findAll({
    where: { branchId, status: 'OPEN', businessDate: { [Op.lt]: today } },
    order: [['businessDate', 'ASC']],
  });
};

/**
 * Weekly or monthly ledger: identical shape to the daily one, aggregated over a
 * wider range and broken down per business date. Nothing here is stored —
 * re-derived from `payments` on every call.
 */
const getRangeLedger = async (tenantDb, branchId, fromDate, toDate) => {
  const { Payment } = tenantDb.models;
  const { totals, byMethod, byCollector } = await _paymentTotals(tenantDb, branchId, fromDate, toDate);

  const perDay = await Payment.findAll({
    where: {
      branchId,
      businessDate: { [Op.between]: [fromDate, toDate] },
      status: { [Op.in]: LIVE_STATUSES },
    },
    attributes: [
      'businessDate',
      [fn('SUM', literal(`CASE WHEN status IN ('${COLLECTED_STATUSES.join("','")}') THEN amount ELSE 0 END`)), 'collected'],
      [fn('SUM', literal(`CASE WHEN status = '${PaymentStatus.COMPLETED}' THEN amount ELSE 0 END`)), 'verified'],
      [fn('SUM', col('amount')), 'expected'],
    ],
    group: ['businessDate'],
    order: [['businessDate', 'ASC']],
    raw: true,
  });

  const { LedgerDay } = tenantDb.models;
  const days = await LedgerDay.findAll({
    where: { branchId, businessDate: { [Op.between]: [fromDate, toDate] } },
    attributes: ['businessDate', 'status'],
    raw: true,
  });
  const statusByDate = Object.fromEntries(days.map((d) => [d.businessDate, d.status]));

  return {
    fromDate,
    toDate,
    totals,
    byMethod,
    byCollector,
    perDay: perDay.map((d) => ({
      businessDate: d.businessDate,
      status: statusByDate[d.businessDate] || 'OPEN',
      expected: round2(parseFloat(d.expected || 0)),
      collected: round2(parseFloat(d.collected || 0)),
      verified: round2(parseFloat(d.verified || 0)),
    })),
  };
};

/** Monday-start week containing `businessDate` (YYYY-MM-DD), as [from, to]. */
const weekRange = (businessDate) => {
  const d = new Date(`${businessDate}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - diffToMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const iso = (x) => x.toISOString().split('T')[0];
  return [iso(monday), iso(sunday)];
};

/** Calendar month containing `businessDate`, as [from, to]. */
const monthRange = (businessDate) => {
  const [y, m] = businessDate.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return [from, to];
};

/**
 * Log a reconciliation adjustment against a ledger day. Never edits a payment or
 * the ledger day's own totals directly — the day's live totals always include
 * whatever's in ledger_adjustments as an addend, computed at read time.
 */
const addAdjustment = async (ctx, { ledgerDayId, type, relatedPaymentId, amount, reason }) => {
  if (!reason || !reason.trim()) throw createError('A reason is required for a ledger adjustment', 400);
  const { LedgerDay, LedgerAdjustment } = ctx.tenantDb.models;

  const ledgerDay = await LedgerDay.findByPk(ledgerDayId);
  if (!ledgerDay) throw createError('Ledger day not found', 404);
  // The permission check upstream resolved grants against ctx.branchId (a
  // client-supplied value) — cross-check it actually matches this day's real
  // branch, the same "never trust the client's branch claim" rule payments and
  // expenses already enforce.
  if (ctx.branchId && ledgerDay.branchId !== ctx.branchId) {
    throw createError('That ledger day does not belong to this branch', 403);
  }

  const adjustment = await LedgerAdjustment.create({
    ledgerDayId,
    type,
    relatedPaymentId: relatedPaymentId || null,
    amount: amount != null ? amount : null,
    reason: reason.trim(),
    createdBy: ctx.userId,
  });

  await auditService.record(ctx, {
    action: 'ledger.adjustment.create',
    branchId: ledgerDay.branchId,
    targetType: 'ledger_day',
    targetId: ledgerDay.id,
    after: auditService.snapshot(adjustment),
  });

  return adjustment;
};

/**
 * Close a business day. Race-safe: the conditional UPDATE only succeeds if the
 * day is still OPEN, exactly the pattern approval.service.js#decide already uses
 * for approval_requests — two people racing to close the same day, only one
 * wins, the other gets a clean 409 instead of a double-closed or corrupted row.
 *
 * Immutable afterward: nothing in this codebase updates a CLOSED LedgerDay.
 */
const closeDay = async (ctx, { ledgerDayId }) => {
  const { LedgerDay } = ctx.tenantDb.models;
  const ledgerDay = await LedgerDay.findByPk(ledgerDayId);
  if (!ledgerDay) throw createError('Ledger day not found', 404);
  if (ledgerDay.status === 'CLOSED') {
    throw createError('This day is already closed', 409);
  }

  const { totals } = await _paymentTotals(ctx.tenantDb, ledgerDay.branchId, ledgerDay.businessDate, ledgerDay.businessDate);

  const [affected] = await LedgerDay.update(
    {
      status: 'CLOSED',
      closedBy: ctx.userId,
      closedAt: new Date(),
      closedExpectedTotal: totals.expected,
      closedVerifiedTotal: totals.verified,
    },
    { where: { id: ledgerDayId, status: 'OPEN' } }
  );
  if (affected === 0) {
    throw createError('This day was just closed by someone else', 409);
  }

  await ledgerDay.reload();

  await auditService.record(ctx, {
    action: 'ledger.close',
    branchId: ledgerDay.branchId,
    targetType: 'ledger_day',
    targetId: ledgerDay.id,
    after: { businessDate: ledgerDay.businessDate, ...totals },
  });

  try {
    const { emitToTenant } = require('../socket');
    emitToTenant(ctx.tenantId, 'ledger_updated', {
      branchId: ledgerDay.branchId,
      businessDate: ledgerDay.businessDate,
      status: 'CLOSED',
    });
  } catch (_) { /* socket layer optional at call sites without an io instance */ }

  return ledgerDay;
};

/**
 * Combine several branches' ledger results (each already shaped by
 * getTodayLedger/getDayLedger/getRangeLedger) into one gym-wide view — the
 * host's "all collections" read. Each input branch result gets `branchId` +
 * `branchName` attached by the caller before it reaches here.
 */
const mergeBranchLedgers = (perBranch, extra = {}) => {
  const totals = { expected: 0, collected: 0, verified: 0, pending: 0, variance: 0 };
  const byMethod = {};
  const byCollector = {};
  const payments = [];

  for (const b of perBranch) {
    for (const k of Object.keys(totals)) totals[k] += b.totals[k] || 0;
    for (const [method, amount] of Object.entries(b.byMethod)) {
      byMethod[method] = (byMethod[method] || 0) + amount;
    }
    for (const c of b.byCollector) {
      if (!byCollector[c.collectorId]) {
        byCollector[c.collectorId] = { collectorId: c.collectorId, collectorName: c.collectorName, total: 0, count: 0 };
      }
      byCollector[c.collectorId].total += c.total;
      byCollector[c.collectorId].count += c.count;
    }
    for (const p of b.payments) {
      const plain = typeof p.get === 'function' ? p.get({ plain: true }) : p;
      payments.push({ ...plain, branchId: b.branchId, branchName: b.branchName });
    }
  }

  payments.sort((a, c) => new Date(c.paidAt || c.businessDate || 0) - new Date(a.paidAt || a.businessDate || 0));

  return {
    ...extra,
    branches: perBranch.map((b) => ({
      branchId: b.branchId,
      branchName: b.branchName,
      businessDate: b.businessDate,
      isMissed: b.isMissed,
      totals: b.totals,
    })),
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round2(v)])),
    byMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, round2(v)])),
    byCollector: Object.values(byCollector).map((c) => ({ ...c, total: round2(c.total) })),
    payments: payments.slice(0, 300),
  };
};

/** Every active branch — the scope of every gym-wide (host) ledger read below. */
const _activeBranches = async (tenantDb) => {
  const { Branch } = tenantDb.models;
  return Branch.findAll({ where: { status: 'ACTIVE' }, attributes: ['id', 'name'] });
};

/**
 * Gym-wide Today's Ledger — every active branch's today, merged. This is what
 * "host sees all collections" means: not one branch filtered in, everything.
 * Each branch still resolves "today" in its own timezone (see
 * computeBusinessDate) before the merge, so a branch that rolled over to a new
 * business date already reflects that.
 */
const getTodayLedgerAllBranches = async (tenantDb) => {
  const branches = await _activeBranches(tenantDb);
  const perBranch = await Promise.all(
    branches.map(async (b) => ({ branchId: b.id, branchName: b.name, ...(await getTodayLedger(tenantDb, b.id)) }))
  );
  return mergeBranchLedgers(perBranch);
};

/** Gym-wide weekly/monthly ledger — identical per-branch reads, merged. */
const getRangeLedgerAllBranches = async (tenantDb, fromDate, toDate) => {
  const branches = await _activeBranches(tenantDb);
  const perBranch = await Promise.all(
    branches.map(async (b) => ({ branchId: b.id, branchName: b.name, ...(await getRangeLedger(tenantDb, b.id, fromDate, toDate)) }))
  );
  return mergeBranchLedgers(perBranch, { fromDate, toDate });
};

/** Gym-wide reconciliation queue — every OPEN day older than today, any branch. */
const listOpenDaysAllBranches = async (tenantDb) => {
  const branches = await _activeBranches(tenantDb);
  const perBranch = await Promise.all(
    branches.map(async (b) => {
      const days = await listOpenDays(tenantDb, b.id);
      return days.map((d) => ({ ...d.get({ plain: true }), branchId: b.id, branchName: b.name }));
    })
  );
  return perBranch.flat().sort((a, c) => (a.businessDate < c.businessDate ? -1 : 1));
};

/** Broadcast used by payment.service.js on every collection/verify/reject. */
const notifyLedgerUpdated = (tenantId, branchId, businessDate) => {
  try {
    const { emitToTenant } = require('../socket');
    emitToTenant(tenantId, 'ledger_updated', { branchId, businessDate, status: 'OPEN' });
  } catch (_) { /* non-fatal — a missed real-time nudge, not a data problem */ }
};

module.exports = {
  computeBusinessDate,
  getPaymentCollectionTime,
  todayBusinessDate,
  stampBusinessDate,
  getOrCreateLedgerDay,
  getTodayLedger,
  getDayLedger,
  getRangeLedger,
  listOpenDays,
  getTodayLedgerAllBranches,
  getRangeLedgerAllBranches,
  listOpenDaysAllBranches,
  weekRange,
  monthRange,
  addAdjustment,
  closeDay,
  notifyLedgerUpdated,
};
