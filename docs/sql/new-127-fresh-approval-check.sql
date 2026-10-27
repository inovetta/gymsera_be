-- NEW-127 — after a deploy: did a fresh approval build a complete tenant database? READ-ONLY.
--
-- 1. Approve a fresh test gym in the CMS (or the app).
-- 2. From the app folder that holds server.js and .env:
--      node src/scripts/run-sql-check.js docs/sql/new-127-fresh-approval-check.sql
-- It checks the gym approved most recently. To check another one, replace the first SET with
--   SET @tenant_code = 'GYM-XXXXXXXX';
-- SELECTs only, over `tenants` and information_schema, plus the gym's own schema_migrations.
--
-- PASS on today's code: grid 1 verdict PASS (status ACTIVE, provisioning_state ACTIVE,
-- 29 tables, schema_migrations 1, branches.currency 1, the four newest tables 4), and grid 2
-- 19 rows, lowest 1, highest 19. The build that made GYM-4814C134 (before 2026-09-26) gives
-- 24 tables, provisioning_state NULL, schema_migrations 0, newest tables 0, and grid 2 ends
-- with "Table ... schema_migrations doesn't exist": that is a FAIL, the server is running old code.

SET @tenant_code = (SELECT tenant_code FROM tenants
                    WHERE db_name IS NOT NULL AND approved_at IS NOT NULL
                    ORDER BY approved_at DESC LIMIT 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The gym and its database.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  x.tenant_code,
  x.approved_at,
  x.status,
  x.provisioning_state,
  x.provisioning_error,
  x.table_count,
  x.has_schema_migrations,
  x.has_branches_currency,
  x.newest_tables,
  CASE WHEN x.status = 'ACTIVE' AND x.provisioning_state = 'ACTIVE' AND x.has_schema_migrations = 1
            AND x.has_branches_currency = 1 AND x.newest_tables = 4 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (
  SELECT
    t.tenant_code,
    t.approved_at,
    t.status,
    t.provisioning_state,
    t.provisioning_error,
    (SELECT COUNT(*) FROM information_schema.TABLES i WHERE i.TABLE_SCHEMA = t.db_name) AS table_count,
    (SELECT COUNT(*) FROM information_schema.TABLES i
       WHERE i.TABLE_SCHEMA = t.db_name AND i.TABLE_NAME = 'schema_migrations') AS has_schema_migrations,
    (SELECT COUNT(*) FROM information_schema.COLUMNS c
       WHERE c.TABLE_SCHEMA = t.db_name AND c.TABLE_NAME = 'branches' AND c.COLUMN_NAME = 'currency') AS has_branches_currency,
    -- Tables only code from 2026-09-28 on creates (capacity_outbox, idempotency_records, payouts, invoice_sequences).
    (SELECT COUNT(*) FROM information_schema.TABLES i
       WHERE i.TABLE_SCHEMA = t.db_name
         AND i.TABLE_NAME IN ('capacity_outbox', 'idempotency_records', 'payouts', 'invoice_sequences')) AS newest_tables
  FROM tenants t
  WHERE t.tenant_code = @tenant_code
) x;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Its recorded tenant migrations (expect 19 rows, 1 to 19).
-- ─────────────────────────────────────────────────────────────────────────────
SET @versions_sql = CONCAT(
  'SELECT COUNT(*) AS recorded, MIN(version) AS lowest, MAX(version) AS highest FROM `',
  (SELECT db_name FROM tenants WHERE tenant_code = @tenant_code),
  '`.schema_migrations'
);
PREPARE versions FROM @versions_sql;
EXECUTE versions;
DEALLOCATE PREPARE versions;
