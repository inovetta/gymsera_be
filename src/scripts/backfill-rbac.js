#!/usr/bin/env node
/**
 * Backfill script — migrates the existing gym_staff rows onto role_assignments.
 *
 * Steps 0 and 1 of the migration plan, and safe to run repeatedly: every write is
 * an upsert keyed on data that already exists, so a second run is a no-op rather
 * than a duplicate.
 *
 * Nothing is deleted. gym_staff stays exactly as it is, so the old screens keep
 * working while the new ones roll out behind a flag.
 *
 *   node src/scripts/backfill-rbac.js            # all active tenants
 *   node src/scripts/backfill-rbac.js --dry-run  # report only, write nothing
 *   node src/scripts/backfill-rbac.js --tenant <uuid>
 */
require('dotenv').config();

const { Op } = require('sequelize');
const TenantDbManager = require('../database/TenantDbManager');
const { ensureAccessControlTables } = require('../database/rbac-migration');
const membershipService = require('../services/membership.service');
const { getRoleLevel } = require('../constants/roles');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY_TENANT = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : null;

/**
 * Map a legacy `designation` string onto a role key.
 *
 * The old system had one role wearing two labels: the Add Admin screen sent
 * designation 'Admin' to the same endpoint as Add Staff, and both resolved to
 * BRANCH_MANAGER at runtime. This mapping preserves the *intent* the host
 * expressed when they chose a screen, which is the only signal available.
 */
const roleKeyForDesignation = (designation) => {
  const d = String(designation || '').toLowerCase().trim();
  if (!d) return 'DESK';
  if (d.includes('owner')) return 'ORG_ADMIN';
  if (d.includes('manager')) return 'MANAGER';
  if (d.includes('admin')) return 'BR_ADMIN';
  if (d.includes('trainer') || d.includes('coach')) return 'TRAINER';
  if (d.includes('clean') || d.includes('maintenance') || d.includes('support')) return 'SUPPORT';
  return 'DESK';
};

/** gym_staff status pair → assignment status. */
const statusFor = (staff) => {
  if (staff.employmentStatus === 'TERMINATED') return 'REVOKED';
  if (staff.employmentStatus === 'INACTIVE') return 'SUSPENDED';
  if (staff.status === 'declined') return 'REVOKED';
  if (staff.status === 'pending') return 'INVITED';
  return 'ACTIVE';
};

/**
 * Ensure the platform-side table and columns exist.
 *
 * Additive DDL only — no existing column is altered or dropped.
 */
