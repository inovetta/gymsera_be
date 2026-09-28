-- Prompt 1C — READ-ONLY checks before running platform migration p007
-- and tenant migrations 008–010. Every statement is a SELECT: nothing is changed.
--
-- Deployment execution order:
-- 1. Run Section 1 against the PLATFORM database (gymsera)
--    Then: node src/scripts/run-platform-migrations.js --dry-run
--          node src/scripts/run-platform-migrations.js
-- 2. Run Section 2 against each TENANT database
--    Then: node src/scripts/run-tenant-migrations.js --dry-run
--          node src/scripts/run-tenant-migrations.js

-- ============================================================================
-- SECTION 1: PLATFORM DATABASE CHECKS (run against `gymsera` platform DB)
-- ============================================================================

-- 0. MySQL version. Needs MySQL 5.7.8 or later (JSON column support, utf8mb4).
SELECT VERSION() AS mysql_version;

-- 1. Which platform migrations are already applied.
--    Expected: migrations 1..6 applied (p001 through p006). p007 not yet applied.
SELECT version, name, applied_at FROM schema_migrations ORDER BY version;

-- 2. Check 4: Platform migration p007 (widen capacity_events.action ENUM).
--    Current column definition on platform DB:
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capacity_events' AND COLUMN_NAME = 'action';

--    Current action values in use in capacity_events.
--    Expected: only values known before p007 (BRANCH_DELETED, BRANCH_RESTORED,
--    SLOT_TRANSFERRED, SLOT_TRIMMED_DOWNGRADE, SLOT_ATTRIBUTED_UPGRADE,
--    SLOT_CONSUMED_BUILD, ORG_DELETED, ORG_BRANCHES_MOVED).
--    No unknown values, or p007 will SKIP itself.
SELECT action, COUNT(*) AS n
FROM capacity_events
GROUP BY action
ORDER BY action;

--    Table size for capacity_events (online ALTER timing baseline).
SELECT COUNT(*) AS rows_in_capacity_events FROM capacity_events;


-- ============================================================================
-- SECTION 2: TENANT DATABASE CHECKS (run against each tenant database)
-- ============================================================================

-- 3. Tenant schema version (schema_migrations table on tenant DB).
--    Expected: versions 1..7 applied (up to 007_align_all_tables_collation).
--    Versions 8, 9, 10 not yet applied.
SELECT version, name, applied_at FROM schema_migrations ORDER BY version;

-- 4. Check 1: Tenant migration 008 (admin_suspended columns on branches).
--    Expected: 0 rows (columns not yet added). If any exist with non-matching types,
--    investigate before migrating.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches'
  AND COLUMN_NAME IN ('admin_suspended', 'admin_suspended_reason', 'admin_suspended_at', 'admin_suspended_by');

-- 5. Check 2: Tenant migration 009 (capacity_outbox table).
--    Expected: 0 rows (table does not exist yet).
SELECT TABLE_NAME, TABLE_ROWS, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capacity_outbox';

-- 6. Check 3: Tenant migration 010 (billing_locked_at columns on branches).
--    Expected: 0 rows (columns not yet added).
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches'
  AND COLUMN_NAME IN ('billing_locked_at', 'billing_lock_reason');

-- 7. Check (c): Pre-existing column conflict check on branches table.
--    Expected: Error "Unknown column 'admin_suspended'" on a fresh database (safe to migrate),
--    OR if the column was pre-created out-of-band, the count must be exactly 0.
--    A count > 0 indicates a schema conflict where admin_suspended already holds data.
SELECT COUNT(*) AS active_branches_with_admin_suspended
FROM branches
WHERE status = 'ACTIVE' AND admin_suspended IS NOT NULL;

-- 8. Table size for branches (online ALTER timing baseline).
SELECT COUNT(*) AS rows_in_branches FROM branches;
