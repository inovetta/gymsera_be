/**
 * src/scripts/repair-payment-business-dates.js
 *
 * Maintenance / repair script for payments whose business_date differs from
 * the canonical collection time rule (Step 2.8: getPaymentCollectionTime + computeBusinessDate).
 *
 * Safety & Invariants:
 * 1. DEFAULT = PREVIEW (read-only). Runs in a READ ONLY transaction and performs zero writes.
 * 2. Only runs mutations when BOTH `--apply` AND `--confirm` flags are provided.
 * 3. Never modifies payments touching a CLOSED ledger day (marked "needs manual adjustment").
 * 4. Only updates payments where BOTH currentDay and correctDay are not CLOSED (open or no ledger day).
 * 5. Uses explicit `allowBusinessDateRepair: true` bypass of the Payment model immutability hook.
 * 6. Appends one audit_logs row per repaired payment with before/after state and action 'payment.business_date.repair'.
 * 7. One atomic database transaction per tenant.
 * 8. Idempotent: running a second time detects 0 mismatches and makes 0 writes.
 *
 * Usage:
 *   # Preview (safe, read-only default):
 *   node src/scripts/repair-payment-business-dates.js
 *
 *   # Apply repairs across all tenants:
 *   node src/scripts/repair-payment-business-dates.js --apply --confirm
 *
 *   # Single tenant (optional):
 *   node src/scripts/repair-payment-business-dates.js --tenant <tenantIdOrCode> [--apply --confirm]
 */
require('dotenv').config();
const { Sequelize } = require('sequelize');
const { connect: connectPlatform } = require('../database/platform');
const registerTenantModels = require('../models/tenant');
const { decrypt } = require('../utils/crypto.utils');
const { getPaymentCollectionTime, computeBusinessDate } = require('../services/ledger.service');

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
 * Process payment business date repair for a single tenant database.
 *
 * @param {Sequelize} tenantSeq - Connected Sequelize instance for the tenant
 * @param {object} context - Tenant context { tenantId, gymName, tenantCode }
 * @param {object} [options]
 * @param {boolean} [options.apply=false] - Whether to apply mutations
 * @param {boolean} [options.quiet=false] - Suppress verbose console logs
 * @returns {Promise<{
 *   tenantId: string,
 *   gymName: string,
 *   totalPayments: number,
 *   mismatches: Array<object>,
 *   repairedCount: number,
 *   skippedClosedCount: number,
 *   eligibleCount: number
 * }>}
 */
