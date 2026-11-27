#!/usr/bin/env node
/**
 * Release 1.1.0 post-migration helper: approve existing ACTIVE test businesses whose
 * `kyc_status` defaulted to `NOT_SUBMITTED` during migration `p038_business_kyc_verification`
 * (since `p038` intentionally performs no backfill, leaving pre-1.1.0 ACTIVE businesses hidden
 * from traveller discovery where `status = 'ACTIVE' AND kyc_status = 'APPROVED'`).
 *
 * Guarantees:
 *   - Dry-run by default (reads only, prints matching rows, modifies 0 rows).
 *   - Pass `--apply` to execute an UPDATE only (zero DELETEs, zero DDL).
 *   - Scoped strictly to `business_listings` rows with `status = 'ACTIVE'` AND `kyc_status = 'NOT_SUBMITTED'`.
 *   - Never prints secrets, passwords, or personal contact fields.
 *
 * Usage:
 *   node tools/release-1-1-approve-existing-test-businesses.js
 *   node tools/release-1-1-approve-existing-test-businesses.js --apply
 *   node tools/release-1-1-approve-existing-test-businesses.js --apply --admin-id <uuid>
 */
require('dotenv').config();
const { QueryTypes } = require('sequelize');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseArgs = (argv = process.argv.slice(2)) => {
  const apply = argv.includes('--apply');
  const help = argv.includes('--help') || argv.includes('-h');
  let adminUserId = null;
  const adminIdx = argv.indexOf('--admin-id');
  if (adminIdx !== -1) {
    const val = argv[adminIdx + 1];
    if (!val || !UUID_RE.test(val)) {
      throw new Error('--admin-id requires a valid UUID');
    }
    adminUserId = val;
  }
  return { apply, help, adminUserId };
};

const run = async ({ sequelize, apply = false, adminUserId = null, log = console.log } = {}) => {
  if (!sequelize) throw new Error('sequelize instance is required');

  const [tableRow] = await sequelize.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    { replacements: ['business_listings'], type: QueryTypes.SELECT }
  );
  if (!tableRow) {
    throw new Error('business_listings table not found — run platform migrations (p033–p038) before this script.');
  }

  const [colRow] = await sequelize.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['business_listings', 'kyc_status'], type: QueryTypes.SELECT }
  );
  if (!colRow) {
    throw new Error('business_listings.kyc_status not found — run platform migration p038_business_kyc_verification first.');
  }

  const candidates = await sequelize.query(
    `SELECT b.id, b.organization_id AS organizationId, b.name, b.status, b.kyc_status AS kycStatus,
            b.primary_branch_id AS primaryBranchId, b.approved_at AS approvedAt,
            o.organization_code AS organizationCode, o.organization_name AS organizationName, o.status AS orgStatus
       FROM business_listings b
       LEFT JOIN organizations o ON o.id = b.organization_id
      WHERE b.status = 'ACTIVE' AND b.kyc_status = 'NOT_SUBMITTED'
      ORDER BY b.created_at ASC, b.id ASC`,
    { type: QueryTypes.SELECT }
  );

  log(`Mode: ${apply ? 'APPLY (UPDATE ONLY)' : 'DRY-RUN (no writes)'}`);
  log(`Matched ACTIVE business_listings with kyc_status = 'NOT_SUBMITTED': ${candidates.length}`);
  for (const row of candidates) {
    log(`  - ${row.id} | ${row.name} | org=${row.organizationCode || row.organizationId} (${row.orgStatus || 'unknown'}) | branch=${row.primaryBranchId || 'none'}`);
  }

  if (!apply) {
    log(candidates.length > 0
      ? `Dry-run complete: 0 rows updated. Re-run with --apply to approve these ${candidates.length} business(es).`
      : 'Dry-run complete: 0 rows need approval.');
    return { mode: 'dry-run', matchedCount: candidates.length, updatedCount: 0, businesses: candidates };
  }

  if (candidates.length === 0) {
    log('Apply complete: 0 rows updated (already approved or none matching).');
    return { mode: 'apply', matchedCount: 0, updatedCount: 0, businesses: [] };
  }

  const now = new Date();
  let updatedCount = 0;

  await sequelize.transaction(async (transaction) => {
    const locked = await sequelize.query(
      `SELECT id FROM business_listings
        WHERE status = 'ACTIVE' AND kyc_status = 'NOT_SUBMITTED'
        FOR UPDATE`,
      { type: QueryTypes.SELECT, transaction }
    );
    const ids = locked.map((r) => r.id);
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(', ');
    const [, meta] = await sequelize.query(
      `UPDATE business_listings
          SET kyc_status = 'APPROVED',
              approved_at = COALESCE(approved_at, ?),
              approved_by = COALESCE(approved_by, ?)
        WHERE id IN (${placeholders})
          AND status = 'ACTIVE'
          AND kyc_status = 'NOT_SUBMITTED'`,
      { replacements: [now, adminUserId, ...ids], transaction }
    );
    updatedCount = Number(meta?.affectedRows ?? meta?.changedRows ?? ids.length);
  });

  log(`Apply complete: ${updatedCount} business_listings row(s) updated to kyc_status = 'APPROVED'.`);
  return { mode: 'apply', matchedCount: candidates.length, updatedCount, businesses: candidates };
};

const main = async () => {
  const { apply, help, adminUserId } = parseArgs();
  if (help) {
    console.log('Usage: node tools/release-1-1-approve-existing-test-businesses.js [--apply] [--admin-id <uuid>]');
    process.exit(0);
  }

  // Authenticate only (never platform.connect(), which runs boot-time ALTERs).
  const { sequelize } = require('../src/models/platform');
  await sequelize.authenticate();
  try {
    await run({ sequelize, apply, adminUserId });
  } finally {
    await sequelize.close().catch(() => {});
  }
  process.exit(0);
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, run };
