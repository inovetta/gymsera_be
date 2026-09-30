-- Prompt 1E — READ-ONLY checks before running platform migrations p011–p012
-- and tenant migrations 011–012. Every statement is a SELECT: nothing is changed.
--
-- Deployment execution order:
-- 1. Run Section 1 against the PLATFORM database (gymsera)
--    Then: node src/scripts/run-platform-migrations.js --dry-run
--          node src/scripts/run-platform-migrations.js
-- 2. Run Section 2 against each TENANT database
--    Then: node src/scripts/run-tenant-migrations.js --dry-run
--          node src/scripts/run-tenant-migrations.js
-- Or run the automated script:
--    node gymsera-1e-precheck-all.js
--
-- What "safe to migrate" looks like:
-- MySQL version returns 5.7.8 or later.
-- Platform schema_migrations returns migrations 1 through 10 applied (p001 through p010).
-- Check 1 (p011): idempotency_records table is absent, OR if present, contains idempotency_key column.
-- Check 2 (p012): payment_details_updated_at column on tenants table is absent, OR if present, has type DATETIME/TIMESTAMP.
-- Baseline Query (p012): Lists tenants with existing bank details (payment_details_json) but no updated_at timestamp (informational).
-- Tenant schema_migrations returns migrations 1 through 10 applied (001 through 010).
-- Check 3 (011): idempotency_records table on tenant DB is absent, OR contains idempotency_key column.
-- Check 4 (012): payouts table on tenant DB is absent, OR contains amount column.

-- ============================================================================
-- SECTION 1: PLATFORM DATABASE CHECKS (run against `gymsera` platform DB)
-- ============================================================================

-- 0. MySQL version. Needs MySQL 5.7.8 or later.
SELECT VERSION() AS mysql_version;

-- 1. Which platform migrations are already applied.
--    Expected: migrations 1..10 applied (p001 through p010).
SELECT version, name, applied_at FROM schema_migrations ORDER BY version;

-- 2. Check for Platform Migration p011 (idempotency_records table).
--    Expected before migration: 0 rows (table does not exist yet).
--    If table exists, idempotency_key column must be present.
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idempotency_records';

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idempotency_records' AND COLUMN_NAME = 'idempotency_key';

-- 3. Check for Platform Migration p012 (tenants.payment_details_updated_at column).
--    Expected before migration: 0 rows (column does not exist yet).
--    If column exists, must be DATETIME or TIMESTAMP.
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'payment_details_updated_at';

-- 4. Baseline Query for p012 (INFORMATIONAL — not a migration blocker):
--    Tenants that currently have bank details configured, but no updated_at timestamp.
--    After p012, future bank detail updates will stamp payment_details_updated_at to enforce
--    the 24-hour payout cooling period (SEC-13). Existing rows remain NULL until updated.
SELECT id, tenant_code, business_name, payment_details_updated_at,
       CASE WHEN payment_details_json IS NOT NULL THEN 1 ELSE 0 END AS has_bank_details
FROM tenants
WHERE payment_details_json IS NOT NULL
  AND payment_details_updated_at IS NULL
ORDER BY tenant_code;

-- 5. Platform Table Size Baseline (online DDL timing estimate)
SELECT COUNT(*) AS total_tenants FROM tenants;


-- ============================================================================
-- SECTION 2: TENANT DATABASE CHECKS (run against each tenant database)
-- ============================================================================

-- 6. Tenant schema version (schema_migrations table on tenant DB).
--    Expected: versions 1..10 applied (001 through 010).
--    Versions 011 and 012 not yet applied.
SELECT version, name, applied_at FROM schema_migrations ORDER BY version;

-- 7. Check for Tenant Migration 011 (idempotency_records table).
--    Expected before migration: 0 rows (table does not exist yet).
--    If table exists, idempotency_key column must be present.
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idempotency_records';

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idempotency_records' AND COLUMN_NAME = 'idempotency_key';

-- 8. Check for Tenant Migration 012 (payouts table).
--    Expected before migration: 0 rows (table does not exist yet).
--    If table exists, amount column must be present.
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payouts';

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payouts' AND COLUMN_NAME = 'amount';

-- 9. Tenant Table Size Baselines (online DDL / activity baseline)
SELECT COUNT(*) AS total_payments FROM payments;
SELECT COUNT(*) AS total_ledger_days FROM ledger_days;
