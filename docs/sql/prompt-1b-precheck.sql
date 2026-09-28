-- Prompt 1B — READ-ONLY checks before running platform migrations p004–p006
-- on the platform database. Every statement is a SELECT: nothing is changed.
-- Run against the PLATFORM database (the one holding tenant_subscriptions).
-- Then: node src/scripts/run-platform-migrations.js --dry-run
--       node src/scripts/run-platform-migrations.js

-- 0. MySQL version. p006 adds a JSON column: needs MySQL 5.7.8 or later.
SELECT VERSION() AS mysql_version;

-- 1. Which platform migrations are already applied (expect 1, 2, 3 from Prompt 1A;
--    3 may be missing if duplicates were found — see the handoff).
SELECT version, name, applied_at FROM schema_migrations ORDER BY version;

-- 2. p004 (status + GRACE, ON_HOLD, PAUSED). Expected column type:
--    enum('ACTIVE','EXPIRED','CANCELLED','PENDING_MIGRATION','PENDING_CANCEL','SCHEDULED','REVOKED')
--    Anything else in the list means p004 will SKIP itself and list it.
SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_subscriptions' AND COLUMN_NAME = 'status';

--    Every status value in use. Expected: only values from the list above.
SELECT status, COUNT(*) AS n FROM tenant_subscriptions GROUP BY status ORDER BY status;

-- 3. p005 (currency) and p006 (pending_change). Expected: NO rows (columns not there yet).
--    If a row comes back with a different type (not char(3) / json), the migration
--    will SKIP itself and report it — look at what that column holds before going on.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_subscriptions'
  AND COLUMN_NAME IN ('currency', 'pending_change');

-- 4. Table size (ADD COLUMN rebuilds the table online; with a few thousand rows it takes seconds).
SELECT COUNT(*) AS rows_in_tenant_subscriptions FROM tenant_subscriptions;

-- 5. Behaviour check, not a migration blocker: tenants that will now read as
--    0 branches because their only plan rows are EXPIRED / REVOKED / ON_HOLD /
--    PAUSED (before Prompt 1B an EXPIRED-only tenant fell back to its
--    registration package). Review this list before deploying.
SELECT t.id, t.business_name, t.status AS tenant_status,
       GROUP_CONCAT(DISTINCT s.status ORDER BY s.status) AS plan_statuses
FROM tenants t
JOIN tenant_subscriptions s ON s.tenant_id = t.id
GROUP BY t.id, t.business_name, t.status
HAVING SUM(s.status IN ('ACTIVE', 'GRACE')) = 0
   AND SUM(s.status IN ('EXPIRED', 'REVOKED', 'ON_HOLD', 'PAUSED')) > 0
ORDER BY t.business_name;

-- 6. Pay-later applications submitted but not yet approved that already hold an
--    ACTIVE plan row from the old submission code (before BILL-13). Approval
--    will keep that row (it is not replaced by the 14-day grace). Review them.
SELECT t.id, t.business_name, t.status AS tenant_status, s.id AS subscription_id, s.status, s.end_date
FROM tenants t
JOIN tenant_subscriptions s ON s.tenant_id = t.id
WHERE t.payment_method = 'PAY_LATER'
  AND t.status IN ('PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED')
  AND s.platform = 'MANUAL';
