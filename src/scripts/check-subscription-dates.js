/**
 * src/scripts/check-subscription-dates.js
 *
 * Read-only diagnostic script to detect subscriptions affected by historical
 * date calculation defects (FLOW-06):
 *
 * Defect categories detected:
 * 1. FROZEN_PAST_FREEZE_TO:
 *    Subscription has status 'FROZEN', but freezeTo has elapsed in the branch timezone.
 *    (Under pre-FLOW-06 logic, cron had no unfreeze/thaw mechanism).
 *
 * 2. FROZEN_WITHOUT_END_DATE_EXTENSION:
 *    Subscription was frozen (freezeFrom and freezeTo set), but endDate matches the raw
 *    unextended plan duration (or is earlier than plan duration + freeze days).
 *    (Under pre-FLOW-06 logic, freeze() only toggled status and never extended endDate).
 *
 * 3. ACTIVE_PAST_BRANCH_END_DATE:
 *    Subscription has status 'ACTIVE', but endDate < todayInBranchTz.
 *    (Under pre-FLOW-06 logic, cron ran against server UTC/local time rather than branch timezone).
 *
 * 4. STALE_RENEWAL_START:
 *    Subscription was renewed after expiry, but startDate was set to the past endDate
 *    instead of max(now, endDate), stealing active days from the member.
 *
 * Safety & Invariants (Rule 8):
 * - 100% Read-Only: executes `SET SESSION TRANSACTION READ ONLY` on the tenant connection.
 * - Zero writes: never calls UPDATE, INSERT, or DELETE.
 * - Safe to run on staging or production.
 *
 * Usage:
 *   node src/scripts/check-subscription-dates.js [--tenant <tenantIdOrCode>]
 */
require('dotenv').config();
const { Sequelize } = require('sequelize');
const { connect: connectPlatform } = require('../database/platform');
const registerTenantModels = require('../models/tenant');
const { decrypt } = require('../utils/crypto.utils');
const { computeBusinessDate } = require('../services/ledger.service');

/**
 * Normalizes a date-like value to YYYY-MM-DD string.
 * @param {string|Date|null} val
 * @returns {string|null}
 */
function normalizeDateStr(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    return val.slice(0, 10);
  }
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
}

/**
 * Add days to a YYYY-MM-DD string.
 * @param {string} dateStr
 * @param {number} days
 * @returns {string}
 */
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute raw plan end date from start date without freeze extensions.
 * @param {string} startDate
 * @param {number} durationValue
 * @param {string} durationType
 * @returns {string}
 */