const migratePlatform = async () => {
  const { sequelize } = require('../database/platform');

  const statements = [
    `CREATE TABLE IF NOT EXISTS user_org_index (
       user_id      CHAR(36)    NOT NULL,
       tenant_id    CHAR(36)    NOT NULL,
       role_key     VARCHAR(40) NOT NULL,
       role_level   SMALLINT    NOT NULL DEFAULT 0,
       scope_type   ENUM('ORG','BRANCH') NOT NULL DEFAULT 'BRANCH',
       branch_count INT         NOT NULL DEFAULT 0,
       status       ENUM('INVITED','ACTIVE','SUSPENDED','REVOKED') NOT NULL DEFAULT 'INVITED',
       created_at   DATETIME    NOT NULL,
       updated_at   DATETIME    NOT NULL,
       PRIMARY KEY (user_id, tenant_id),
       KEY uoi_user_status (user_id, status),
       KEY uoi_tenant_status (tenant_id, status)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const sql of statements) {
    if (DRY_RUN) { console.log('  [dry-run] would run:', sql.split('\n')[0].trim()); continue; }
    await sequelize.query(sql);
  }

  // permission_version columns — guarded, because ADD COLUMN is not idempotent.
  for (const [table, column] of [['users', 'permission_version'], ['tenants', 'permission_version']]) {
    const [rows] = await sequelize.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`
    );
    if (Number(rows[0].n) > 0) continue;
    if (DRY_RUN) { console.log(`  [dry-run] would add ${table}.${column}`); continue; }
    await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${column} INT NOT NULL DEFAULT 1`);
    console.log(`  added ${table}.${column}`);
  }

  console.log('  platform schema ready');
};

/**
 * Backfill one tenant.
 * @returns {Promise<{created: number, skipped: number, users: number}>}
 */
const migrateTenant = async (tenant) => {
  const stats = { created: 0, skipped: 0, users: 0, branchLinks: 0 };

  const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  await ensureAccessControlTables(tenantDb.sequelize, tenant.id);

  const { GymStaff, RoleAssignment, RoleAssignmentBranch } = tenantDb.models;
  const staffRows = await GymStaff.findAll();

  // One person may hold several gym_staff rows — one per branch. They become a
  // single assignment covering several branches, which is what the old data
  // actually meant.
  const byPerson = new Map();
  for (const staff of staffRows) {
    const key = staff.userId || (staff.email ? staff.email.toLowerCase().trim() : null);
    if (!key) { stats.skipped += 1; continue; }
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(staff);
  }

  for (const [key, rows] of byPerson) {
    const primary = rows[0];
    const userId = rows.find((r) => r.userId)?.userId || null;
    const email = (rows.find((r) => r.email)?.email || '').toLowerCase().trim() || null;

    // Already migrated? Leave it alone — the new table is the source of truth once
    // a row exists there, and re-running must never clobber a host's later edits.
    const existing = await RoleAssignment.findOne({
      where: {
        [Op.or]: [...(userId ? [{ userId }] : []), ...(email ? [{ email }] : [])],
      },
    });
    if (existing) { stats.skipped += 1; continue; }

    // Strongest designation across their rows wins.
    const roleKey = rows
      .map((r) => roleKeyForDesignation(r.designation))
      .reduce((a, b) => (getRoleLevel(b) > getRoleLevel(a) ? b : a));

    const status = rows.some((r) => statusFor(r) === 'ACTIVE')
      ? 'ACTIVE'
      : statusFor(primary);

    const branchIds = [...new Set(rows.map((r) => r.branchId).filter(Boolean))];

    if (DRY_RUN) {
      console.log(
        `    [dry-run] ${email || userId} → ${roleKey} (${status}) across ${branchIds.length} branch(es)`
      );
      stats.created += 1;
      continue;
    }

    const assignment = await RoleAssignment.create({
      userId,
      email,
      roleKey,
      roleLevel: getRoleLevel(roleKey),
      scopeType: 'BRANCH',
      status,
      jobTitle: primary.designation || null,
      acceptedAt: status === 'ACTIVE' ? primary.createdAt || new Date() : null,
      createdAt: primary.createdAt || new Date(),
    });

    if (branchIds.length > 0) {
      await RoleAssignmentBranch.bulkCreate(
        branchIds.map((branchId) => ({ assignmentId: assignment.id, branchId }))
      );
      stats.branchLinks += branchIds.length;
    }

    stats.created += 1;
  }

  if (!DRY_RUN) {
    stats.users = await membershipService.rebuildIndexForTenant(tenant.id, tenantDb);
  }

  return stats;
};

const main = async () => {
  console.log(`\nGymsEra RBAC backfill${DRY_RUN ? ' (DRY RUN — nothing will be written)' : ''}\n`);

  console.log('Platform schema');
  await migratePlatform();

  const { Tenant } = require('../models/platform');
  const where = { status: ['ACTIVE', 'SUSPENDED'] };
  if (ONLY_TENANT) where.id = ONLY_TENANT;

  const tenants = await Tenant.findAll({ where });
  console.log(`\n${tenants.length} tenant(s) to process\n`);

  const totals = { created: 0, skipped: 0, users: 0, branchLinks: 0, failed: 0 };

  for (const tenant of tenants) {
    const label = tenant.tenantCode || tenant.gymName || tenant.id;
    if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') {
      console.log(`  ${label}: skipped — not provisioned`);
      continue;
    }

    try {
      process.stdout.write(`  ${label}: `);
      const stats = await migrateTenant(tenant);
      console.log(
        `${stats.created} assignment(s) created, ${stats.skipped} skipped, ` +
        `${stats.branchLinks} branch link(s), ${stats.users} index row(s)`
      );
      totals.created += stats.created;
      totals.skipped += stats.skipped;
      totals.users += stats.users;
      totals.branchLinks += stats.branchLinks;
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      totals.failed += 1;
    }
  }

  console.log(
    `\nDone. ${totals.created} assignment(s), ${totals.branchLinks} branch link(s), ` +
    `${totals.users} index row(s), ${totals.skipped} already migrated, ${totals.failed} tenant(s) failed.\n`
  );

  if (!DRY_RUN && totals.failed === 0) {
    console.log('gym_staff is untouched. Keep it until the new UI is at 100% for two releases.\n');
  }

  await TenantDbManager.releaseAll().catch(() => {});
  process.exit(totals.failed > 0 ? 1 : 0);
};

main().catch((err) => {
  console.error('\nBackfill failed:', err);
  process.exit(1);
});
