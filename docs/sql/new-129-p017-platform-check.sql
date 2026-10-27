-- NEW-129 — p017 on the PLATFORM database. READ-ONLY: SELECTs only, no personal data.
--   node src/scripts/run-sql-check.js docs/sql/new-129-p017-platform-check.sql
-- v17 recorded + tinyint(1)/YES = healthy; v17 missing + tinyint(1)/NO = same skip as CI;
-- v17 missing + no column row = p017 not run yet (grid 3 then errors with "Unknown column").

-- 1. Is p017 recorded? (16 and 18 shown for context)
SELECT version, name, applied_at
FROM schema_migrations
WHERE version BETWEEN 16 AND 18
ORDER BY version;

-- 2. The column as it is today (no row = column missing)
SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'tenant_subscriptions'
  AND COLUMN_NAME = 'duplicate_billing';

-- 3. Values in it. Run only if grid 2 returned a row (errors with "Unknown column" otherwise).
SELECT COUNT(*) AS total_rows,
       SUM(duplicate_billing IS NULL) AS null_rows,
       SUM(duplicate_billing = 1) AS flagged_rows
FROM tenant_subscriptions;