function computeRawEndDate(startDate, durationValue = 1, durationType = 'MONTHLY') {
  const d = new Date(startDate + 'T00:00:00Z');
  const val = Number(durationValue) || 1;
  const unit = String(durationType || 'MONTHLY').toUpperCase();

  if (unit === 'DAILY') {
    d.setUTCDate(d.getUTCDate() + val);
  } else if (unit === 'WEEKLY') {
    d.setUTCDate(d.getUTCDate() + val * 7);
  } else if (unit === 'MONTHLY') {
    d.setUTCMonth(d.getUTCMonth() + val);
  } else if (unit === 'QUARTERLY') {
    d.setUTCMonth(d.getUTCMonth() + val * 3);
  } else if (unit === 'YEARLY') {
    d.setUTCFullYear(d.getUTCFullYear() + val);
  } else {
    d.setUTCMonth(d.getUTCMonth() + val);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Inspect one tenant database for subscription date defects.
 *
 * @param {Sequelize} tenantSeq - Connected Sequelize instance
 * @param {object} context - Tenant context { tenantId, gymName, tenantCode }
 * @param {object} [options]
 * @param {boolean} [options.quiet=false]
 * @param {string|Date} [options.todayOverride] - Override current date for deterministic testing
 * @returns {Promise<{
 *   tenantId: string,
 *   gymName: string,
 *   scannedCount: number,
 *   anomaliesCount: number,
 *   anomalies: Array<object>
 * }>}
 */
async function processTenantSubscriptionDatesCheck(tenantSeq, context = {}, options = {}) {
  // Enforce session-level READ ONLY transaction
  await tenantSeq.query('SET SESSION TRANSACTION READ ONLY').catch(() => {});

  const models = tenantSeq.models.MemberSubscription ? tenantSeq.models : registerTenantModels(tenantSeq);
  const { MemberSubscription, Branch, MembershipPlan } = models;

  // 1. Preload branches to determine timezone per branch
  const branches = await Branch.findAll({
    attributes: ['id', 'branchName', 'timezone'],
  });
  const branchMap = new Map();
  for (const b of branches) {
    branchMap.set(b.id, {
      name: b.branchName,
      timezone: b.timezone || 'Asia/Karachi',
    });
  }

  // 2. Preload membership plans for duration comparison
  const plans = await MembershipPlan.findAll({
    attributes: ['id', 'name', 'durationType', 'durationValue'],
  });
  const planMap = new Map();
  for (const p of plans) {
    planMap.set(p.id, {
      name: p.name,
      durationType: p.durationType,
      durationValue: p.durationValue,
    });
  }

  // 3. Scan all subscriptions
  const subscriptions = await MemberSubscription.findAll();
  const anomalies = [];

  const nowBase = options.todayOverride ? new Date(options.todayOverride) : new Date();

  for (const sub of subscriptions) {
    const branchInfo = branchMap.get(sub.branchId) || { name: 'Unknown Branch', timezone: 'Asia/Karachi' };
    const tz = branchInfo.timezone;
    const todayInBranchTz = computeBusinessDate(nowBase, tz);

    const startDateStr = normalizeDateStr(sub.startDate);
    const endDateStr = normalizeDateStr(sub.endDate);
    const freezeFromStr = normalizeDateStr(sub.freezeFrom);
    const freezeToStr = normalizeDateStr(sub.freezeTo);
    const subscribedAtDateStr = normalizeDateStr(sub.subscribedAt || sub.createdAt);

    // Defect 1: FROZEN_PAST_FREEZE_TO
    // Subscription is marked FROZEN, but freezeTo has passed in branch timezone
    if (sub.status === 'FROZEN' && freezeToStr && freezeToStr < todayInBranchTz) {
      anomalies.push({
        subscriptionId: sub.id,
        userId: sub.userId,
        branchId: sub.branchId,
        branchTimezone: tz,
        status: sub.status,
        startDate: startDateStr,
        endDate: endDateStr,
        freezeFrom: freezeFromStr,
        freezeTo: freezeToStr,
        issueType: 'FROZEN_PAST_FREEZE_TO',
        details: `Subscription is marked FROZEN, but freeze ended on ${freezeToStr} (today in ${tz} is ${todayInBranchTz}). Needs thaw/unfreeze.`,
        recommendedAction: endDateStr < todayInBranchTz ? 'TRANSITION_TO_EXPIRED' : 'TRANSITION_TO_ACTIVE',
      });
    }

    // Defect 2: FROZEN_WITHOUT_END_DATE_EXTENSION
    // Subscription was frozen, but endDate was never extended by the frozen days.
    if (freezeFromStr && freezeToStr && sub.membershipPlanId && planMap.has(sub.membershipPlanId)) {
      const plan = planMap.get(sub.membershipPlanId);
      const rawEndDate = computeRawEndDate(startDateStr, plan.durationValue, plan.durationType);
      const freezeDays = Math.max(1, Math.round((new Date(freezeToStr + 'T00:00:00Z') - new Date(freezeFromStr + 'T00:00:00Z')) / 86400000));
      const expectedEndDate = addDays(rawEndDate, freezeDays);

      // If stored endDate is identical to raw unextended endDate (or strictly less than expectedEndDate)
      if (endDateStr <= rawEndDate) {
        anomalies.push({
          subscriptionId: sub.id,
          userId: sub.userId,
          branchId: sub.branchId,
          branchTimezone: tz,
          status: sub.status,
          startDate: startDateStr,
          endDate: endDateStr,
          freezeFrom: freezeFromStr,
          freezeTo: freezeToStr,
          issueType: 'FROZEN_WITHOUT_END_DATE_EXTENSION',
          details: `Frozen from ${freezeFromStr} to ${freezeToStr} (${freezeDays} days), but endDate (${endDateStr}) was not extended. Expected: ${expectedEndDate}.`,
          recommendedAction: `EXTEND_END_DATE_BY_${freezeDays}_DAYS`,
        });
      }
    }

    // Defect 3: ACTIVE_PAST_BRANCH_END_DATE
    // Subscription is marked ACTIVE, but its endDate is strictly before today in the branch timezone.
    if (sub.status === 'ACTIVE' && endDateStr < todayInBranchTz) {
      anomalies.push({
        subscriptionId: sub.id,
        userId: sub.userId,
        branchId: sub.branchId,
        branchTimezone: tz,
        status: sub.status,
        startDate: startDateStr,
        endDate: endDateStr,
        freezeFrom: freezeFromStr,
        freezeTo: freezeToStr,
        issueType: 'ACTIVE_PAST_BRANCH_END_DATE',
        details: `Active subscription has endDate ${endDateStr} which is before today (${todayInBranchTz}) in ${tz}.`,
        recommendedAction: 'TRANSITION_TO_EXPIRED',
      });
    }

    // Defect 4: STALE_RENEWAL_START
    // If a subscription renewed from an expired date, subscribedAt is significantly ahead of startDate
    if (subscribedAtDateStr && startDateStr) {
      const subscribedAtD = new Date(subscribedAtDateStr + 'T00:00:00Z');
      const startD = new Date(startDateStr + 'T00:00:00Z');
      const diffDays = Math.round((subscribedAtD - startD) / 86400000);
      // If purchase was made > 5 days after recorded startDate, it likely carried over a stale expired date
      if (diffDays >= 5) {
        anomalies.push({
          subscriptionId: sub.id,
          userId: sub.userId,
          branchId: sub.branchId,
          branchTimezone: tz,
          status: sub.status,
          startDate: startDateStr,
          endDate: endDateStr,
          freezeFrom: freezeFromStr,
          freezeTo: freezeToStr,
          issueType: 'STALE_RENEWAL_START',
          details: `Subscribed on ${subscribedAtDateStr} but startDate was set retroactively to ${startDateStr} (${diffDays} days in past).`,
          recommendedAction: 'AUDIT_HISTORICAL_RENEWAL',
        });
      }
    }
  }

  if (!options.quiet) {
    console.log(`[${context.gymName || context.tenantId || 'Tenant'}] Scanned: ${subscriptions.length} subscriptions, Found: ${anomalies.length} anomaly(ies).`);
  }

  return {
    tenantId: context.tenantId || 'unknown',
    gymName: context.gymName || 'unknown',
    scannedCount: subscriptions.length,
    anomaliesCount: anomalies.length,
    anomalies,
  };
}

/**
 * Scan all active tenant databases for subscription date defects.
 *
 * @param {object} [options]
 * @param {string} [options.tenantFilter]
 * @param {boolean} [options.quiet=false]
 * @param {string|Date} [options.todayOverride]
 * @returns {Promise<object>}
 */
async function checkAllTenantsSubscriptionDates(options = {}) {
  const { Tenant } = require('../models/platform');

  const whereClause = { status: 'ACTIVE' };
  const allTenants = await Tenant.findAll({ where: whereClause });

  let activeTenants = allTenants.filter((t) => t.connectionStringEncrypted);
  if (options.tenantFilter) {
    activeTenants = activeTenants.filter(
      (t) => t.id === options.tenantFilter || t.tenantCode?.toLowerCase() === options.tenantFilter.toLowerCase()
    );
  }

  console.log(`\n============================================================`);
  console.log(`  FLOW-06 SUBSCRIPTION DATES AUDIT (READ ONLY)              `);
  console.log(`============================================================`);
  console.log(`Found ${activeTenants.length} active tenant database(s) to inspect.\n`);

  let totalScanned = 0;
  let totalAnomalies = 0;
  const reports = [];

  for (const tenant of activeTenants) {
    let tenantSeq = null;
    try {
      const connUrl = decrypt(tenant.connectionStringEncrypted);
      tenantSeq = new Sequelize(connUrl, {
        dialect: 'mysql',
        logging: false,
        pool: { max: 2, min: 0, acquire: 20000, idle: 10000 },
        dialectOptions: { connectTimeout: 15000 },
      });

      await tenantSeq.authenticate();

      const result = await processTenantSubscriptionDatesCheck(
        tenantSeq,
        {
          tenantId: tenant.id,
          gymName: tenant.gymName,
          tenantCode: tenant.tenantCode,
        },
        options
      );

      reports.push({ ...result, success: true });
      totalScanned += result.scannedCount;
      totalAnomalies += result.anomaliesCount;
    } catch (err) {
      console.error(`❌ [Tenant Error] ${tenant.gymName || tenant.tenantCode} (${tenant.id}):`, err.message);
      reports.push({
        tenantId: tenant.id,
        gymName: tenant.gymName,
        success: false,
        error: err.message,
      });
    } finally {
      if (tenantSeq) {
        await tenantSeq.close().catch(() => {});
      }
    }
  }

  console.log('\n============================================================');
  console.log(`                   SUMMARY REPORT                           `);
  console.log('============================================================');
  console.log(`Tenants Scanned:               ${activeTenants.length}`);
  console.log(`Total Subscriptions Scanned:   ${totalScanned}`);
  console.log(`Total Anomalies Detected:      ${totalAnomalies}`);
  console.log('============================================================\n');

  return {
    totalTenants: activeTenants.length,
    totalScanned,
    totalAnomalies,
    reports,
  };
}

// ── CLI Execution Guard ──────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  let tenantFilter = null;
  const tenantIdx = args.indexOf('--tenant');
  if (tenantIdx !== -1 && args[tenantIdx + 1]) {
    tenantFilter = args[tenantIdx + 1];
  }

  (async () => {
    try {
      await connectPlatform();
      await checkAllTenantsSubscriptionDates({ tenantFilter });
      process.exit(0);
    } catch (err) {
      console.error('Fatal subscription dates check error:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  processTenantSubscriptionDatesCheck,
  checkAllTenantsSubscriptionDates,
  computeRawEndDate,
  normalizeDateStr,
};