async function processTenantPaymentRepair(tenantSeq, context = {}, options = {}) {
  const isApply = options.apply === true;
  const models = tenantSeq.models.Payment ? tenantSeq.models : registerTenantModels(tenantSeq);
  const { Payment, Branch, LedgerDay, AuditLog } = models;

  // 1. Preload branches into a Map to completely avoid cross-table SQL collation join mismatches
  const branchRows = await Branch.findAll({
    attributes: ['id', 'branchName', 'timezone'],
  });
  const branchMap = new Map();
  for (const b of branchRows) {
    branchMap.set(b.id, {
      timezone: b.timezone || 'Asia/Karachi',
      name: b.branchName || 'Unnamed Branch',
    });
  }

  // 2. Fetch all payments in this tenant DB
  const payments = await Payment.findAll({
    order: [['createdAt', 'ASC']],
  });

  const mismatches = [];

  for (const p of payments) {
    const rawBranchId = p.branchId || (p.getDataValue && p.getDataValue('branchId'));
    const branchInfo = branchMap.get(rawBranchId);
    const branchTimezone = branchInfo?.timezone || 'Asia/Karachi';

    const collectionTime = getPaymentCollectionTime(p);
    const correctDay = computeBusinessDate(collectionTime, branchTimezone);
    const currentDay = normalizeDateStr(p.businessDate || (p.getDataValue && p.getDataValue('businessDate')));

    if (currentDay !== correctDay) {
      mismatches.push({
        payment: p,
        paymentId: p.id,
        branchId: rawBranchId,
        branchName: branchInfo?.name || 'Unknown',
        branchTimezone,
        method: p.method,
        status: p.status,
        amount: p.amount,
        currency: p.currency,
        createdAt: p.createdAt,
        paidAt: p.paidAt,
        collectedAt: p.collectedAt,
        currentDay,
        correctDay,
      });
    }
  }

  if (mismatches.length === 0) {
    return {
      tenantId: context.tenantId || 'local',
      gymName: context.gymName || 'Local DB',
      totalPayments: payments.length,
      mismatches: [],
      repairedCount: 0,
      skippedClosedCount: 0,
      eligibleCount: 0,
    };
  }

  // 3. Evaluate ledger status for both days across all mismatched payments
  // A day is CLOSED if and only if a ledger_days row exists with status = 'CLOSED'.
  // Otherwise it is open (or no ledger day).
  const datesToCheck = new Set();
  const branchIds = new Set();
  for (const m of mismatches) {
    if (m.currentDay) datesToCheck.add(m.currentDay);
    if (m.correctDay) datesToCheck.add(m.correctDay);
    if (m.branchId) branchIds.add(m.branchId);
  }

  const ledgerDayRows = datesToCheck.size > 0 && branchIds.size > 0
    ? await LedgerDay.findAll({
        where: {
          branchId: Array.from(branchIds),
          businessDate: Array.from(datesToCheck),
        },
        attributes: ['branchId', 'businessDate', 'status'],
      })
    : [];

  const ledgerStatusMap = new Map();
  for (const row of ledgerDayRows) {
    const bDate = normalizeDateStr(row.businessDate);
    const key = `${row.branchId}:${bDate}`;
    ledgerStatusMap.set(key, row.status); // 'OPEN' or 'CLOSED'
  }

  let eligibleCount = 0;
  let skippedClosedCount = 0;
  let repairedCount = 0;

  for (const m of mismatches) {
    const currentKey = `${m.branchId}:${m.currentDay}`;
    const correctKey = `${m.branchId}:${m.correctDay}`;

    const currentLedgerStatus = ledgerStatusMap.get(currentKey) || 'NO_LEDGER_DAY';
    const correctLedgerStatus = ledgerStatusMap.get(correctKey) || 'NO_LEDGER_DAY';

    const currentIsClosed = currentLedgerStatus === 'CLOSED';
    const correctIsClosed = correctLedgerStatus === 'CLOSED';
    const touchesClosedDay = currentIsClosed || correctIsClosed;

    m.currentLedgerStatus = currentLedgerStatus;
    m.correctLedgerStatus = correctLedgerStatus;
    m.touchesClosedDay = touchesClosedDay;

    if (touchesClosedDay) {
      skippedClosedCount++;
      m.action = 'NEEDS_MANUAL_ADJUSTMENT';
    } else {
      eligibleCount++;
      m.action = 'ELIGIBLE';
    }
  }

  // 4. Execution Mode: PREVIEW (Read-Only Transaction) vs APPLY (Write Transaction)
  if (!isApply) {
    // PREVIEW: Run within a READ ONLY transaction to guarantee zero writes
    const transaction = await tenantSeq.transaction({ readOnly: true });
    try {
      if (!options.quiet) {
        console.log(`\n--- Tenant: ${context.gymName || context.tenantId} (${mismatches.length} mismatch(es)) ---`);
        for (const m of mismatches) {
          console.log(`Payment ID:     ${m.paymentId}`);
          console.log(`  Method:       ${m.method} | Status: ${m.status} | Amount: ${m.amount} ${m.currency}`);
          console.log(`  Created:      ${m.createdAt ? m.createdAt.toISOString() : 'null'}`);
          console.log(`  Paid:         ${m.paidAt ? m.paidAt.toISOString() : 'null'}`);
          console.log(`  Collected:    ${m.collectedAt ? m.collectedAt.toISOString() : 'null'}`);
          console.log(`  Current Day:  ${m.currentDay} (ledger: ${m.currentLedgerStatus})`);
          console.log(`  Correct Day:  ${m.correctDay} (ledger: ${m.correctLedgerStatus})`);
          console.log(`  Verdict:      ${m.touchesClosedDay ? '⚠️  NEEDS MANUAL ADJUSTMENT (touches CLOSED ledger day)' : '✅ ELIGIBLE FOR REPAIR'}`);
          console.log('----------------------------------------------------');
        }
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } else {
    // APPLY: Update eligible payments in a single transaction per tenant
    const transaction = await tenantSeq.transaction();
    try {
      for (const m of mismatches) {
        if (m.touchesClosedDay) {
          if (!options.quiet) {
            console.log(`[SKIP] Payment ${m.paymentId}: touches CLOSED day (${m.currentDay}:${m.currentLedgerStatus} -> ${m.correctDay}:${m.correctLedgerStatus}). Manual adjustment required.`);
          }
          continue;
        }

        const p = m.payment;
        p.businessDate = m.correctDay;

        // Save using the explicit bypass option
        await p.save({
          transaction,
          allowBusinessDateRepair: true,
        });

        // Record audit trail row
        await AuditLog.create(
          {
            branchId: m.branchId,
            actorUserId: null,
            actorRoleKey: 'SYSTEM',
            action: 'payment.business_date.repair',
            targetType: 'payment',
            targetId: m.paymentId,
            beforeState: {
              business_date: m.currentDay,
              collection_time: getPaymentCollectionTime(p).toISOString(),
            },
            afterState: {
              business_date: m.correctDay,
              timezone: m.branchTimezone,
            },
          },
          { transaction }
        );

        repairedCount++;
        if (!options.quiet) {
          console.log(`[REPAIRED] Payment ${m.paymentId}: ${m.currentDay} -> ${m.correctDay} (audited)`);
        }
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  return {
    tenantId: context.tenantId || 'local',
    gymName: context.gymName || 'Local DB',
    totalPayments: payments.length,
    mismatches,
    repairedCount,
    skippedClosedCount,
    eligibleCount,
  };
}

/**
 * Iterate across all active tenant databases to preview or repair payment business dates.
 *
 * @param {object} [options]
 * @param {boolean} [options.apply=false]
 * @param {boolean} [options.confirm=false]
 * @param {string} [options.tenantFilter=null]
 * @param {boolean} [options.quiet=false]
 * @returns {Promise<{
 *   totalTenants: number,
 *   totalScannedPayments: number,
 *   totalMismatches: number,
 *   totalRepaired: number,
 *   totalSkippedClosed: number,
 *   totalEligible: number,
 *   reports: Array<object>
 * }>}
 */
async function repairAllTenantsPaymentBusinessDates(options = {}) {
  const isApply = options.apply === true;
  const isConfirm = options.confirm === true;

  if (isApply && !isConfirm) {
    throw new Error(
      'Safety check failed: --apply requires --confirm flag to execute mutations. Run with: node src/scripts/repair-payment-business-dates.js --apply --confirm'
    );
  }

  const { Tenant } = require('../models/platform');
  const whereClause = {
    status: 'ACTIVE',
    connectionStringEncrypted: { [Sequelize.Op.ne]: null },
  };

  const tenants = await Tenant.findAll({ where: whereClause });
  let activeTenants = tenants.filter(
    (t) => t.connectionStringEncrypted && t.connectionStringEncrypted !== 'PENDING_PROVISIONING'
  );

  if (options.tenantFilter) {
    activeTenants = activeTenants.filter(
      (t) => t.id === options.tenantFilter || t.tenantCode?.toLowerCase() === options.tenantFilter.toLowerCase()
    );
  }

  console.log(`\n============================================================`);
  console.log(`  PAYMENT BUSINESS DATE REPAIR: ${isApply ? '🚀 APPLY MODE (MUTATIONS ACTIVE)' : '🔍 PREVIEW MODE (READ ONLY)'}`);
  console.log(`============================================================`);
  console.log(`Found ${activeTenants.length} active tenant database(s) to inspect.\n`);

  let totalScannedPayments = 0;
  let totalMismatches = 0;
  let totalRepaired = 0;
  let totalSkippedClosed = 0;
  let totalEligible = 0;
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

      const result = await processTenantPaymentRepair(
        tenantSeq,
        {
          tenantId: tenant.id,
          gymName: tenant.gymName,
          tenantCode: tenant.tenantCode,
        },
        {
          apply: isApply,
          quiet: options.quiet,
        }
      );

      reports.push({ ...result, success: true });
      totalScannedPayments += result.totalPayments;
      totalMismatches += result.mismatches.length;
      totalRepaired += result.repairedCount;
      totalSkippedClosed += result.skippedClosedCount;
      totalEligible += result.eligibleCount;
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
  console.log(`Mode:                    ${isApply ? 'APPLY (Committed)' : 'PREVIEW (Zero writes)'}`);
  console.log(`Tenants Scanned:         ${activeTenants.length}`);
  console.log(`Total Payments Checked:  ${totalScannedPayments}`);
  console.log(`Total Mismatches Found:  ${totalMismatches}`);
  console.log(`Eligible for Repair:     ${totalEligible}`);
  console.log(`Needs Manual Adjustment: ${totalSkippedClosed} (touch CLOSED ledger day)`);
  if (isApply) {
    console.log(`Payments Repaired:       ${totalRepaired}`);
  }
  console.log('============================================================\n');

  return {
    totalTenants: activeTenants.length,
    totalScannedPayments,
    totalMismatches,
    totalRepaired,
    totalSkippedClosed,
    totalEligible,
    reports,
  };
}

// ── CLI Execution Guard ──────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const isConfirm = args.includes('--confirm');

  let tenantFilter = null;
  const tenantIdx = args.indexOf('--tenant');
  if (tenantIdx !== -1 && args[tenantIdx + 1]) {
    tenantFilter = args[tenantIdx + 1];
  }

  (async () => {
    try {
      await connectPlatform();
      await repairAllTenantsPaymentBusinessDates({
        apply: isApply,
        confirm: isConfirm,
        tenantFilter,
      });
      process.exit(0);
    } catch (err) {
      console.error('Fatal repair script error:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  processTenantPaymentRepair,
  repairAllTenantsPaymentBusinessDates,
  normalizeDateStr,
};
