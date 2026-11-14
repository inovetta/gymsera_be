-- Launch wipe: inventory of the platform database. READ-ONLY. See docs/runbooks/launch-wipe.md.
--
-- Run it from the API folder (the one holding server.js and .env):
--   node src/scripts/run-sql-check.js docs/sql/launch-wipe-inventory.sql > <backup folder>\inventory-before.txt
-- Run it twice: before the backup (this list drives the dumps and the R2 clean-up) and right after the
-- restore drill against the scratch copy (paste the SELECTs into the mysql client there) to compare counts.
--
-- Database names come only from tenants.db_name (R-79). Every column printed here is structural
-- (ids, codes, states, counts): no names, e-mails or phone numbers.

-- 1. Every tenant: its id (the R2 folder name, a UUID), code, state and database name.
SELECT id, tenant_code, status, provisioning_state, db_name
FROM tenants
ORDER BY tenant_code;

-- 2. Tenants the wipe will NOT drop a database for (db_name is NULL). The owner decides each by hand.
SELECT id, tenant_code, status, provisioning_state
FROM tenants
WHERE db_name IS NULL OR db_name = ''
ORDER BY tenant_code;

-- 3. Databases on THIS MySQL server that no tenant names (orphans, staging copies, old scratch databases).
--    The wipe leaves every one of them in place. This lists only the server the platform database is on;
--    if TENANT_DB_HOST is another server, run the same SELECT there in the mysql client.
SELECT s.SCHEMA_NAME AS schema_name
FROM information_schema.SCHEMATA s
WHERE s.SCHEMA_NAME NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
  AND BINARY s.SCHEMA_NAME <> BINARY DATABASE()
  AND NOT EXISTS (SELECT 1 FROM tenants t WHERE BINARY t.db_name = BINARY s.SCHEMA_NAME)
ORDER BY s.SCHEMA_NAME;

-- 4. Platform admins (ids only; the dry run says which ones --keep-admin keeps).
SELECT id, role, status
FROM users
WHERE role = 'PLATFORM_ADMIN'
ORDER BY created_at;

-- 5. Exact row counts of the tables the restore drill compares.
SELECT 'users' AS tbl, COUNT(*) AS n FROM users
UNION ALL SELECT 'tenants', COUNT(*) FROM tenants
UNION ALL SELECT 'tenant_subscriptions', COUNT(*) FROM tenant_subscriptions
UNION ALL SELECT 'gym_listings', COUNT(*) FROM gym_listings
UNION ALL SELECT 'device_tokens', COUNT(*) FROM device_tokens
UNION ALL SELECT 'billing_plans', COUNT(*) FROM billing_plans
UNION ALL SELECT 'billing_plan_prices', COUNT(*) FROM billing_plan_prices
UNION ALL SELECT 'platform_packages', COUNT(*) FROM platform_packages
UNION ALL SELECT 'cities', COUNT(*) FROM cities
UNION ALL SELECT 'areas', COUNT(*) FROM areas
UNION ALL SELECT 'schema_migrations', COUNT(*) FROM schema_migrations;
