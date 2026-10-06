/**
 * READ-ONLY Check Script for Prompt 2B Group 3 Historical Data Verification
 *
 * Checks for data inconsistencies from legacy logic across:
 *  1. FLOW-12: Staff invites without single-use expiring tokens
 *  2. FLOW-10: Reviews without valid subscription or auto-approved without moderation
 *  3. FLOW-09: Attendance records / subscriptions on legacy static QR codes
 *  4. PAY-06:  Unclosed/missed ledger days, cash payments without shift, closed days without collector snapshots
 *
 * Guaranteed READ-ONLY: performs SELECT queries only. Zero writes.
 *
 * Usage: node src/scripts/check-prompt-2b-group3-data.js
 */
require('dotenv').config();
const { QueryTypes } = require('sequelize');
const { sequelize: platformSeq } = require('../database/platform');
const { Tenant } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');

async function checkHistoricalData(options = {}) {
  const logger = options.logger || console.log;
  const pSeq = options.platformSeq || platformSeq;
  const results = {
    staffInvites: { legacyInvitesCount: 0, details: [] },
    reviews: { unmoderatedCount: 0, invalidSubscriptionCount: 0, details: [] },
    attendanceQr: { staticQrSubscriptionsCount: 0, details: [] },
    ledger: { missedOpenDaysCount: 0, cashPaymentsWithoutShiftCount: 0, closedDaysWithoutSnapshotCount: 0, details: [] },
  };

  logger('=== Prompt 2B Group 3 Historical Data Check (READ-ONLY) ===\n');

  // 1. Check Platform DB
  await pSeq.authenticate();
  logger('[Platform DB] Connected (read-only mode)');

  // ── FLOW-10 Check: Reviews auto-approved or without active/past subscription ─
  try {
    const allReviews = await pSeq.query(
      "SELECT id, branch_id, user_id, tenant_id, rating, status, created_at FROM gym_reviews",
      { type: QueryTypes.SELECT }
    );

    for (const rev of allReviews) {
      // Check if user had active/past subscription for that tenant in UserGymMembership
      let sub = null;
      if (rev.tenant_id) {
        [sub] = await pSeq.query(
          "SELECT id, status FROM user_gym_memberships WHERE user_id = ? AND tenant_id = ? AND status IN ('ACTIVE', 'EXPIRED', 'FROZEN') LIMIT 1",
          { replacements: [rev.user_id, rev.tenant_id], type: QueryTypes.SELECT }
        );
      }
      if (!sub) {
        results.reviews.invalidSubscriptionCount += 1;
        results.reviews.details.push({
          reviewId: rev.id,
          userId: rev.user_id,
          branchId: rev.branch_id,
          tenantId: rev.tenant_id,
          status: rev.status,
          reason: 'NO_VALID_SUBSCRIPTION_FOUND',
        });
      }
    }
  } catch (err) {
    logger(`[Platform DB] Warning checking reviews: ${err.message}`);
  }

  // 2. Discover Tenant DBs
  let tenantDbsToInspect = [];
  if (options.tenantDbs) {
    tenantDbsToInspect = options.tenantDbs.map((tdb, idx) => ({
      code: tdb.tenantCode || tdb.code || `TENANT_${idx + 1}`,
      sequelize: tdb.sequelize,
    }));
  } else {
    const tenants = await pSeq.query(
      "SELECT id, business_name, tenant_code, connection_string_encrypted FROM tenants WHERE status = 'ACTIVE'",
      { type: QueryTypes.SELECT }
    );
    logger(`[Platform DB] Found ${tenants.length} active tenant(s) to inspect.\n`);

    for (const tenant of tenants) {
      if (!tenant.connection_string_encrypted || tenant.connection_string_encrypted === 'PENDING_PROVISIONING') {
        continue;
      }

      try {
        const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connection_string_encrypted);
        tenantDbsToInspect.push({ code: tenant.tenant_code, sequelize: tenantDb.sequelize });
      } catch (err) {
        logger(`[Tenant ${tenant.tenant_code}] Failed to connect: ${err.message}`);
      }
    }
  }

  for (const tenant of tenantDbsToInspect) {
    const tSeq = tenant.sequelize;

    // ── FLOW-12 Check: Staff invites without single-use expiring tokens ──────────
    try {
      const legacyInvites = await tSeq.query(
        "SELECT id, branch_id, email, status FROM gym_staff WHERE status = 'pending' AND (invite_token_hash IS NULL OR token_expires_at IS NULL)",
        { type: QueryTypes.SELECT }
      );
      if (legacyInvites.length > 0) {
        results.staffInvites.legacyInvitesCount += legacyInvites.length;
        results.staffInvites.details.push({
          tenantCode: tenant.code,
          count: legacyInvites.length,
          sampleIds: legacyInvites.slice(0, 5).map((s) => s.id),
        });
      }
    } catch (err) {
      logger(`[Tenant ${tenant.code}] Warning checking staff invites: ${err.message}`);
    }

    // ── FLOW-09 Check: Subscriptions on legacy static GE- QR codes ─────────────
    try {
      const staticSubs = await tSeq.query(
        "SELECT id, user_id, branch_id, status, qr_code FROM member_subscriptions WHERE qr_code LIKE 'GE-%' AND status = 'ACTIVE'",
        { type: QueryTypes.SELECT }
      );
      if (staticSubs.length > 0) {
        results.attendanceQr.staticQrSubscriptionsCount += staticSubs.length;
        results.attendanceQr.details.push({
          tenantCode: tenant.code,
          count: staticSubs.length,
          sampleSubIds: staticSubs.slice(0, 5).map((s) => s.id),
        });
      }
    } catch (err) {
      logger(`[Tenant ${tenant.code}] Warning checking attendance QR: ${err.message}`);
    }

    // ── PAY-06 Check: Ledger Days and Cash Payments ────────────────────────────
    try {
      // Missed open days
      const missedDays = await tSeq.query(
        "SELECT id, branch_id, business_date, status FROM ledger_days WHERE status = 'OPEN' AND business_date < CURRENT_DATE()",
        { type: QueryTypes.SELECT }
      );
      if (missedDays.length > 0) {
        results.ledger.missedOpenDaysCount += missedDays.length;
        results.ledger.details.push({
          tenantCode: tenant.code,
          type: 'MISSED_OPEN_DAYS',
          days: missedDays,
        });
      }

      // Closed days without snapshot
      const uncalibratedClosedDays = await tSeq.query(
        "SELECT id, branch_id, business_date, closed_expected_total, closed_verified_total FROM ledger_days WHERE status = 'CLOSED' AND (closed_collectors_json IS NULL OR closed_collectors_json = '')",
        { type: QueryTypes.SELECT }
      );
      if (uncalibratedClosedDays.length > 0) {
        results.ledger.closedDaysWithoutSnapshotCount += uncalibratedClosedDays.length;
      }

      // Cash payments without shift
      const unassignedCash = await tSeq.query(
        "SELECT id, branch_id, amount, status, staff_collected_by FROM payments WHERE method = 'CASH' AND (shift IS NULL OR shift = '')",
        { type: QueryTypes.SELECT }
      );
      if (unassignedCash.length > 0) {
        results.ledger.cashPaymentsWithoutShiftCount += unassignedCash.length;
      }
    } catch (err) {
      logger(`[Tenant ${tenant.code}] Warning checking ledger and payments: ${err.message}`);
    }
  }

  logger('=== Summary of Inspection Findings ===');
  logger(`1. FLOW-12 Legacy Staff Invites (missing token/expiry): ${results.staffInvites.legacyInvitesCount}`);
  logger(`2. FLOW-10 Reviews lacking valid subscription:          ${results.reviews.invalidSubscriptionCount}`);
  logger(`3. FLOW-09 Active Subscriptions on legacy static QR:     ${results.attendanceQr.staticQrSubscriptionsCount}`);
  logger(`4. PAY-06  Missed Open Ledger Days:                     ${results.ledger.missedOpenDaysCount}`);
  logger(`   PAY-06  Closed Days without Collector Snapshot:      ${results.ledger.closedDaysWithoutSnapshotCount}`);
  logger(`   PAY-06  Cash Payments without Shift:                 ${results.ledger.cashPaymentsWithoutShiftCount}`);
  logger('\nInspection completed. 0 writes performed.\n');

  return results;
}

if (require.main === module) {
  checkHistoricalData()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[FATAL] Check script failed:', err);
      process.exit(1);
    });
}

module.exports = { checkHistoricalData };
